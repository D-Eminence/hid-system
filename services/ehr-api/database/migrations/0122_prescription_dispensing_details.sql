-- 0122 Prescription strength, form, duration, quantity and priority for the
-- pharmacy (owner decision 25 of 2026-11-01, D-Eminence: "all recommended
-- except D5", on the Akos handover backend plan, items 3b and 4; D6: no drug
-- picture until the price list; D9: the quantity to dispense is the
-- prescriber's suggestion, the pharmacist still confirms it and the server
-- does not compare the two). The declaration is signed separately.
-- Written as 0114 on 0113 (the own-work patient cards, now 0121) over 0103
-- (34d69557); released as 0122, after 0121. It does not use or need anything
-- 0104-0121 add, so it applies on 0103 alone or on 0103 + any of them.
--
-- The gap: ehr.prescriptions (0004) records the medicine, dose, route,
-- frequency, instructions and dates, but not the strength and form the
-- prescriber meant ("500 mg capsule"), how long it is for ("7 days"), how
-- much to hand over, or how urgent it is. The pharmacy queue therefore
-- guesses the form and strength from the medicine's name, cannot pre-fill the
-- dispensing, and cannot put urgent prescriptions first.
--
-- The change:
-- D1 Seven nullable columns on ehr.prescriptions, with no default (no table
--    rewrite; every existing row reads null): priority, medication_strength,
--    medication_dose_form, duration_value, duration_unit,
--    quantity_to_dispense numeric(12,4) and quantity_unit. The EHR API sets
--    them only when it creates a prescription (its update and every other
--    writer leave them as they are).
-- D2 One CHECK, prescriptions_dispensing_details_ck, added NOT VALID and then
--    validated: priority one of routine, urgent, asap, stat (the Lab
--    priorities); medication_strength and quantity_unit not blank and at
--    most 80 characters; medication_dose_form one of tablet, capsule,
--    liquid, injection, cream, inhaler, drops, other; duration_value 1-3650
--    and duration_unit one of day, week, month, given together or not at
--    all; quantity_to_dispense above 0 and quantity_unit given together or
--    not at all. One CHECK rather than one per rule, because each VALIDATE
--    CONSTRAINT scans the whole table under the lock (see Locks); the EHR API
--    checks each rule by name before it writes. Every existing row is null in
--    all seven, so the validation cannot fail.
-- D3 Nothing is copied into pharmacy.work_items, which stays insert-only and
--    unchanged: pharmacy.validate_work_item (0100) and
--    pharmacy.validate_dispensing (0101) keep their bodies and their field
--    comparisons, and a caller of pharmacy-api can neither supply nor forge
--    the new values.
-- D4 pharmacy.work_item_prescription_details(uuid[]) answers, for each of the
--    given work items that is this facility's own work and that the session
--    may read, the seven values of the prescription version that Pharmacy
--    accepted: they are read from that version's immutable snapshot,
--    ehr.record_versions.resulting_state at (resource_type 'prescriptions',
--    resource_id the prescription id as text, version_no the accepted
--    version), which ehr.capture_record_version (0004) writes on every
--    insert and update of the prescription. The values therefore stay those
--    of the accepted version after the prescription later changes. The
--    snapshot must also name the work item's patient, facility and
--    encounter. A prescription written before 0122 answers seven nulls; a
--    work item without a snapshot answers no row.
-- D5 A row needs all of: own work (order_route_id is null;
--    work_items_route_facility_ck then makes its facility the ordering
--    facility); its facility is the session's (platform.current_facility_id());
--    the session's member holds pharmacy.work-item.read at that facility
--    (auth.membership_has_permission, checked once per call); and the read
--    consent test of the work items' read policy,
--    identity.has_active_consent_grant(patient, subject, membership,
--    facility, 'read_records', the session's purpose of use), the own-row
--    branch of pharmacy.work_item_allows (0086 H8). Emergency sessions with
--    an active break-glass grant are included, as their work row is shown
--    (decision 25, D8). Route-backed work answers no row (its details would
--    come from the sending facility's route: item 4b, later).
-- D6 The snapshot path, not a read of the live ehr.prescriptions row: the
--    snapshot table's only read policy, record_versions_read, is
--    ehr.context_allows(patient_id, facility_id, 'read_records'), the same
--    facility-and-consent test as D5 for an own row (whose prescription is at
--    the work item's facility, 0100). So an owner that does not bypass
--    row-level security (production) sees the snapshot exactly when D5
--    admits the row (proved by the suite on such an owner); an owner that
--    bypasses it is held to D5's predicate alone, which is the same rule.
--    The work item's keys are turned into text inside a materialized CTE
--    before the join, so the join compares text with text (texteq is
--    leakproof) and uses the snapshot key (resource_type, resource_id,
--    version_no) under the forced read policy: the policy then runs once per
--    work item. A join on source_ehr_prescription_id::text (uuid_out is not
--    leakproof) cannot be an index condition below the policy, which then
--    ran on every prescription snapshot of the item's patient or facility
--    (measured: 4,000 policy calls for 200 items whose patients had 20
--    snapshots each, against 200; see Cost).
-- D7 At most 200 ids (the work list answers 200 rows): a null list or more
--    than 200 elements raises 22023 WORK_ITEM_PRESCRIPTION_DETAILS_INVALID.
--    An empty list answers nothing. SECURITY DEFINER, STABLE, plpgsql, not
--    STRICT, search_path pg_catalog, pg_temp with every name
--    schema-qualified, owned by pharmacy.work_items' owner (the applier, or,
--    if the applier is a member, given to that owner).
-- D8 Grants, here and in runtime-grants.sql: EXECUTE to hid_pharmacy_runtime
--    and hid_schema_test_runtime (when the roles exist; the API login
--    inherits it); revoked from PUBLIC; nothing to any other runtime. The
--    EHR runtime's table privileges on ehr.prescriptions are table-wide
--    (SELECT, INSERT, UPDATE), so they cover the new columns with no grant.
-- D9 No migration number appears inside the function body or a CHECK, so a
--    renumber changes only this file's name, header, messages, comments and
--    the ledgers.
-- What the services do with it, each behind its own setting
-- PRESCRIPTION_DISPENSING_DETAILS_ENABLED, off by default (off is exactly
-- today): the EHR API accepts the seven values as optional, create-only
-- fields of POST .../prescriptions (pairs enforced), echoes them when set
-- and says so on its prescription list (dispensingDetails: true);
-- pharmacy-api reads D4 in a savepoint for the own rows it answers and adds
-- priority, medication.strength, medication.doseForm, duration (else the
-- whole days from the work item's own start date to its end date, when both
-- are set), quantityToDispense and quantityUnit to them. Neither writes a new
-- audit row: no new person is shown.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501
--    and nothing is applied): 0001-0103 applied (0103's
--    identity.organization_application_admin_account body the marker, and
--    the tables used); not applied yet (the function does not exist); none of
--    the seven columns or the CHECK name exists on ehr.prescriptions; the
--    bodies relied on are the ones 0001-0103 left (md5 of pg_proc.prosrc):
--    the snapshot writer and its trigger, the consent test and the
--    membership and permission checks the body calls, the four session
--    readers, pharmacy.work_item_allows (its attributes and search_path too:
--    its body is byte-identical to Lab's) and the route branch it calls,
--    ehr.context_allows (the snapshot read policy), and the bodies that read
--    ehr.prescriptions through %ROWTYPE or fire on it and that this file
--    leaves untouched: pharmacy.validate_work_item (0100),
--    pharmacy.validate_dispensing (0101), ehr.send_order_route (0098) and
--    ehr.sync_order_routes_on_order_change (0086); the three triggers on
--    ehr.prescriptions; the read policies of pharmacy.work_items and
--    ehr.record_versions (the only ones a SELECT applies), the own-row CHECK
--    work_items_route_facility_ck, record_versions' one-snapshot-per-version
--    key, forced row-level security on both; the types and NOT NULLs of the
--    columns read; the applying role is ehr.prescriptions' owner (to alter
--    it) and pharmacy.work_items' owner (to own the function), or a member of
--    each that inherits it and may SET ROLE to it, and may create in schema
--    pharmacy; that function owner may create in and use pharmacy, use ehr,
--    identity, auth and platform, read pharmacy.work_items and
--    ehr.record_versions, and execute every function the body and the two
--    read policies call (ownership, membership or grant, never a superuser's
--    bypass).
-- 1. The function and its comment; given to pharmacy.work_items' owner when
--    the applier is only a member of it.
-- 2. Grants (D8).
-- 3. Post-checks of the function: it exists once with this file's body
--    (md5), that owner, SECURITY DEFINER, STABLE, plpgsql, not STRICT, this
--    search_path, one uuid[] argument and the eight result columns; its ACL
--    holds only its owner and section 2's grantees.
-- 4. Last, under one ACCESS EXCLUSIVE lock on ehr.prescriptions taken NOWAIT
--    (see Locks): the seven columns and their comments, the CHECK NOT VALID,
--    then validated.
-- 5. Post-checks of the table: the seven columns with their types, nullable
--    and without default; the CHECK validated with this definition;
--    the three triggers, row-level security and the 0100, 0101, 0098 and
--    0086 bodies as before.
--
-- Locks (measured with pg_locks before commit on a 0113 copy, as 0114): ACCESS
-- EXCLUSIVE on ehr.prescriptions, held to commit (and SHARE UPDATE EXCLUSIVE,
-- VALIDATE's, inside it); ACCESS SHARE on the schema pharmacy, the language
-- plpgsql and the two granted roles; SHARE UPDATE EXCLUSIVE on the new
-- function (its comment); ACCESS EXCLUSIVE on the session's own temporary
-- schema (section 0's helper); the catalogs' own locks. No lock on
-- pharmacy.work_items, ehr.record_versions or any other application table is
-- held to commit: section 0 opens those two for a moment (pg_get_expr of
-- their policies and CHECK), and a plpgsql body is not planned at CREATE. So
-- behind a session holding ACCESS EXCLUSIVE on either of them (DDL) the
-- runner stops after its 5 s lock_timeout with nothing applied (5.2 s
-- measured), and behind ROW EXCLUSIVE on either (rows being written), or
-- even ACCESS EXCLUSIVE on identity.patients, it applied at once.
-- Section 4 takes the table lock NOWAIT, as 0088 section 6 does: a busy table
-- fails the attempt at once, its subtransaction releases what it took, and
-- the loop tries again 100 ms later, so the migration never waits while
-- holding it and no request queues behind a waiting lock; after 50 attempts
-- (5 seconds) it stops the release with nothing applied (55P03). An open
-- Pharmacy acceptance or dispensing holds its prescription FOR SHARE (0100,
-- 0101: ROW SHARE on the table), and any open transaction that read
-- ehr.prescriptions holds ACCESS SHARE on it; behind either the migration
-- waits and fails, it never blocks them (measured: behind an acceptance held
-- open through pharmacy-api's runtime and INSERT, the runner's dry run
-- stopped after 5.2 s with this file's 55P03 message and 0122 still pending,
-- while a read of ehr.prescriptions from another session took 70 ms).
-- Once taken, the lock lasts to commit: every pending migration runs in one
-- transaction (the runner's dry run, all files, then rollback; its apply,
-- one transaction per file), so ADD COLUMN's ACCESS EXCLUSIVE is still held
-- while VALIDATE CONSTRAINT scans the table. NOT VALID then VALIDATE
-- therefore does not shorten the lock here; it is kept because it is the
-- rule for CHECKs on existing tables, and the rules are one CHECK so that
-- the table is scanned once (each VALIDATE scans it on its own). ADD COLUMN
-- with the NOT VALID CHECK took 2-8 ms; the one scan took 73 ms for 200,000
-- rows and 0.48 s for 1,000,000 (nine CHECKs, one scan each, took 0.43 s and
-- 3.05 s on the same synthetic tables; a shared 4-CPU machine), linear in the
-- table's size. EHR prescription reads and writes and Pharmacy acceptances
-- and dispensings wait for that long only.
--
-- Cost (pharmacy-api calls D4 once per work-list load for its own rows, at
-- most 200, while PRESCRIPTION_DISPENSING_DETAILS_ENABLED is on): under a
-- NOSUPERUSER NOBYPASSRLS owner, as in production, each item pays the work
-- items' read policy, the consent test and the snapshot read policy once:
-- 1.0-1.7 s for 200 items, against 0.4-0.7 s for reading the same rows
-- under row-level security, whatever the prescription history (measured
-- with 1, 5, 20 and 50 snapshots per patient, and with 300,000 other
-- snapshots at the facility; fictional data, a shared 4-CPU machine). The
-- join on uuid::text it replaced took 3.5 s with 5 and 8.8 s with 20
-- snapshots per patient, and more than pharmacy-api's 15 s statement
-- timeout with 1 per patient beside 100,000 other prescription snapshots.
--
-- Old services on this schema: every writer and reader of ehr.prescriptions
-- names its columns (the EHR API, the chat evidence query, the demo story),
-- and the 0100, 0101 and 0098 bodies read the row into ehr.prescriptions%ROWTYPE,
-- which PostgreSQL re-resolves after ADD COLUMN, also in a pooled connection
-- that ran them before (proved), so today's EHR API, pharmacy-api, Lab and
-- website answer exactly as before; so do the new images while
-- PRESCRIPTION_DISPENSING_DETAILS_ENABLED is off. New prescriptions'
-- snapshots carry the seven keys (null when not given). Applied migrations
-- 0001 through 0121 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0097's, 0099's and 0100's helper).
create function pg_temp.prescription_details_0122_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  prescriptions_owner oid;
  work_items_owner oid;
begin
  -- a. Prerequisites (0001-0103; 0103's gate body is the marker).
  if to_regprocedure('identity.organization_application_admin_account(text)') is null
     or (select md5(proc.prosrc) from pg_proc proc
          where proc.oid = to_regprocedure('identity.organization_application_admin_account(text)'))
        is distinct from '186eb4ca420749b8bdb324bdc843bc50'
     or to_regclass('ehr.prescriptions') is null
     or to_regclass('ehr.record_versions') is null
     or to_regclass('pharmacy.work_items') is null then
    raise exception using errcode = '55000', message = '0122: 0001-0103 must be applied first';
  end if;
  -- b. Not applied yet, and nothing in the way.
  if exists (select 1 from pg_proc proc
              where proc.proname = 'work_item_prescription_details' and proc.pronamespace = 'pharmacy'::regnamespace) then
    raise exception using errcode = '55000', message = '0122: already applied';
  end if;
  select string_agg(existing.name, ', ') into mismatch
    from (
      select attribute_row.attname::text as name from pg_attribute attribute_row
       where attribute_row.attrelid = 'ehr.prescriptions'::regclass and not attribute_row.attisdropped
         and attribute_row.attname in ('priority', 'medication_strength', 'medication_dose_form', 'duration_value',
               'duration_unit', 'quantity_to_dispense', 'quantity_unit')
      union all
      select constraint_row.conname::text from pg_constraint constraint_row
       where constraint_row.conrelid = 'ehr.prescriptions'::regclass
         and constraint_row.conname = 'prescriptions_dispensing_details_ck') existing;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0122: ehr.prescriptions already has a column or CHECK this migration adds: %s', mismatch);
  end if;
  -- c. The bodies relied on, as 0001-0103 left them: the snapshot writer
  -- (0004), the consent test (0012), the membership (0008) and permission
  -- (0010) checks, the four session readers (0001), the Pharmacy work items'
  -- read-policy function (0086 H8) and its route branch (0086 H7), the
  -- snapshot read policy's function (0005), and the four bodies that read
  -- ehr.prescriptions into its row type or fire on it, left untouched here
  -- (0100, 0101, 0098, 0086).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('ehr.capture_record_version()', '70daa16f05bb3ec28f05292e6358a702'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '8b12ce866ee75cce411a2721795ffb92'),
      ('identity.has_active_membership(text,uuid,uuid)', 'bb52953ef1cd08527db61230a671859e'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', 'b710e0c6b66ce87c8c4a059ad435b774'),
      ('ehr.order_route_allows(uuid,uuid,text)', 'b80c2df6c380f7c7e20d166da94e56d2'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('pharmacy.validate_work_item()', 'e2411539ee8c95a02dad46c03e24db05'),
      ('pharmacy.validate_dispensing()', '17f7e8897bd2ab240332e4d2c9f757b7'),
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', '4202ba3bbf02abd7db34606d42adca9c'),
      ('ehr.sync_order_routes_on_order_change()', '8ce6b42450cc06fc02fec8d1cf63af41'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  -- Lab's and Pharmacy's work_item_allows have the same text; the search_path
  -- tells them apart. The snapshot writer and the two guards are SECURITY
  -- DEFINER plpgsql triggers; the others are SECURITY DEFINER SQL checks.
  if mismatch is null then
    select string_agg(expected.proc, '; ') into mismatch
      from (values
        ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', 'sql', 's', 'boolean',
         '{"search_path=pharmacy, identity, platform, pg_temp"}'),
        ('ehr.context_allows(uuid,uuid,text)', 'sql', 's', 'boolean', '{"search_path=ehr, identity, platform, pg_temp"}'),
        ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', 'sql', 's', 'boolean',
         '{"search_path=identity, auth, pg_temp"}'),
        ('identity.has_active_membership(text,uuid,uuid)', 'sql', 's', 'boolean', '{"search_path=identity, auth, pg_temp"}'),
        ('auth.membership_has_permission(text,uuid,uuid,text)', 'sql', 's', 'boolean',
         '{"search_path=auth, identity, pg_temp"}'),
        ('ehr.capture_record_version()', 'plpgsql', 'v', 'trigger', '{"search_path=ehr, auth, identity, platform, pg_temp"}'),
        ('pharmacy.validate_work_item()', 'plpgsql', 'v', 'trigger', '{"search_path=pharmacy, platform, pg_temp"}'),
        ('pharmacy.validate_dispensing()', 'plpgsql', 'v', 'trigger', '{"search_path=pharmacy, platform, pg_temp"}'))
           expected(proc, language_name, volatility, result_type, config)
     where not exists (select 1 from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                        where proc.oid = to_regprocedure(expected.proc)
                          and language_row.lanname = expected.language_name and proc.prosecdef
                          and proc.provolatile = expected.volatility and not proc.proisstrict
                          and proc.prorettype = expected.result_type::regtype
                          and proc.proconfig = expected.config::text[]);
    if mismatch is not null then mismatch := 'attributes of ' || mismatch; end if;
  end if;
  -- The three triggers on ehr.prescriptions (0004, 0086), enabled, and no
  -- other: the snapshot is written by prescriptions_versioned.
  if mismatch is null
     and ((select count(*) from pg_trigger trigger_row
            where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and not trigger_row.tgisinternal
              and trigger_row.tgenabled = 'O'
              and pg_get_triggerdef(trigger_row.oid) in (
                'CREATE TRIGGER prescriptions_versioned BEFORE INSERT OR UPDATE ON ehr.prescriptions '
                  || 'FOR EACH ROW EXECUTE FUNCTION ehr.capture_record_version()',
                'CREATE TRIGGER prescriptions_no_delete BEFORE DELETE ON ehr.prescriptions '
                  || 'FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()',
                'CREATE TRIGGER prescriptions_order_routes_sync AFTER UPDATE ON ehr.prescriptions '
                  || 'FOR EACH ROW EXECUTE FUNCTION ehr.sync_order_routes_on_order_change()')) <> 3
       or (select count(*) from pg_trigger trigger_row
            where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and not trigger_row.tgisinternal) <> 3) then
    mismatch := 'the triggers on ehr.prescriptions';
  end if;
  -- The read policies a SELECT of the two tables read applies (0086, 0005),
  -- and only those; the own-row CHECK (0086); one snapshot per version
  -- (0004); row-level security forced on both.
  if mismatch is null
     and ((select count(*) from pg_policy policy_row
            where policy_row.polpermissive and policy_row.polroles = '{0}'::oid[] and policy_row.polcmd = 'r'
              and ((policy_row.polrelid = 'pharmacy.work_items'::regclass
                    and policy_row.polname = 'pharmacy_work_items_read'
                    and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                      = 'pharmacy.work_item_allows(patient_id, facility_id, order_route_id, ''read_records''::text)')
                or (policy_row.polrelid = 'ehr.record_versions'::regclass
                    and policy_row.polname = 'record_versions_read'
                    and pg_get_expr(policy_row.polqual, policy_row.polrelid)
                      = 'ehr.context_allows(patient_id, facility_id, ''read_records''::text)')))
          <> 2
       or exists (select 1 from pg_policy policy_row
                   where policy_row.polrelid in ('pharmacy.work_items'::regclass, 'ehr.record_versions'::regclass)
                     and policy_row.polcmd in ('r', '*')
                     and (policy_row.polrelid, policy_row.polname) not in
                           (('pharmacy.work_items'::regclass, 'pharmacy_work_items_read'::name),
                            ('ehr.record_versions'::regclass, 'record_versions_read'::name)))) then
    mismatch := 'the pharmacy.work_items and ehr.record_versions read policies';
  end if;
  if mismatch is null
     and (select count(*) from pg_constraint constraint_row
           where (constraint_row.conrelid = 'pharmacy.work_items'::regclass and constraint_row.contype = 'c'
                  and constraint_row.convalidated and constraint_row.conname = 'work_items_route_facility_ck'
                  and pg_get_constraintdef(constraint_row.oid) =
                    'CHECK ((((order_route_id IS NULL) AND (facility_id = ordering_facility_id)) OR '
                    || '((order_route_id IS NOT NULL) AND (facility_id <> ordering_facility_id))))')
              or (constraint_row.conrelid = 'ehr.record_versions'::regclass and constraint_row.contype = 'u'
                  and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (resource_type, resource_id, version_no)'))
         <> 2 then
    mismatch := 'the CHECK work_items_route_facility_ck of pharmacy.work_items or the snapshot key of ehr.record_versions';
  end if;
  if mismatch is null
     and (select count(*) from pg_class relation
           where relation.oid in ('pharmacy.work_items'::regclass, 'ehr.record_versions'::regclass)
             and relation.relrowsecurity and relation.relforcerowsecurity) <> 2 then
    mismatch := 'row-level security on pharmacy.work_items or ehr.record_versions (on, forced)';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0122: an object this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- d. The columns read.
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('pharmacy.work_items', 'id', 'uuid', true),
      ('pharmacy.work_items', 'patient_id', 'uuid', true),
      ('pharmacy.work_items', 'facility_id', 'uuid', true),
      ('pharmacy.work_items', 'order_route_id', 'uuid', false),
      ('pharmacy.work_items', 'source_ehr_prescription_id', 'uuid', true),
      ('pharmacy.work_items', 'source_ehr_prescription_version', 'bigint', true),
      ('pharmacy.work_items', 'source_encounter_id', 'uuid', true),
      ('ehr.record_versions', 'resource_type', 'text', true),
      ('ehr.record_versions', 'resource_id', 'text', true),
      ('ehr.record_versions', 'version_no', 'bigint', true),
      ('ehr.record_versions', 'patient_id', 'uuid', true),
      ('ehr.record_versions', 'facility_id', 'uuid', true),
      ('ehr.record_versions', 'resulting_state', 'jsonb', true),
      ('ehr.prescriptions', 'id', 'uuid', true),
      ('ehr.prescriptions', 'encounter_id', 'uuid', true),
      ('ehr.prescriptions', 'patient_id', 'uuid', true),
      ('ehr.prescriptions', 'facility_id', 'uuid', true),
      ('ehr.prescriptions', 'row_version', 'bigint', true))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0122: a column this migration relies on differs from 0001-0103: %s', mismatch);
  end if;
  -- e. Ownership and privileges, never through a superuser's bypass
  -- (production's migrator has none). The applier alters
  -- ehr.prescriptions as its owner; the new function will belong to
  -- pharmacy.work_items' owner.
  prescriptions_owner := (select relation.relowner from pg_class relation
                           where relation.oid = 'ehr.prescriptions'::regclass);
  work_items_owner := (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(owner_row.owner))
             as what
        from (select prescriptions_owner as owner union select work_items_owner) owner_row
       where applier <> owner_row.owner
         and not (pg_has_role(applier, owner_row.owner, 'USAGE') and pg_has_role(applier, owner_row.owner, 'SET'))
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(wanted.holder), wanted.privilege, namespace.nspname)
        from (values (applier, 'pharmacy', 'CREATE'),
                     (work_items_owner, 'pharmacy', 'CREATE'), (work_items_owner, 'pharmacy', 'USAGE'),
                     (work_items_owner, 'ehr', 'USAGE'), (work_items_owner, 'identity', 'USAGE'),
                     (work_items_owner, 'auth', 'USAGE'), (work_items_owner, 'platform', 'USAGE'))
               wanted(holder, schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.prescription_details_0122_holds(wanted.holder, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks SELECT on %s', pg_get_userbyid(work_items_owner), relation.oid::regclass)
        from pg_class relation
       where relation.oid in ('pharmacy.work_items'::regclass, 'ehr.record_versions'::regclass)
         and not pg_temp.prescription_details_0122_holds(work_items_owner, relation.relowner, relation.relacl, 'r',
               'SELECT')
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(work_items_owner), proc.oid::regprocedure)
        from (values ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'),
                     ('auth.membership_has_permission(text,uuid,uuid,text)'),
                     ('platform.current_actor_subject()'), ('platform.current_facility_id()'),
                     ('platform.current_membership_id()'), ('platform.current_purpose_of_use()'),
                     ('pharmacy.work_item_allows(uuid,uuid,uuid,text)'),
                     ('ehr.context_allows(uuid,uuid,text)')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.prescription_details_0122_holds(work_items_owner, proc.proowner, proc.proacl, 'f',
               'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0122: missing privileges: %s', mismatch);
  end if;
  raise notice '0122: owners checked: ehr.prescriptions=%, pharmacy.work_items=%, ehr.record_versions=%, applier=%',
    pg_get_userbyid(prescriptions_owner), pg_get_userbyid(work_items_owner),
    (select pg_get_userbyid(relation.relowner) from pg_class relation where relation.oid = 'ehr.record_versions'::regclass),
    current_user;
end
$$;

-- 1. The function (D4-D7).
create function pharmacy.work_item_prescription_details(requested_work_item_ids uuid[])
returns table (
  work_item_id uuid,
  priority text,
  medication_strength text,
  medication_dose_form text,
  duration_value integer,
  duration_unit text,
  quantity_to_dispense numeric,
  quantity_unit text
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
    raise exception using errcode = '22023', message = 'WORK_ITEM_PRESCRIPTION_DETAILS_INVALID';
  end if;
  if session_facility is null
     or not coalesce(auth.membership_has_permission(platform.current_actor_subject(),
          platform.current_membership_id(), session_facility, 'pharmacy.work-item.read'), false) then
    return;
  end if;
  -- The work item's keys are turned into text inside a materialized CTE, so
  -- the snapshot join compares text with text (texteq is leakproof) and can
  -- use record_versions' snapshot key under its forced read policy; a join on
  -- item.source_ehr_prescription_id::text (uuid_out, not leakproof) could
  -- not, and made the policy run on every prescription snapshot of the
  -- facility or of the item's patient.
  return query
    with own as materialized (
      select item.id, item.patient_id, item.facility_id,
             item.source_ehr_prescription_id::text as prescription_key,
             item.source_ehr_prescription_version as prescription_version,
             item.source_encounter_id::text as encounter_key
        from pharmacy.work_items item
       where item.id = any(requested_work_item_ids)
         and item.order_route_id is null
         and item.facility_id = session_facility
         and identity.has_active_consent_grant(item.patient_id, platform.current_actor_subject(),
               platform.current_membership_id(), item.facility_id, 'read_records', platform.current_purpose_of_use()))
    select own.id,
           snapshot.resulting_state ->> 'priority',
           snapshot.resulting_state ->> 'medication_strength',
           snapshot.resulting_state ->> 'medication_dose_form',
           (snapshot.resulting_state ->> 'duration_value')::integer,
           snapshot.resulting_state ->> 'duration_unit',
           (snapshot.resulting_state ->> 'quantity_to_dispense')::numeric,
           snapshot.resulting_state ->> 'quantity_unit'
      from own
      join ehr.record_versions snapshot
        on snapshot.resource_type = 'prescriptions'
       and snapshot.resource_id = own.prescription_key
       and snapshot.version_no = own.prescription_version
       and snapshot.patient_id = own.patient_id
       and snapshot.facility_id = own.facility_id
       and snapshot.resulting_state ->> 'encounter_id' = own.encounter_key
     order by own.id;
end;
$$;

comment on function pharmacy.work_item_prescription_details(uuid[]) is
  'The priority, strength, dose form, duration and quantity to dispense of the prescription version Pharmacy accepted (its ehr.record_versions snapshot), for each given work item that is this facility''s own work (no order route) and that the session''s member may read: pharmacy.work-item.read here and the read consent test of the work items'' read policy (emergency included). At most 200 ids.';

-- pharmacy.work_items' owner owns it (a no-op when the applier is that owner,
-- as on every database built by one migration login).
do $$
declare
  work_items_owner oid := (select relation.relowner from pg_class relation
                            where relation.oid = 'pharmacy.work_items'::regclass);
begin
  if (select proc.proowner from pg_proc proc
       where proc.oid = 'pharmacy.work_item_prescription_details(uuid[])'::regprocedure) <> work_items_owner then
    execute format('alter function pharmacy.work_item_prescription_details(uuid[]) owner to %I',
      pg_get_userbyid(work_items_owner));
  end if;
end
$$;

-- 2. Grants (here and in runtime-grants.sql).
revoke all on function pharmacy.work_item_prescription_details(uuid[]) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant execute on function pharmacy.work_item_prescription_details(uuid[]) to hid_pharmacy_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function pharmacy.work_item_prescription_details(uuid[]) to hid_schema_test_runtime;
  end if;
end
$$;

-- 3. Post-checks of the function (after the grants, so the ACL is the final one).
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: md5=%s owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s '
           || 'arguments=%s columns=%s', proc.oid::regprocedure, md5(proc.prosrc), pg_get_userbyid(proc.proowner),
           proc.prosecdef, proc.provolatile, language_row.lanname, proc.proisstrict, proc.proconfig,
           proc.prorettype::regtype, proc.proargtypes::regtype[], proc.proallargtypes::regtype[]), '; ')
    into mismatch
    from pg_proc proc
    join pg_language language_row on language_row.oid = proc.prolang
   where proc.oid = 'pharmacy.work_item_prescription_details(uuid[])'::regprocedure
     and (md5(proc.prosrc) <> 'e6013d732354a56794ad8ec7f2bbaf0c'
      or proc.proowner <> (select relation.relowner from pg_class relation where relation.oid = 'pharmacy.work_items'::regclass)
      or not proc.prosecdef or proc.provolatile <> 's' or language_row.lanname <> 'plpgsql' or proc.proisstrict
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
      or proc.prorettype <> 'record'::regtype or not proc.proretset or proc.pronargs <> 1
      or proc.proargtypes[0] <> 'uuid[]'::regtype
      or proc.proallargtypes is distinct from
           array['uuid[]', 'uuid', 'text', 'text', 'text', 'integer', 'text', 'numeric', 'text']::regtype[]::oid[]
      or proc.proargmodes is distinct from '{i,t,t,t,t,t,t,t,t}'::"char"[]
      or proc.proargnames is distinct from array['requested_work_item_ids', 'work_item_id', 'priority',
           'medication_strength', 'medication_dose_form', 'duration_value', 'duration_unit', 'quantity_to_dispense',
           'quantity_unit']);
  if mismatch is not null
     or (select count(*) from pg_proc proc
          where proc.proname = 'work_item_prescription_details' and proc.pronamespace = 'pharmacy'::regnamespace) <> 1 then
    raise exception using errcode = '55000',
      message = format('0122: the function is not as this file makes it: %s', coalesce(mismatch, 'count'));
  end if;
  select string_agg(granted.what, '; ') into mismatch
    from (
      select format('%s %s', case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end,
               acl.privilege_type) as what
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.oid = 'pharmacy.work_item_prescription_details(uuid[])'::regprocedure
         and acl.grantee <> proc.proowner
         and (acl.grantee = 0 or acl.privilege_type <> 'EXECUTE'
           or pg_get_userbyid(acl.grantee) not in ('hid_pharmacy_runtime', 'hid_schema_test_runtime'))
      union all
      select format('missing %s EXECUTE', role_row.rolname)
        from pg_roles role_row
       where role_row.rolname in ('hid_pharmacy_runtime', 'hid_schema_test_runtime')
         and not exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
                          where proc.oid = 'pharmacy.work_item_prescription_details(uuid[])'::regprocedure
                            and acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0122: the function''s ACL is not section 2''s: %s', mismatch);
  end if;
end
$$;

-- 4. Last, under one ACCESS EXCLUSIVE lock on ehr.prescriptions taken NOWAIT
-- (see Locks): the columns (D1) and the CHECK (D2), NOT VALID, then
-- validated.
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table ehr.prescriptions in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0122: ehr.prescriptions stayed busy for 5 seconds; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$$;

alter table ehr.prescriptions
  add column priority text,
  add column medication_strength text,
  add column medication_dose_form text,
  add column duration_value integer,
  add column duration_unit text,
  add column quantity_to_dispense numeric(12,4),
  add column quantity_unit text,
  add constraint prescriptions_dispensing_details_ck check (
    (priority is null or priority in ('routine', 'urgent', 'asap', 'stat'))
    and (medication_strength is null
      or (length(medication_strength) <= 80 and length(btrim(medication_strength)) >= 1))
    and (medication_dose_form is null or medication_dose_form in ('tablet', 'capsule', 'liquid', 'injection', 'cream',
      'inhaler', 'drops', 'other'))
    and ((duration_value is null) = (duration_unit is null))
    and (duration_value is null or duration_value between 1 and 3650)
    and (duration_unit is null or duration_unit in ('day', 'week', 'month'))
    and ((quantity_to_dispense is null) = (quantity_unit is null))
    and (quantity_to_dispense is null or quantity_to_dispense > 0)
    and (quantity_unit is null or (length(quantity_unit) <= 80 and length(btrim(quantity_unit)) >= 1))) not valid;

-- One CHECK, so one validation scan of the table (each VALIDATE CONSTRAINT
-- scans it on its own, under the lock taken above).
alter table ehr.prescriptions validate constraint prescriptions_dispensing_details_ck;

comment on column ehr.prescriptions.priority is
  'How urgent the prescriber says it is: routine, urgent, asap or stat. Set at creation only; null when not given.';
comment on column ehr.prescriptions.medication_strength is
  'The strength as the prescriber wrote it (for example 500 mg). Set at creation only; null when not given.';
comment on column ehr.prescriptions.medication_dose_form is
  'The form the prescriber chose: tablet, capsule, liquid, injection, cream, inhaler, drops or other. Set at creation only; null when not given.';
comment on column ehr.prescriptions.duration_value is
  'How long the medicine is for, with duration_unit (1-3650 days, weeks or months). Set at creation only; null when not given.';
comment on column ehr.prescriptions.duration_unit is
  'day, week or month, with duration_value. Set at creation only; null when not given.';
comment on column ehr.prescriptions.quantity_to_dispense is
  'How much to hand over, with quantity_unit, as the prescriber suggests it; the pharmacist confirms the quantity dispensed. Set at creation only; null when not given.';
comment on column ehr.prescriptions.quantity_unit is
  'The unit of quantity_to_dispense (for example capsule). Set at creation only; null when not given.';

-- 5. Post-checks of the table (still under the lock).
do $$
declare
  mismatch text;
begin
  select string_agg(format('%s', expected.column_name), '; ') into mismatch
    from (values ('priority', 'text'), ('medication_strength', 'text'), ('medication_dose_form', 'text'),
                 ('duration_value', 'integer'), ('duration_unit', 'text'), ('quantity_to_dispense', 'numeric(12,4)'),
                 ('quantity_unit', 'text')) expected(column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = 'ehr.prescriptions'::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and not attribute_row.attnotnull and not attribute_row.atthasdef
                        and attribute_row.attgenerated = '' and attribute_row.attidentity = '');
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0122: the columns are not as this file makes them: %s', mismatch);
  end if;
  -- The CHECK, validated, with this definition (one CHECK for the seven
  -- columns: the value sets, the lengths, the ranges and the two pairs).
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'ehr.prescriptions'::regclass
                    and constraint_row.conname = 'prescriptions_dispensing_details_ck' and constraint_row.contype = 'c'
                    and constraint_row.convalidated and not constraint_row.connoinherit
                    and pg_get_constraintdef(constraint_row.oid) =
                      'CHECK ((((priority IS NULL) OR (priority = ANY (ARRAY[''routine''::text, ''urgent''::text, '
                      || '''asap''::text, ''stat''::text]))) AND ((medication_strength IS NULL) OR '
                      || '((length(medication_strength) <= 80) AND (length(btrim(medication_strength)) >= 1))) AND '
                      || '((medication_dose_form IS NULL) OR (medication_dose_form = ANY (ARRAY[''tablet''::text, '
                      || '''capsule''::text, ''liquid''::text, ''injection''::text, ''cream''::text, ''inhaler''::text, '
                      || '''drops''::text, ''other''::text]))) AND ((duration_value IS NULL) = (duration_unit IS NULL)) AND '
                      || '((duration_value IS NULL) OR ((duration_value >= 1) AND (duration_value <= 3650))) AND '
                      || '((duration_unit IS NULL) OR (duration_unit = ANY (ARRAY[''day''::text, ''week''::text, '
                      || '''month''::text]))) AND ((quantity_to_dispense IS NULL) = (quantity_unit IS NULL)) AND '
                      || '((quantity_to_dispense IS NULL) OR (quantity_to_dispense > (0)::numeric)) AND '
                      || '((quantity_unit IS NULL) OR ((length(quantity_unit) <= 80) AND (length(btrim(quantity_unit)) >= 1)))))') then
    raise exception using errcode = '55000',
      message = '0122: the CHECK is not as this file makes it: prescriptions_dispensing_details_ck';
  end if;
  -- Untouched: the triggers, row-level security, and the bodies that read
  -- the row type or fire on the table.
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and not trigger_row.tgisinternal
         and trigger_row.tgenabled = 'O') <> 3
     or not (select relation.relrowsecurity and relation.relforcerowsecurity from pg_class relation
              where relation.oid = 'ehr.prescriptions'::regclass)
     or (select count(*) from pg_proc proc
          where (proc.oid, md5(proc.prosrc)) in (
            ('pharmacy.validate_work_item()'::regprocedure, 'e2411539ee8c95a02dad46c03e24db05'),
            ('pharmacy.validate_dispensing()'::regprocedure, '17f7e8897bd2ab240332e4d2c9f757b7'),
            ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)'::regprocedure,
             '4202ba3bbf02abd7db34606d42adca9c'),
            ('ehr.sync_order_routes_on_order_change()'::regprocedure, '8ce6b42450cc06fc02fec8d1cf63af41'),
            ('ehr.capture_record_version()'::regprocedure, '70daa16f05bb3ec28f05292e6358a702'))) <> 5 then
    raise exception using errcode = '55000',
      message = '0122: a trigger, row-level security or a body on ehr.prescriptions changed';
  end if;
end
$$;
