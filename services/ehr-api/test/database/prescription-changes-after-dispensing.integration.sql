\set ON_ERROR_STOP on
-- 0148 (owner decision Q132 A, 19 November 2026; coordinator decision 1 on
-- #258, 20 November 2026): a change of a prescription after the pharmacy
-- dispensed it reaches the pharmacy. The trigger on ehr.prescriptions records
-- each change of an active or held prescription that has a dispensed work
-- item (0133's claims), and the reader answers, for the items a session may
-- read, the latest shown change, its time and how many shown changes there
-- were.
-- Rollback-only. Through the exact runtime roles the services use
-- (hid_ehr_api_runtime with ehr-api's own UPDATE text and app.change_reason,
-- hid_pharmacy_api_runtime), in the session the services set (the new images
-- also set app.own_facility_work to '0133', 0133 D13).
-- Cases (the expect labels start with their number):
--   1. structure: the table exactly (columns, key, no CHECK, no foreign key,
--      row-level security on and not forced, owner, ACL), no hid_ role
--      reaching it, its immutability trigger; the trigger on
--      ehr.prescriptions exactly, in origin mode, the last of the AFTER
--      UPDATE triggers; the two functions (md5, owner, SECURITY DEFINER,
--      volatility, language, search_path, not STRICT) and who may execute
--      them; no 0148 body names ehr.prescriptions or the sends table, and
--      0133's S7 list is unchanged; ehr.prescriptions' columns in order (a
--      migration that adds one decides the fingerprint's left-out keys);
--      pharmacy.work_items' read policies are the two the reader repeats;
--   2. recording (own items sent automatically, dispensed by PH): a hold
--      before the dispensing records nothing; after it one row, with the
--      version, the statuses and the claim's facility and nothing else, its
--      time after the dispensing's;
--   3. the labels, read by PH (L1-L15): hold, cancel, entered in error, an
--      edit of each field ehr-api changes, a resume as dispensed, an edit
--      during the hold, a stop and an edit in one change, a resume and an
--      edit in one change, an edit back, a change after a stop (no row),
--      completed and a change of nothing (rows, no notice), several changes
--      (the latest and the count), the latest by version, an edit before
--      the hold;
--   4. an item PG handed in by hand, dispensed, then cancelled (no send);
--   5. an item from another facility's order route (F1 to F4, accepted and
--      dispensed by P4): held by DR, P4 reads it, F1's pharmacists do not,
--      0086's route event is still written, nothing after the route's
--      access ends, entered in error (the route closes: only an F4 member
--      with a consent grant reads it), and an own-work session at F4 never
--      reads a route-backed item;
--   6. visibility: for nine sessions the reader's items are exactly the
--      items the same session selects from pharmacy.work_items; a member
--      with consent but without pharmacy.work-item.read, a lab scientist and
--      the doctor get nothing; 201 ids and a null array are refused; an
--      empty array and no session answer nothing; no runtime may touch the
--      table, and the EHR and Lab runtimes may not call the reader; a forged
--      owner-written row whose facility is not its item's is not answered;
--   7. never refuses (N1-N6, ehr-api's UPDATE through the EHR runtime):
--      every transition, a row already at the next version, the order-route
--      send of a draft, replica mode, an owner change of a 0125 column, a
--      status this file does not know;
--   8. Release A's shapes: 0133's states and withdrawn readers, 0144's
--      steps reader and pharmacy-api's 0133 list answer exactly as they do
--      with 0148 undone; 0133 D8 marks a send once;
--   9. both owner kinds: this suite runs on a database whose owner is a
--      superuser (the container acceptance cluster) and on one whose owner
--      has neither superuser nor BYPASSRLS (the RDS-like rehearsal), and
--      expects the same answers on both: a route-backed item changed by DR
--      (no consent at F4) and an own item changed in a session without
--      consent are recorded (the trigger reads only the claims, whose
--      row-level security is not forced), and case 6's answers are fixed
--      strings;
--  10. the undo order of 0148's header, and what each wrong order breaks;
--  11. the fingerprint: the same under other DateStyle and TimeZone, a new
--      nullable column leaves it, status, version and the two times do not
--      change it, a 0125 value does;
--  12. a reversed dispensing, a hold between a dispensing and its reversal,
--      an own item released before dispensing and its F4 item dispensed;
--  13. the oracle, over every row the suite wrote: each version is above
--      its work item's version.
-- Removal cases (each a copy of a function or the trigger with one clause
-- taken out, applied after case 1) and the case each fails are listed in
-- the commit message.
-- Fixtures inserted as the suite runner with session_replication_role =
-- replica where the services would not write them (identity rows, the
-- outside pharmacy's approval, Ada's own work at F4). Synthetic values only;
-- uuid prefix e148.
set plpgsql.variable_conflict = error;
begin;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception 'changes after dispensing: %: got [%], want [%]', label, got, want;
  end if;
end
$f$;
-- A statement's outcome: 'ok', or 'SQLSTATE message'.
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

-- 1. Structure.
do $$
declare
  mismatch text;
  owner_oid oid := (select relowner from pg_class where oid = 'pharmacy.work_items'::regclass);
  validator_owner oid := (select proowner from pg_proc where oid = 'pharmacy.validate_dispensing()'::regprocedure);
begin
  -- 1a. The table: its columns, its key and nothing else (no CHECK, no
  -- foreign key, no other index), the owner's, row-level security enabled
  -- and not forced, no policy, the owner alone in its ACL.
  perform pg_temp.expect('1a the table exactly (columns, key, no CHECK, no foreign key, RLS on not forced, owner, ACL)',
    (select string_agg(attribute.attname || ' ' || format_type(attribute.atttypid, attribute.atttypmod)
              || case when attribute.attnotnull then ' not null' else '' end, ', ' order by attribute.attnum)
       from pg_attribute attribute
      where attribute.attrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass and attribute.attnum > 0
        and not attribute.attisdropped)
    || ' | ' || (select string_agg(constraint_row.contype::text || ' ' || pg_get_constraintdef(constraint_row.oid)
                   || ' deferrable=' || constraint_row.condeferrable, '; ')
                   from pg_constraint constraint_row
                  where constraint_row.conrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass)
    || ' | ' || (select string_agg(pg_get_indexdef(index_row.indexrelid), '; ') from pg_index index_row
                  where index_row.indrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass)
    || ' | ' || (select format('owner=%s rls=%s forced=%s kind=%s', relation.relowner = owner_oid,
                   relation.relrowsecurity, relation.relforcerowsecurity, relation.relkind)
                   from pg_class relation where relation.oid = 'pharmacy.prescription_changes_after_dispensing'::regclass)
    || ' | policies=' || (select count(*) from pg_policy policy_row
                          where policy_row.polrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass)
    || ' | others in ACL=' || (select count(*) from pg_class relation
                   cross join aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
                   where relation.oid = 'pharmacy.prescription_changes_after_dispensing'::regclass
                     and privilege.grantee <> relation.relowner),
    'work_item_id uuid not null, facility_id uuid not null, prescription_version bigint not null, status_before text '
    || 'not null, status_after text not null, prior_content_sha256 bytea not null, content_sha256 bytea not null, '
    || 'changed_at timestamp with time zone not null | p PRIMARY KEY (work_item_id, prescription_version) '
    || 'deferrable=false | CREATE UNIQUE INDEX prescription_changes_after_dispensing_pkey ON '
    || 'pharmacy.prescription_changes_after_dispensing USING btree (work_item_id, prescription_version) | '
    || 'owner=t rls=t forced=f kind=r | policies=0 | others in ACL=0');
  -- 1b. No runtime, worker or command role holds any privilege on it,
  -- through any membership.
  select string_agg(format('%s %s', role_row.rolname, privilege.name), '; ') into mismatch
    from pg_roles role_row
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege(name)
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_table_privilege(role_row.oid, 'pharmacy.prescription_changes_after_dispensing', privilege.name);
  perform pg_temp.expect('1b no hid_ role reaches the table through any membership', coalesce(mismatch, 'none'), 'none');
  -- 1c. Rows are never updated or deleted: 0023's immutability function, in
  -- origin mode as the 0144 suite pins its own (PostgreSQL prints DELETE
  -- before UPDATE).
  perform pg_temp.expect('1c the immutability trigger',
    (select string_agg(pg_get_triggerdef(trigger_row.oid) || ' ' || trigger_row.tgenabled::text, '; ')
       from pg_trigger trigger_row
      where trigger_row.tgrelid = 'pharmacy.prescription_changes_after_dispensing'::regclass
        and not trigger_row.tgisinternal),
    'CREATE TRIGGER prescription_changes_after_dispensing_immutable BEFORE DELETE OR UPDATE ON '
    || 'pharmacy.prescription_changes_after_dispensing FOR EACH ROW EXECUTE FUNCTION '
    || 'pharmacy.reject_immutable_evidence() O');
  -- 1d. The trigger exactly, in origin mode, and the last of the AFTER
  -- UPDATE row triggers in the order PostgreSQL fires them (name, C
  -- collation), after 0086's route sync and 0133 D8's.
  perform pg_temp.expect('1d the trigger on ehr.prescriptions exactly, origin mode, last of the AFTER UPDATE triggers',
    (select string_agg(pg_get_triggerdef(trigger_row.oid) || ' ' || trigger_row.tgenabled::text, '; ')
       from pg_trigger trigger_row
      where trigger_row.tgfoid = 'pharmacy.prescription_change_after_dispensing()'::regprocedure)
    || ' | ' || (select string_agg(trigger_row.tgname, ' ' order by trigger_row.tgname::text collate "C")
                   from pg_trigger trigger_row
                  where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and trigger_row.tgtype & 1 <> 0
                    and trigger_row.tgtype & 16 <> 0 and trigger_row.tgtype & 2 = 0 and trigger_row.tgtype & 64 = 0
                    and not trigger_row.tgisinternal)
    || ' | internal after it=' || (select count(*) from pg_trigger trigger_row
                  where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and trigger_row.tgisinternal
                    and trigger_row.tgname::text collate "C" > 'prescriptions_pharmacy_change_after_dispensing'),
    'CREATE TRIGGER prescriptions_pharmacy_change_after_dispensing AFTER UPDATE ON ehr.prescriptions FOR EACH ROW WHEN '
    || '((old.status = ANY (ARRAY[''active''::text, ''on_hold''::text]))) EXECUTE FUNCTION '
    || 'pharmacy.prescription_change_after_dispensing() O | prescriptions_order_routes_sync '
    || 'prescriptions_own_pharmacy_send_withdrawn prescriptions_pharmacy_change_after_dispensing | internal after it=0');
  -- 1e. The two functions: bodies (md5), owner (the work items' and the
  -- dispensing validator's), SECURITY DEFINER, volatility, language, not
  -- STRICT, search_path, and the reader's columns.
  select string_agg(format('%s md5=%s owner=%s definer=%s volatile=%s strict=%s language=%s config=%s', expected.proc_name,
           coalesce(md5(proc.prosrc), 'none (missing)'), pg_get_userbyid(proc.proowner), proc.prosecdef,
           proc.provolatile, proc.proisstrict, language_row.lanname, proc.proconfig), '; ')
    into mismatch
    from (values
      ('pharmacy.prescription_change_after_dispensing()', 'f61173d77be391a9e9c96db494827e82', 'v'),
      ('pharmacy.work_item_changes_after_dispensing(uuid[])', 'f034ea13a60ffb4314b442d50a156e96', 's'))
      expected(proc_name, digest, volatility)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc_name)
    left join pg_language language_row on language_row.oid = proc.prolang
   where proc.oid is null or md5(proc.prosrc) <> expected.digest or proc.proowner <> validator_owner
      or proc.proowner <> owner_oid or not proc.prosecdef or proc.provolatile <> expected.volatility
      or proc.proisstrict or language_row.lanname <> 'plpgsql'
      or proc.proconfig::text <> '{"search_path=pg_catalog, pg_temp"}';
  perform pg_temp.expect('1e the two functions: md5, owner, security, volatility, language, search_path, not strict',
    coalesce(mismatch, 'as built') || ' | '
    || pg_get_function_result('pharmacy.work_item_changes_after_dispensing(uuid[])'::regprocedure),
    'as built | TABLE(work_item_id uuid, change text, changed_at timestamp with time zone, change_count integer)');
  -- 1f. Who may execute them, through any membership: the reader the
  -- Pharmacy runtime (and the Pharmacy API's login through it) and the
  -- schema test runtime; the trigger function nobody; PUBLIC neither.
  select string_agg(format('%s %s=%s', expected.proc_name, role_row.rolname,
           has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')), '; ') into mismatch
    from (values
      ('pharmacy.prescription_change_after_dispensing()', array[]::text[]),
      ('pharmacy.work_item_changes_after_dispensing(uuid[])', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime'])) expected(proc_name, allowed)
    cross join pg_roles role_row
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')
         <> (role_row.rolname = any(expected.allowed));
  perform pg_temp.expect('1f EXECUTE: the reader to the Pharmacy and schema test runtimes only, the trigger function to nobody',
    coalesce(mismatch, 'as granted') || ' public='
    || exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                where proc.oid in ('pharmacy.work_item_changes_after_dispensing(uuid[])'::regprocedure,
                        'pharmacy.prescription_change_after_dispensing()'::regprocedure) and acl.grantee = 0),
    'as granted public=false');
  -- 1g. No 0148 body names ehr.prescriptions or the sends table, so 0133's
  -- S7 list (the owner-run definers whose text names ehr.prescriptions,
  -- each of which sees D5's rows in a pharmacist's session) stays the ten
  -- 0133's suite pins on Release B (0143's ehr.list_my_orders, 0144's
  -- acceptance trigger function and 0145's identity.decide_unknown_patient
  -- among them).
  perform pg_temp.expect('1g no 0148 body names ehr.prescriptions or the sends table; 0133''s S7 list unchanged',
    (select count(*) from pg_proc proc
      where proc.oid in ('pharmacy.work_item_changes_after_dispensing(uuid[])'::regprocedure,
              'pharmacy.prescription_change_after_dispensing()'::regprocedure)
        and (proc.prosrc ~* 'ehr\.prescriptions' or proc.prosrc ~* 'own_prescription_sends' or proc.prosrc ~ '0148'))
    || ' | ' || (select string_agg(proc.oid::regprocedure::text, ' ' order by proc.oid::regprocedure::text) from pg_proc proc
                  where proc.prosecdef and proc.prosrc ~* 'ehr\.prescriptions' and proc.proowner = validator_owner),
    '0 | ehr.list_my_orders(text[],boolean,date,timestamp with time zone,text,uuid,integer) '
    || 'ehr.patient_list_order_routes() ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,'
    || 'character) ehr.send_prescription_to_own_pharmacy(uuid,bigint) ehr.withdraw_own_pharmacy_send(uuid) '
    || 'identity.decide_unknown_patient(uuid,text,bigint,text,text,text) '
    || 'identity.demo_story_install(text) pharmacy.validate_dispensing() pharmacy.validate_work_item() '
    || 'pharmacy.validate_work_item_acceptance()');
  -- 1h. ehr.prescriptions' columns, in order: the trigger fingerprints the
  -- whole row less status, row_version and the two times, so a migration
  -- that adds a NOT NULL or defaulted column (which changes every later
  -- fingerprint, and the first resume after it would read 'edited') meets
  -- this case and decides whether to add its name to the left-out keys by
  -- replacing pharmacy.prescription_change_after_dispensing(); a timestamptz
  -- or interval column must be left out. A migration that changes a
  -- column's type so that its jsonb text changes (numeric(12,4) to
  -- numeric(14,6) turns 1.0000 into 1.000000), or renames or drops a column
  -- that holds values, meets this case too: that also changes every later
  -- fingerprint, and the first resume after it reads 'edited' (the safe
  -- side). 0152 (ORD-12) added
  -- refills_allowed smallint, nullable and without a default: null in every
  -- older row, so no fingerprint changes and the trigger function stays
  -- 0148's (its md5 is pinned in 1e); a value an owner sets after
  -- dispensing shows as 'edited' (prescription-refills, case 9).
  perform pg_temp.expect('1h ehr.prescriptions'' columns and types, in order (a migration that adds one decides C2''s excluded keys)',
    (select string_agg(attribute.attname || ' ' || format_type(attribute.atttypid, attribute.atttypmod)
              || case when attribute.attnotnull then ' not null' else '' end
              || case when attribute.atthasdef then ' default' else '' end, ', ' order by attribute.attnum)
       from pg_attribute attribute
      where attribute.attrelid = 'ehr.prescriptions'::regclass and attribute.attnum > 0 and not attribute.attisdropped),
    'id uuid not null default, encounter_id uuid not null, patient_id uuid not null, facility_id uuid not null, '
    || 'created_by uuid not null, created_by_membership_id uuid not null, medication_code_system text, '
    || 'medication_code text, medication_display text not null, dose_quantity numeric(12,4), dose_unit text, '
    || 'route_code text, frequency text not null, instructions text not null, starts_on date, ends_on date, '
    || 'status text not null, row_version bigint not null default, created_at timestamp with time zone not null '
    || 'default, updated_at timestamp with time zone not null default, priority text, medication_strength text, '
    || 'medication_dose_form text, duration_value integer, duration_unit text, quantity_to_dispense numeric(12,4), '
    || 'quantity_unit text, refills_allowed smallint');
  -- 1i. The work items' read policies: the reader repeats exactly these two
  -- as conditions (0086's consent or order route, 0133's own work), and
  -- none is restrictive.
  perform pg_temp.expect('1i pharmacy.work_items'' read policies are the two the reader copies',
    (select string_agg(policy_row.polname || ':' || policy_row.polpermissive || ':'
              || pg_get_expr(policy_row.polqual, policy_row.polrelid), ' ; ' order by policy_row.polname::text collate "C")
       from pg_policy policy_row
      where policy_row.polrelid = 'pharmacy.work_items'::regclass and policy_row.polcmd in ('r', '*')),
    'pharmacy_work_items_read:true:pharmacy.work_item_allows(patient_id, facility_id, order_route_id, '
    || '''read_records''::text) ; staff_own_work_read:true:(COALESCE(identity.pharmacy_work_patient_allows(( SELECT '
    || 'identity.facility_work_session_membership(''pharmacy''::text) AS facility_work_session_membership), '
    || 'patient_id, facility_id, ''read_records''::text), false) AND (order_route_id IS NULL))');
end $$;

-- Fixtures. Organization O (e1480000...01) with facilities F1 "Changes Test
-- Hospital" (e1480001...01, its own pharmacy) and F2 "Changes Test Annex"
-- (...02, another hospital); an outside pharmacy, organization O4 "Changes
-- Outside Pharmacy Ltd" (a governed, approved pharmacy) with facility F4
-- (...04). Members (account e1480002...n, staff e1480003...n, membership
-- e1480004...n, role e1480005...n):
--   1 DR doctor F1 (write grants)           2 PH pharmacist F1 (no grant)
--   3 PG pharmacist F1 (write grants)       4 CW admin F1 (read grants; the
--                                             admin role holds no
--                                             pharmacy.work-item.read)
--   5 PX pharmacist F2                      6 P4 pharmacist F4
--   7 LS lab scientist F1                   8 PF pharmacist F4 (a read grant
--                                             for Ada at F4)
-- Patients (e1480006...n): 1 Ada (an active account, so an order route can
-- reach her), 2 Bisi.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'changes-test'),
  ('emergency', 'Emergency treatment', 'changes-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1480000-0000-4000-8000-000000000001', 'Changes Test Organization', 'changes-test-organization'),
  ('e1480000-0000-4000-8000-000000000004', 'Changes Outside Pharmacy Ltd', 'changes-outside-pharmacy');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1480001-0000-4000-8000-000000000001', 'e1480000-0000-4000-8000-000000000001', 'Changes Test Hospital',
   'CHANGES-1', 'Africa/Lagos', true, 'verified'),
  ('e1480001-0000-4000-8000-000000000002', 'e1480000-0000-4000-8000-000000000001', 'Changes Test Annex',
   'CHANGES-2', 'Africa/Lagos', true, 'verified'),
  ('e1480001-0000-4000-8000-000000000004', 'e1480000-0000-4000-8000-000000000004', 'Changes Outside Pharmacy',
   'CHANGES-4', 'Africa/Lagos', true, 'verified');
create temporary table changes_members (n integer primary key, code text, role_code text, site integer,
  organization integer) on commit drop;
insert into changes_members values (1, 'dr', 'doctor', 1, 1), (2, 'ph', 'pharmacist', 1, 1),
  (3, 'pg', 'pharmacist', 1, 1), (4, 'cw', 'admin', 1, 1), (5, 'px', 'pharmacist', 2, 1), (6, 'p4', 'pharmacist', 4, 4),
  (7, 'ls', 'lab', 1, 1), (8, 'pf', 'pharmacist', 4, 4);
grant select on changes_members to public;
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1480002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:changes-' || code,
       'changes-' || code || '@example.invalid', 'Changes ' || upper(code), 'active'
  from changes_members
union all
select 'e1480015-0000-4000-8000-000000000001', 'synthetic:changes-patient-ada', 'changes-ada@example.invalid',
       'Ada Change', 'active';
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1480003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1480002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'Changes ' || upper(code),
       'changes-' || code || '@example.invalid', 'verified', role_code
  from changes_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1480004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1480003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1480002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1480000-0000-4000-8000-00000000000' || organization)::uuid,
       ('e1480001-0000-4000-8000-00000000000' || site)::uuid, role_code, role_code, true, true
  from changes_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1480005-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1480002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
       ('e1480004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1480001-0000-4000-8000-00000000000' || site)::uuid, 'Changes suite role'
  from changes_members;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1480006-0000-4000-8000-000000000001', 'e1480015-0000-4000-8000-000000000001', 'HID-CHGAAA2', 'Ada', 'Change',
   'Ada Change', 'female', '1990-04-05', 'active'),
  ('e1480006-0000-4000-8000-000000000002', null, 'HID-CHGBBB3', 'Bisi', 'Change', 'Bisi Change', 'female',
   '1985-01-02', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select gen_random_uuid(), ('e1480006-0000-4000-8000-00000000000' || patient)::uuid,
       ('e1480003-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1480002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1480004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1480001-0000-4000-8000-00000000000' || site)::uuid, scope, 'direct-care', 'active',
       'Synthetic changes consent', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days'
  from (values (1, 1, 1, 'write_records'), (1, 2, 1, 'write_records'), (3, 1, 1, 'write_records'),
               (3, 2, 1, 'write_records'), (4, 1, 1, 'read_records'), (4, 2, 1, 'read_records'),
               (8, 1, 4, 'read_records')) consent(member, patient, site, scope);
-- The outside pharmacy (as 0133's and 0144's suites): its governed approval
-- and product, and orders between facilities switched on (control_settings
-- readable by a non-superuser owner).
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
values ('e1480013-0000-4000-8000-000000000004', 'pharmacy', 'Changes Outside Pharmacy Ltd', 'pharmacy', 'RC9914804',
  'Changes Outside Admin', 'admin@changes-outside.invalid', 'approved', 'verified', '914804', clock_timestamp(),
  'e1480000-0000-4000-8000-000000000004', 'e1480001-0000-4000-8000-000000000004', 'e1480002-0000-4000-8000-000000000001',
  'Governed approval for the changes suite', clock_timestamp(), 'Changes Outside Pharmacy Ltd',
  'Private Company Limited by Shares', '2019-05-01', '9 Outside Road, Ikeja, Lagos', 'active');
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
values ('e1480000-0000-4000-8000-000000000004', 'pharmacy', 'e1480001-0000-4000-8000-000000000004', 'active',
  'e1480013-0000-4000-8000-000000000004');
set local session_replication_role = origin;
do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;
set local session_replication_role = replica;
update platform.control_settings set enabled = true
 where control_key in ('cross_facility_orders_enabled', 'cross_facility_route_access_enabled');
set local session_replication_role = origin;
select set_config('changes.attestation', (select text_row.version from ehr.order_route_attestation_texts text_row
  where text_row.kind = 'prescription' order by text_row.created_at desc, text_row.version desc limit 1), true);

-- The session the services set (DatabaseService.withTransaction); the new
-- images also set app.own_facility_work to '0133' (switched => false is a
-- session of today's images).
create function pg_temp.as_member(member integer, site integer default null, purpose text default 'direct-care',
  switched boolean default true) returns void language sql as $f$
  select set_config('app.own_facility_work', case when switched then '0133' else '' end, true),
         set_config('app.actor_subject', 'synthetic:changes-' || (select code from changes_members where n = member), true),
         set_config('app.facility_id', 'e1480001-0000-4000-8000-00000000000'
           || coalesce(site, (select changes_members.site from changes_members where n = member)), true),
         set_config('app.correlation_id', 'changes-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', 'e1480004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'), true),
         set_config('app.purpose_of_use', purpose, true);
$f$;
-- Whether the functions' owner is a superuser or has BYPASSRLS (pgadmin on
-- the container cluster): case 9 says which kind of owner this run had.
create function pg_temp.owner_bypasses() returns boolean language sql as $f$
  select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
    join pg_roles role_row on role_row.oid = proc.proowner
   where proc.oid = 'pharmacy.work_item_changes_after_dispensing(uuid[])'::regprocedure
$f$;
create function pg_temp.rx(n integer) returns uuid language sql immutable as $f$
  select ('e1480007-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.account(member integer) returns uuid language sql immutable as $f$
  select ('e1480002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid
$f$;
create function pg_temp.membership(member integer) returns uuid language sql immutable as $f$
  select ('e1480004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid
$f$;
-- Owner reads (the suite runner's): a prescription's own work item and its
-- route-backed one; a work item's name ('rxN', 'rxN@F4' for a route-backed
-- one); a prescription as it stands.
create function pg_temp.work_item_of(prescription uuid) returns uuid language sql security definer as $f$
  select id from pharmacy.work_items where source_ehr_prescription_id = prescription and order_route_id is null
$f$;
create function pg_temp.routed_item_of(prescription uuid) returns uuid language sql security definer as $f$
  select id from pharmacy.work_items where source_ehr_prescription_id = prescription and order_route_id is not null
$f$;
create function pg_temp.name_of(work_item uuid) returns text language sql security definer as $f$
  select 'rx' || ltrim(right(source_ehr_prescription_id::text, 2), '0')
         || case when order_route_id is not null then '@F4' else '' end
    from pharmacy.work_items where id = work_item
$f$;
create function pg_temp.current_rx(n integer) returns ehr.prescriptions language sql security definer as $f$
  select * from ehr.prescriptions where id = pg_temp.rx(n)
$f$;
-- ehr-api's change of a prescription (PrescriptionsService.update,
-- prescriptions.service.ts:278-288), its exact SET and WHERE, with the
-- version the caller holds and the reason it sets first, as the session's
-- role (the EHR runtime): 'ok', 'no row', or 'SQLSTATE message'.
create function pg_temp.patch(n integer, new_status text default null, new_frequency text default null,
  new_instructions text default null, new_ends_on text default null, reason text default 'Changed by the prescriber')
returns text language plpgsql as $f$
declare
  current_row ehr.prescriptions := pg_temp.current_rx(n);
  changed_id text;
begin
  perform set_config('app.change_reason', reason, true);
  execute 'update ehr.prescriptions set
             status = coalesce($1, status), frequency = coalesce($2, frequency),
             instructions = coalesce($3, instructions), ends_on = coalesce($4::date, ends_on)
           where id = $5 and encounter_id = $6 and patient_id = $7 and facility_id = $8 and row_version = $9
           returning id::text'
    into changed_id
    using new_status, new_frequency, new_instructions, new_ends_on, current_row.id, current_row.encounter_id,
      current_row.patient_id, current_row.facility_id, current_row.row_version;
  return case when changed_id is null then 'no row' else 'ok' end;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- DR's change, through the EHR runtime as ehr-api makes it.
create function pg_temp.dr(n integer, new_status text default null, new_frequency text default null,
  new_instructions text default null, new_ends_on text default null) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_ehr_api_runtime;
  perform pg_temp.as_member(1);
  answer := pg_temp.patch(n, new_status, new_frequency, new_instructions, new_ends_on);
  reset role;
  return answer;
end
$f$;
-- 0133 D7's send, as ehr-api calls it after an activation: its answer.
create function pg_temp.send(prescription uuid) returns text language plpgsql as $f$
declare answer text;
begin
  select string_agg(sent.outcome || case when sent.work_item_id is null then '' else ':item' end, ',') into answer
    from ehr.send_prescription_to_own_pharmacy(prescription, (pg_temp.current_rx_version(prescription))) sent;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.current_rx_version(prescription uuid) returns bigint language sql security definer as $f$
  select row_version from ehr.prescriptions where id = prescription
$f$;
-- pharmacy-api's dispensing INSERT (PharmacyService.dispense) by the
-- session's member, and its reversal INSERT (PharmacyService.reverse).
create function pg_temp.dispense_sql(work_item uuid, member integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,%L,%L,21,'capsule',%L,%L,'Dispensed to the patient',%L,%L,%L)$i$,
    gen_random_uuid(), w.id, w.patient_id, w.facility_id, w.medication_code_system, w.medication_code,
    w.medication_display, pg_temp.account(member), pg_temp.membership(member),
    'changes-dispense-' || replace(gen_random_uuid()::text, '-', ''), repeat('d', 64),
    current_setting('app.correlation_id'))
  from pharmacy.work_items w where w.id = work_item
$f$;
create function pg_temp.reverse_sql(work_item uuid, member integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,%L,%L,'Dispensed to the wrong patient',%L,%L,%L)$i$,
    gen_random_uuid(), d.id, d.work_item_id, d.patient_id, d.facility_id, pg_temp.account(member),
    pg_temp.membership(member), 'changes-reverse-' || replace(gen_random_uuid()::text, '-', ''), repeat('e', 64),
    current_setting('app.correlation_id'))
  from pharmacy.dispensings d where d.work_item_id = work_item
$f$;
-- pharmacy-api's hand-in (PharmacyService.accept, a pharmacist bringing in
-- a prescription by hand) of prescription n by the session's member: the
-- work item and its prescription_accepted event of version 1.
create function pg_temp.hand_in_sql(n integer, member integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,%L,%L,%L,%s,%L,'active',%L,%L,%L,%s,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,
        'Handed in at the pharmacy counter',%L,%L,%L);
      insert into pharmacy.work_item_events (
        work_item_id,patient_id,facility_id,event_version,event_type,actor_id,actor_membership_id,reason,correlation_id
      ) values (%1$L,%2$L,%3$L,1,'prescription_accepted',%20$L,%21$L,'Handed in at the pharmacy counter',%24$L)$i$,
    gen_random_uuid(), p.patient_id, p.facility_id, p.facility_id, p.id, p.row_version, p.encounter_id,
    p.medication_code_system, p.medication_code, p.medication_display, p.dose_quantity, p.dose_unit, p.route_code,
    p.frequency, p.instructions, p.starts_on, p.ends_on, p.created_by, p.created_at, pg_temp.account(member),
    pg_temp.membership(member), 'changes-hand-in-' || replace(gen_random_uuid()::text, '-', ''), repeat('a', 64),
    current_setting('app.correlation_id'))
  from ehr.prescriptions p where p.id = pg_temp.rx(n)
$f$;
-- DR's order-route send of prescription n to F4's pharmacy, as the new
-- ehr-api calls it (the switch set): 'sent' (the route kept as
-- changes.route_<n>), or 'SQLSTATE message'.
create function pg_temp.route_send(n integer) returns text language plpgsql as $f$
declare
  source ehr.prescriptions;
  sent record;
  key text := 'changes-route-' || replace(gen_random_uuid()::text, '-', '');
begin
  perform pg_temp.as_member(1);
  source := pg_temp.current_rx(n);
  select * into sent from ehr.send_order_route(gen_random_uuid(), 'prescription', source.patient_id, source.id,
    source.encounter_id, source.row_version, 'e1480001-0000-4000-8000-000000000004',
    current_setting('changes.attestation'), key, encode(sha256(key::bytea), 'hex'));
  perform set_config('changes.route_' || n, sent.route_id::text, true);
  return 'sent';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.route_row(n integer) returns setof ehr.order_routes language sql security definer as $f$
  select * from ehr.order_routes where id = nullif(current_setting('changes.route_' || n, true), '')::uuid
$f$;
-- P4's acceptance of prescription n's route at F4 (pharmacy-api's call).
create function pg_temp.route_accept(n integer) returns text language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_member(6);
  select * into accepted from pharmacy.accept_order_route(current_setting('changes.route_' || n)::uuid,
    (select route.row_version from pg_temp.route_row(n) route), 'health_id', 'HID-CHGAAA2',
    'Patient collected the prescription', 'changes-route-accept-' || n || '-' || substr(md5(random()::text), 1, 8),
    repeat('a', 64));
  return accepted.result;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The reader's answer for these work items, in the session's role and
-- session: 'rxN:change/count' each (change '-' when absent), by name; or
-- 'none'.
create function pg_temp.notices(items uuid[]) returns text language sql as $f$
  select coalesce(string_agg(format('%s:%s/%s', pg_temp.name_of(answer.work_item_id), coalesce(answer.change, '-'),
           answer.change_count), ' ' order by length(pg_temp.name_of(answer.work_item_id)),
           pg_temp.name_of(answer.work_item_id)), 'none')
    from pharmacy.work_item_changes_after_dispensing(items) answer
$f$;
-- The items the reader answers, and the items the same session selects
-- from pharmacy.work_items, among these ids: names, by name; or 'none'.
create function pg_temp.reader_items(items uuid[]) returns text language sql as $f$
  select coalesce(string_agg(pg_temp.name_of(answer.work_item_id), ' '
           order by length(pg_temp.name_of(answer.work_item_id)), pg_temp.name_of(answer.work_item_id)), 'none')
    from pharmacy.work_item_changes_after_dispensing(items) answer
$f$;
create function pg_temp.table_items(items uuid[]) returns text language sql as $f$
  select coalesce(string_agg(pg_temp.name_of(item.id), ' '
           order by length(pg_temp.name_of(item.id)), pg_temp.name_of(item.id)), 'none')
    from pharmacy.work_items item where item.id = any(items)
$f$;
-- A member's reading of work items through the Pharmacy runtime, in the
-- session pharmacy-api sets; and PH's reading of prescriptions' own items
-- (the pharmacist with no grant, on the own-work basis).
create function pg_temp.reads_as(member integer, items uuid[], site integer default null,
  purpose text default 'direct-care', switched boolean default true) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(member, site, purpose, switched);
  answer := pg_temp.notices(items);
  reset role;
  return answer;
end
$f$;
create function pg_temp.ph_reads(prescriptions integer[]) returns text language sql as $f$
  select pg_temp.reads_as(2, array(select pg_temp.work_item_of(pg_temp.rx(p)) from unnest(prescriptions) p))
$f$;
-- The items a member selects from pharmacy.work_items through the Pharmacy
-- runtime, among these ids.
create function pg_temp.table_items_as(member integer, items uuid[]) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(member);
  answer := pg_temp.table_items(items);
  reset role;
  return answer;
end
$f$;
-- Which of these work items pharmacy.work_items' read policies let DR's
-- session see (through the Pharmacy runtime, in DR's session settings: what
-- forced row-level security would show an owner that has neither superuser
-- nor BYPASSRLS while DR's change runs; the EHR runtime itself has no use of
-- the pharmacy schema).
create function pg_temp.dr_sees(work_item uuid) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(1);
  answer := pg_temp.table_items(array[work_item]);
  reset role;
  return answer;
end
$f$;
-- The recorded rows of a work item (owner read): 'before>after' each, by
-- version.
create function pg_temp.rows_of(work_item uuid) returns text language sql security definer as $f$
  select coalesce(string_agg(change_row.status_before || '>' || change_row.status_after, ' '
           order by change_row.prescription_version), 'none')
    from pharmacy.prescription_changes_after_dispensing change_row where change_row.work_item_id = work_item
$f$;
-- The reader's changed_at for one item, and the recorded time of the
-- item's highest version, as text (to compare).
create function pg_temp.changed_at_of_as(member integer, work_item uuid) returns timestamptz language plpgsql as $f$
declare answer timestamptz;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(member);
  select reader.changed_at into answer from pharmacy.work_item_changes_after_dispensing(array[work_item]) reader;
  reset role;
  return answer;
end
$f$;
create function pg_temp.last_recorded_at(work_item uuid) returns timestamptz language sql security definer as $f$
  select change_row.changed_at from pharmacy.prescription_changes_after_dispensing change_row
   where change_row.work_item_id = work_item order by change_row.prescription_version desc limit 1
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', proc.signature);
  end loop;
end $$;

-- The EHR rows, through the EHR runtime with the EHR API's statements, as DR
-- at F1: encounter E1 for Ada and E2 for Bisi; prescriptions rx1-rx12 and
-- rx20-rx34 for Ada, rx13-rx19 for Bisi, written as drafts and activated
-- (all but rx26, which stays a draft for N3) with ehr-api's change.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e1480008-0000-4000-8000-00000000000' || n)::uuid, ('e1480006-0000-4000-8000-00000000000' || n)::uuid,
       'e1480001-0000-4000-8000-000000000001', pg_temp.account(1), pg_temp.membership(1), 'ambulatory', 'in_progress',
       clock_timestamp()
  from generate_series(1, 2) n;
create function pg_temp.prescribe(n integer, patient integer) returns void language sql as $f$
  insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, ends_on, status)
  values (pg_temp.rx(n), ('e1480008-0000-4000-8000-00000000000' || patient)::uuid,
    ('e1480006-0000-4000-8000-00000000000' || patient)::uuid, 'e1480001-0000-4000-8000-000000000001',
    pg_temp.account(1), pg_temp.membership(1), 'http://www.whocc.no/atc', 'J01CA04',
    'Amoxicillin 500 mg capsule (' || n || ')', 1, 'capsule', 'oral', 'Every 8 hours', 'Take after food for 7 days',
    date '2026-11-18', date '2026-11-25', 'draft');
$f$;
grant execute on function pg_temp.prescribe(integer, integer) to public;
select pg_temp.prescribe(n, case when n between 13 and 19 then 2 else 1 end) from generate_series(1, 34) n;
select pg_temp.expect('fixtures: DR activates every prescription but rx26',
  (select string_agg(distinct pg_temp.patch(n, 'active', reason => 'First activation (no reason needed)'), ',')
     from generate_series(1, 34) n where n <> 26), 'ok');
-- 0133 D7: the sends (ehr-api calls them after each activation), except
-- rx19 (handed in by hand, case 4) and rx20 (sent to another facility).
select pg_temp.expect('fixtures: D7 sends every own prescription but rx19 and rx20',
  (select string_agg(distinct pg_temp.send(pg_temp.rx(n)), ',') from generate_series(1, 34) n
    where n not in (19, 20, 26)), 'sent:item');
reset role;

-- 2. Recording. rx1 is held before any dispensing; PH dispenses every other
-- own item sent above (rx23 is sent to F4 first, in case 12).
select pg_temp.expect('2a an undispensed item''s hold records nothing',
  pg_temp.dr(1, 'on_hold') || ' ' || pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(1))), 'ok none');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('fixtures: PH dispenses rx2-rx18, rx21, rx22, rx24, rx25, rx27-rx34',
  (select string_agg(distinct pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(n)), 2)), ',')
     from generate_series(2, 34) n where n not in (19, 20, 23, 26)), 'ok');
reset role;
-- A statement does not see what the functions it calls changed (its
-- snapshot is taken when it starts), so each change below is made in a
-- statement of its own before an inline read of the table.
select set_config('changes.outcome', pg_temp.dr(2, 'on_hold'), true);
select pg_temp.expect('2b after the dispensing a hold records one row: active to on_hold, the version, the claim''s facility',
  current_setting('changes.outcome') || ' '
  || (select format('%s>%s v%s=%s facility=%s', change_row.status_before, change_row.status_after,
            change_row.prescription_version, change_row.prescription_version = (pg_temp.current_rx(2)).row_version,
            change_row.facility_id = claim.facility_id and claim.facility_id = 'e1480001-0000-4000-8000-000000000001')
        from pharmacy.prescription_changes_after_dispensing change_row
        join pharmacy.prescription_item_claims claim on claim.work_item_id = change_row.work_item_id
       where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(2))),
  'ok active>on_hold v3=t facility=t');
select pg_temp.expect('2c the row holds no actor, reason, prescription id or field value',
  (select string_agg(key, ' ' order by key) from pharmacy.prescription_changes_after_dispensing change_row,
     jsonb_object_keys(to_jsonb(change_row)) key where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(2)))
  || ' | ' || (select (to_jsonb(change_row)::text like '%' || pg_temp.rx(2) || '%')::text || '/'
                 || (to_jsonb(change_row)::text ~* 'every 8|after food|amoxicillin|changes|synthetic')::text
                 from pharmacy.prescription_changes_after_dispensing change_row
                where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(2))),
  'changed_at content_sha256 facility_id prescription_version prior_content_sha256 status_after status_before '
  || 'work_item_id | false/false');
select pg_temp.expect('2d changed_at is after the dispensing''s dispensed_at',
  (select (change_row.changed_at > claim.dispensed_at)::text || '/'
          || (change_row.changed_at > (select dispensing.dispensed_at from pharmacy.dispensings dispensing
                                        where dispensing.work_item_id = change_row.work_item_id))::text
     from pharmacy.prescription_changes_after_dispensing change_row
     join pharmacy.prescription_item_claims claim on claim.work_item_id = change_row.work_item_id
    where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(2))), 'true/true');

-- 3. The labels, read by PH (the pharmacist with no grant, the own-work
-- basis): DR changes the dispensed items with ehr-api's change.
select pg_temp.expect('L1 hold: on_hold/1', pg_temp.ph_reads(array[2]), 'rx2:on_hold/1');
select pg_temp.expect('L2 cancel: cancelled/1', pg_temp.dr(3, 'cancelled') || ' ' || pg_temp.ph_reads(array[3]),
  'ok rx3:cancelled/1');
select pg_temp.expect('L3 entered in error: entered_in_error/1',
  pg_temp.dr(4, 'entered_in_error') || ' ' || pg_temp.ph_reads(array[4]), 'ok rx4:entered_in_error/1');
select pg_temp.expect('L4 edit of frequency, of instructions, of the end date, each: edited',
  pg_temp.dr(5, new_frequency => 'Every 12 hours') || ' ' || pg_temp.dr(6, new_instructions => 'Take before food')
  || ' ' || pg_temp.dr(7, new_ends_on => '2026-11-28') || ' ' || pg_temp.ph_reads(array[5, 6, 7]),
  'ok ok ok rx5:edited/1 rx6:edited/1 rx7:edited/1');
select pg_temp.expect('L5 hold then resume unchanged: resumed/2',
  pg_temp.dr(8, 'on_hold') || ' ' || pg_temp.dr(8, 'active') || ' ' || pg_temp.ph_reads(array[8]),
  'ok ok rx8:resumed/2');
select pg_temp.expect('L6 hold, edit while held (not shown: on_hold/1), resume: edited/2',
  pg_temp.dr(9, 'on_hold') || ' ' || pg_temp.dr(9, new_frequency => 'Every 6 hours') || ' '
  || pg_temp.ph_reads(array[9]) || ' ' || pg_temp.dr(9, 'active') || ' ' || pg_temp.ph_reads(array[9]),
  'ok ok rx9:on_hold/1 ok rx9:edited/2');
select pg_temp.expect('L7 hold and edit in one change: on_hold, then resume: edited',
  pg_temp.dr(10, 'on_hold', 'Every 6 hours') || ' ' || pg_temp.ph_reads(array[10]) || ' ' || pg_temp.dr(10, 'active')
  || ' ' || pg_temp.ph_reads(array[10]), 'ok rx10:on_hold/1 ok rx10:edited/2');
select pg_temp.expect('L8 resume and edit in one change: edited',
  pg_temp.dr(11, 'on_hold') || ' ' || pg_temp.dr(11, 'active', 'Every 6 hours') || ' ' || pg_temp.ph_reads(array[11]),
  'ok ok rx11:edited/2');
select pg_temp.expect('L9 edit back to the dispensed content while active: edited',
  pg_temp.dr(12, new_frequency => 'Every 12 hours') || ' ' || pg_temp.dr(12, new_frequency => 'Every 8 hours') || ' '
  || pg_temp.ph_reads(array[12]), 'ok ok rx12:edited/2');
select pg_temp.expect('L10 cancel, then an edit while cancelled writes no row: cancelled/1',
  pg_temp.dr(13, 'cancelled') || ' ' || pg_temp.dr(13, new_instructions => 'Do not take') || ' '
  || pg_temp.ph_reads(array[13]) || ' rows=' || pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(13))),
  'ok ok rx13:cancelled/1 rows=active>cancelled');
select pg_temp.expect('L11 completed: a row, no notice, no count',
  pg_temp.dr(14, 'completed') || ' ' || pg_temp.ph_reads(array[14]) || ' rows='
  || pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(14))), 'ok none rows=active>completed');
select pg_temp.expect('L12 a no-op PATCH (same frequency): no notice',
  pg_temp.dr(15, new_frequency => 'Every 8 hours') || ' ' || pg_temp.ph_reads(array[15]) || ' rows='
  || pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(15))) || ' version='
  || (pg_temp.current_rx(15)).row_version, 'ok none rows=active>active version=3');
select pg_temp.expect('L13 hold, resume, cancel: cancelled/3, changedAt the cancel''s',
  pg_temp.dr(16, 'on_hold') || ' ' || pg_temp.dr(16, 'active') || ' ' || pg_temp.dr(16, 'cancelled') || ' '
  || pg_temp.ph_reads(array[16]) || ' '
  || (pg_temp.changed_at_of_as(2, pg_temp.work_item_of(pg_temp.rx(16)))
      = pg_temp.last_recorded_at(pg_temp.work_item_of(pg_temp.rx(16))))::text,
  'ok ok ok rx16:cancelled/3 true');
-- L14: a row of a higher version written earlier than the hold's (as the
-- owner: versions rise strictly under the prescription's row lock, but the
-- time a row carries is its writer's clock): the latest is the highest
-- version, not the latest time.
select pg_temp.expect('L14 latest by version, not by time (the hold first)', pg_temp.dr(17, 'on_hold'), 'ok');
insert into pharmacy.prescription_changes_after_dispensing (work_item_id, facility_id, prescription_version,
  status_before, status_after, prior_content_sha256, content_sha256, changed_at)
select change_row.work_item_id, change_row.facility_id, 99, 'on_hold', 'cancelled', change_row.content_sha256,
       change_row.content_sha256, change_row.changed_at - interval '1 day'
  from pharmacy.prescription_changes_after_dispensing change_row
 where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(17));
select pg_temp.expect('L14 latest by version, not by time',
  pg_temp.ph_reads(array[17]) || ' '
  || (pg_temp.changed_at_of_as(2, pg_temp.work_item_of(pg_temp.rx(17)))
      = pg_temp.last_recorded_at(pg_temp.work_item_of(pg_temp.rx(17))))::text || ' '
  || (pg_temp.last_recorded_at(pg_temp.work_item_of(pg_temp.rx(17)))
      < (select min(change_row.changed_at) from pharmacy.prescription_changes_after_dispensing change_row
          where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(17))
            and change_row.prescription_version < 99))::text,
  'rx17:cancelled/2 true true');
select pg_temp.expect('L15 edit while active, hold, resume unchanged: edited (not what was dispensed)',
  pg_temp.dr(18, new_frequency => 'Every 12 hours') || ' ' || pg_temp.dr(18, 'on_hold') || ' ' || pg_temp.dr(18, 'active')
  || ' ' || pg_temp.ph_reads(array[18]), 'ok ok ok rx18:edited/3');

-- 4. rx19 handed in by PG (a pharmacist with grants; no automatic send, so
-- no send row) and dispensed by PG; DR cancels it.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('fixtures: PG hands rx19 in and dispenses it',
  pg_temp.try(pg_temp.hand_in_sql(19, 3)) || ' '
  || pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(19)), 3)), 'ok ok');
reset role;
select pg_temp.expect('4a an item handed in by PG, dispensed, then cancelled by DR: cancelled/1 for PG and PH (no send row needed)',
  pg_temp.dr(19, 'cancelled') || ' PG=' || pg_temp.reads_as(3, array[pg_temp.work_item_of(pg_temp.rx(19))])
  || ' PH=' || pg_temp.ph_reads(array[19]) || ' sends='
  || (select count(*) from pharmacy.own_prescription_sends send where send.prescription_id = pg_temp.rx(19)),
  'ok PG=rx19:cancelled/1 PH=rx19:cancelled/1 sends=0');

-- 5. rx20 sent by DR from F1 to F4's pharmacy, accepted there by P4, and
-- dispensed by P4 (a route-backed item at F4; DR has no consent at F4).
set local role hid_ehr_api_runtime;
select pg_temp.expect('fixtures: DR sends rx20 to F4', pg_temp.route_send(20), 'sent');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('fixtures: P4 accepts rx20''s route at F4', pg_temp.route_accept(20), 'accepted');
select pg_temp.as_member(6);
select pg_temp.expect('fixtures: P4 dispenses the route-backed item',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.routed_item_of(pg_temp.rx(20)), 6)), 'ok');
reset role;
select pg_temp.expect('R5a DR holds it: P4 reads on_hold/1',
  pg_temp.dr(20, 'on_hold') || ' ' || pg_temp.reads_as(6, array[pg_temp.routed_item_of(pg_temp.rx(20))]),
  'ok rx20@F4:on_hold/1');
select pg_temp.expect('9a recorded for a route-backed item changed by DR (no consent at F4)',
  pg_temp.rows_of(pg_temp.routed_item_of(pg_temp.rx(20))) || ' DR''s session sees the item: '
  || pg_temp.dr_sees(pg_temp.routed_item_of(pg_temp.rx(20))), 'active>on_hold DR''s session sees the item: none');
select pg_temp.expect('R5b PH and PG at F1 read nothing for F4''s item',
  pg_temp.reads_as(2, array[pg_temp.routed_item_of(pg_temp.rx(20))]) || ' '
  || pg_temp.reads_as(3, array[pg_temp.routed_item_of(pg_temp.rx(20))]), 'none none');
select pg_temp.expect('R5c the route event order_changed_after_completion is still written',
  (select string_agg(event_row.event_type || ':' || event_row.reason_code, ' ' order by event_row.event_version)
     from ehr.order_route_events event_row
    where event_row.route_id = current_setting('changes.route_20')::uuid
      and event_row.event_type = 'order_changed_after_completion'),
  'order_changed_after_completion:order_changed');
-- Past the route's access_ends_at (moved back as replica, as the lifecycle
-- suites do), in a savepoint.
savepoint route_aged;
set local session_replication_role = replica;
update ehr.order_routes set access_ends_at = clock_timestamp() - interval '1 minute',
       writes_end_at = clock_timestamp() - interval '1 minute'
 where id = current_setting('changes.route_20')::uuid;
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(6);
select pg_temp.expect('R5d past access_ends_at (route moved in replica mode): P4 reads neither the item nor the notice',
  pg_temp.table_items(array[pg_temp.routed_item_of(pg_temp.rx(20))]) || ' '
  || pg_temp.notices(array[pg_temp.routed_item_of(pg_temp.rx(20))]), 'none none');
reset role;
rollback to savepoint route_aged;

-- 12. Reversals, and an own item sent elsewhere before its dispensing.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('fixtures: PH reverses rx21''s dispensing',
  pg_temp.try(pg_temp.reverse_sql(pg_temp.work_item_of(pg_temp.rx(21)), 2)), 'ok');
reset role;
select pg_temp.expect('12a dispensed, reversed, then cancelled: cancelled/1',
  pg_temp.dr(21, 'cancelled') || ' ' || pg_temp.ph_reads(array[21]), 'ok rx21:cancelled/1');
select pg_temp.expect('12b a hold between the dispensing and its reversal (the hold)', pg_temp.dr(22, 'on_hold'), 'ok');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('12b a hold between the dispensing and its reversal (the reversal)',
  pg_temp.try(pg_temp.reverse_sql(pg_temp.work_item_of(pg_temp.rx(22)), 2)), 'ok');
reset role;
select pg_temp.expect('12b a hold between the dispensing and its reversal stays shown after it',
  pg_temp.ph_reads(array[22]), 'rx22:on_hold/1');
-- rx23: sent to F1's pharmacy (D7, above), then sent to F4 before any
-- dispensing (the new ehr-api: 0133 D14 releases the own claim), accepted
-- and dispensed by P4; DR holds it.
set local role hid_ehr_api_runtime;
select pg_temp.expect('fixtures: DR sends rx23 to F4 after its automatic send', pg_temp.route_send(23), 'sent');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('fixtures: P4 accepts rx23''s route', pg_temp.route_accept(23), 'accepted');
select pg_temp.as_member(6);
select pg_temp.expect('fixtures: P4 dispenses rx23''s route-backed item',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.routed_item_of(pg_temp.rx(23)), 6)), 'ok');
reset role;
select pg_temp.expect('12c an own item released (sent elsewhere) before dispensing gets no row; the F4 item, dispensed, does',
  pg_temp.dr(23, 'on_hold') || ' own=' || pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(23))) || ' F4='
  || pg_temp.rows_of(pg_temp.routed_item_of(pg_temp.rx(23))) || ' '
  || pg_temp.reads_as(6, array[pg_temp.routed_item_of(pg_temp.rx(23))]),
  'ok own=none F4=active>on_hold rx23@F4:on_hold/1');

-- 6. Visibility. rx33, dispensed and held, carries two forged rows written
-- as the owner: one naming F2 for rx33's F1 item, one naming F1 for rx20's
-- F4 item (their facility is not their item's).
select pg_temp.expect('fixtures: DR holds rx33', pg_temp.dr(33, 'on_hold'), 'ok');
insert into pharmacy.prescription_changes_after_dispensing (work_item_id, facility_id, prescription_version,
  status_before, status_after, prior_content_sha256, content_sha256, changed_at)
values (pg_temp.work_item_of(pg_temp.rx(33)), 'e1480001-0000-4000-8000-000000000002', 50, 'on_hold', 'cancelled',
        '\x00', '\x00', clock_timestamp()),
       (pg_temp.routed_item_of(pg_temp.rx(20)), 'e1480001-0000-4000-8000-000000000001', 50, 'on_hold', 'cancelled',
        '\x00', '\x00', clock_timestamp());
-- The items with a shown change, own and route-backed (owner read).
create function pg_temp.shown_items() returns uuid[] language sql security definer as $f$
  select array(select pg_temp.work_item_of(pg_temp.rx(n)) from unnest(array[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
                 16, 17, 18, 19, 21, 22, 33]) n)
         || array[pg_temp.routed_item_of(pg_temp.rx(20)), pg_temp.routed_item_of(pg_temp.rx(23))]
$f$;
grant execute on function pg_temp.shown_items() to public;
-- For each session: the reader's items, the items the same session selects
-- from pharmacy.work_items, and the two compared (kept for case 9).
create temporary table changes_visibility (session_name text primary key, reader text, from_table text) on commit drop;
grant select, insert on changes_visibility to public;
create function pg_temp.visibility(label text) returns text language plpgsql as $f$
declare
  reader_answer text := pg_temp.reader_items(pg_temp.shown_items());
  table_answer text := pg_temp.table_items(pg_temp.shown_items());
begin
  insert into changes_visibility values (label, reader_answer, table_answer);
  return reader_answer || ' | ' || table_answer;
end
$f$;
grant execute on function pg_temp.visibility(text) to public;
create function pg_temp.equal_halves(answer text) returns text language sql immutable as $f$
  select case when split_part(answer, ' | ', 1) = split_part(answer, ' | ', 2) then 'equal' else answer end
$f$;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('6a PH: the reader''s items equal the items PH selects from pharmacy.work_items',
  pg_temp.equal_halves(pg_temp.visibility('PH')), 'equal');
select pg_temp.as_member(3);
select pg_temp.expect('6a PG: the reader''s items equal the items PG selects from pharmacy.work_items',
  pg_temp.equal_halves(pg_temp.visibility('PG')), 'equal');
select pg_temp.as_member(5);
select pg_temp.expect('6a PX at F2: the reader''s items equal the items PX selects from pharmacy.work_items',
  pg_temp.equal_halves(pg_temp.visibility('PX at F2')), 'equal');
select pg_temp.as_member(5, 1);
select pg_temp.expect('6a PX claiming F1: the reader''s items equal the items PX selects from pharmacy.work_items',
  pg_temp.equal_halves(pg_temp.visibility('PX claiming F1')), 'equal');
select pg_temp.as_member(6);
select pg_temp.expect('6a P4: the reader''s items equal the items P4 selects from pharmacy.work_items',
  pg_temp.equal_halves(pg_temp.visibility('P4')), 'equal');
select pg_temp.as_member(3, purpose => 'emergency');
select pg_temp.expect('6a an emergency session (PG): the reader''s items equal the items it selects',
  pg_temp.equal_halves(pg_temp.visibility('PG emergency')), 'equal');
select pg_temp.as_member(2, switched => false);
select pg_temp.expect('6a a session without the own-work switch (PH, today''s pharmacy-api): equal',
  pg_temp.equal_halves(pg_temp.visibility('PH without the switch')), 'equal');
select pg_temp.as_member(2);
select set_config('app.facility_id', '', true);
select pg_temp.expect('6a a session with no facility (PH): equal',
  pg_temp.equal_halves(pg_temp.visibility('PH without a facility')), 'equal');
reset role;
-- A deny directive of Ada's against PH (staff, at F1), as replica, in a
-- savepoint; its case 9 answer is checked here too (the savepoint's
-- rollback undoes everything written in it).
savepoint deny_directive;
set local session_replication_role = replica;
insert into identity.consent_directives (id, patient_id) values
  ('e1480009-0000-4000-8000-000000000001', 'e1480006-0000-4000-8000-000000000001');
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, grantee_id, facility_id, starts_at, source_reference, reason, content_sha256)
values (gen_random_uuid(), 'e1480009-0000-4000-8000-000000000001', 'e1480006-0000-4000-8000-000000000001', 1, 'active',
  'deny', 'staff', 'e1480003-0000-4000-8000-000000000002', 'e1480001-0000-4000-8000-000000000001',
  clock_timestamp() - interval '1 minute', 'changes-suite', 'Synthetic deny directive', repeat('a', 64));
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select set_config('changes.deny_answer', pg_temp.visibility('PH with Ada''s deny directive'), true);
select pg_temp.expect('6a a member with a deny directive (PH, Ada''s): equal',
  pg_temp.equal_halves(current_setting('changes.deny_answer')), 'equal');
select pg_temp.expect('9c the reader''s visibility equals case 6 (PH with Ada''s deny directive: Bisi''s items only)',
  current_setting('changes.deny_answer'), 'rx13 rx16 rx17 rx18 rx19 | rx13 rx16 rx17 rx18 rx19');
reset role;
rollback to savepoint deny_directive;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(4);
select pg_temp.expect('6b CW (consent, no pharmacy.work-item.read): the reader answers nothing while pharmacy.work_items shows the row',
  pg_temp.reader_items(pg_temp.shown_items()) || ' | '
  || (select count(*) from pharmacy.work_items item where item.id = any(pg_temp.shown_items())),
  'none | 19');
select pg_temp.as_member(7);
select set_config('changes.ls_answer', pg_temp.reader_items(pg_temp.shown_items()), true);
select pg_temp.as_member(1);
select pg_temp.expect('6c LS and DR: nothing',
  current_setting('changes.ls_answer') || ' ' || pg_temp.reader_items(pg_temp.shown_items()) || ' (DR selects '
  || (select count(*) from pharmacy.work_items item where item.id = any(pg_temp.shown_items())) || ' of the items)',
  'none none (DR selects 19 of the items)');
select pg_temp.as_member(2);
select pg_temp.expect('6d 201 ids and null: 22023 WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID',
  pg_temp.try(format('select * from pharmacy.work_item_changes_after_dispensing(%L::uuid[])',
    array(select gen_random_uuid() from generate_series(1, 201))::text)) || ' / '
  || pg_temp.try('select * from pharmacy.work_item_changes_after_dispensing(null)'),
  '22023 WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID / 22023 WORK_ITEM_CHANGES_AFTER_DISPENSING_INVALID');
select pg_temp.expect('6d 200 ids are answered (the two it knows)',
  (select count(*)::text from pharmacy.work_item_changes_after_dispensing(
     array[pg_temp.work_item_of(pg_temp.rx(2)), pg_temp.work_item_of(pg_temp.rx(3))]
     || array(select gen_random_uuid() from generate_series(1, 198)))), '2');
select set_config('changes.empty_answer', pg_temp.notices(array[]::uuid[]), true);
select set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
       set_config('app.actor_subject', '', true);
select pg_temp.expect('6e an empty array and no session: nothing',
  current_setting('changes.empty_answer') || ' ' || pg_temp.notices(pg_temp.shown_items()), 'none none');
select pg_temp.as_member(2);
select pg_temp.expect('6f the Pharmacy runtime cannot select, insert, update or delete the table',
  left(pg_temp.try('select count(*) from pharmacy.prescription_changes_after_dispensing'), 5) || ' '
  || left(pg_temp.try(format($s$insert into pharmacy.prescription_changes_after_dispensing values (%L, %L, 9, 'active',
       'cancelled', '\x00', '\x00', clock_timestamp())$s$, pg_temp.work_item_of(pg_temp.rx(2)),
       'e1480001-0000-4000-8000-000000000001')), 5) || ' '
  || left(pg_temp.try('update pharmacy.prescription_changes_after_dispensing set status_after = ''active'''), 5) || ' '
  || left(pg_temp.try('delete from pharmacy.prescription_changes_after_dispensing'), 5), '42501 42501 42501 42501');
reset role;
select pg_temp.expect('6g a forged owner-written row whose facility is not its work item''s: not answered',
  pg_temp.ph_reads(array[33]) || ' ' || pg_temp.reads_as(2, array[pg_temp.routed_item_of(pg_temp.rx(20))]) || ' '
  || pg_temp.reads_as(6, array[pg_temp.routed_item_of(pg_temp.rx(20))]), 'rx33:on_hold/1 none rx20@F4:on_hold/1');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('6f the EHR runtime cannot execute the reader (42501)',
  left(pg_temp.try('select count(*) from pharmacy.work_item_changes_after_dispensing(array[]::uuid[])'), 5), '42501');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_member(7);
select pg_temp.expect('6f the Lab runtime cannot execute the reader (42501)',
  left(pg_temp.try('select count(*) from pharmacy.work_item_changes_after_dispensing(array[]::uuid[])'), 5), '42501');
reset role;

-- 9. Both owner kinds. This suite runs on a database whose owner is a
-- superuser (the container acceptance cluster) and on one whose owner has
-- neither superuser nor BYPASSRLS (the RDS-like rehearsal), and branches
-- only where PostgreSQL itself answers differently, as the 0144 suite does.
-- 9a (above): DR's change of rx20 is recorded for F4's item although DR's
-- session sees no F4 row, because the trigger reads only 0133's claims
-- (row-level security on, not forced: never filtered for their owner).
-- 9b: an own item changed in a session that holds no consent (rx29, the
-- owner's UPDATE in LS's session, a member at F1 with no grant who can see
-- no pharmacy row). Under a superuser or BYPASSRLS owner the change goes
-- through and is recorded, from the claims, which no session's policies
-- filter. Under an owner with neither, ehr.capture_record_version (BEFORE
-- UPDATE, run as that owner) cannot write the version row
-- (ehr.record_versions' forced row-level security asks the session's
-- consent), so no session without consent can change a prescription at all
-- and there is nothing to record; DR's changes, recorded in cases 2 to 5
-- under both, are the ones that happen. 9c: case 6's answers as fixed
-- strings, the same under both.
select pg_temp.as_member(7);
select set_config('app.change_reason', 'Changed in a session without consent', true);
select set_config('changes.outcome', pg_temp.try($s$update ehr.prescriptions set frequency = 'Every 12 hours'
  where id = 'e1480007-0000-4000-8000-000000000029'$s$), true);
select pg_temp.expect('9b recorded for an own item whose prescriber has no consent',
  current_setting('changes.outcome') || ' ' || pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(29)))
  || ' LS selects the item: ' || pg_temp.table_items_as(7, array[pg_temp.work_item_of(pg_temp.rx(29))]),
  case when pg_temp.owner_bypasses() then 'ok active>active LS selects the item: none'
       else '42501 new row violates row-level security policy for table "record_versions" none LS selects the item: '
         || 'none' end);
select 'case 9 ran with an owner that ' || case when pg_temp.owner_bypasses() then 'is a superuser or has BYPASSRLS'
         else 'has neither superuser nor BYPASSRLS' end as owner_kind;
select pg_temp.expect('9c the reader''s visibility equals case 6',
  (select string_agg(session_name || ': ' || reader || (case when reader = from_table then '' else ' <> ' || from_table end),
            ' ; ' order by session_name collate "C") from changes_visibility),
  'P4: rx20@F4 rx23@F4 ; PG: rx2 rx3 rx4 rx5 rx6 rx7 rx8 rx9 rx10 rx11 rx12 rx13 rx16 rx17 rx18 rx19 rx21 rx22 rx33 ; '
  || 'PG emergency: none ; PH: rx2 rx3 rx4 rx5 rx6 rx7 rx8 rx9 rx10 rx11 rx12 rx13 rx16 rx17 rx18 rx19 rx21 rx22 rx33 ; '
  || 'PH without a facility: none ; '
  || 'PH without the switch: none ; PX at F2: none ; PX claiming F1: none');

-- 5 (end). DR enters rx20 in error: 0086 closes the route at once, so P4
-- (no grant) reads nothing; PF, an F4 pharmacist with a consent grant for
-- Ada at F4, reads it. Then Ada has her own pharmacy work at F4 (an own
-- item there, as replica): P4's own-work session still never reads the
-- route-backed item (0133's own-work basis covers own items only), while it
-- does select her own item there (rx99, a prescription of F4's own).
select pg_temp.expect('R5e DR enters it in error: the route closes, P4 without a grant reads nothing, an F4 member with a grant reads entered_in_error/2',
  pg_temp.dr(20, 'entered_in_error') || ' route='
  || (select route.state || '/access ended=' || (route.access_ends_at <= clock_timestamp())
        from pg_temp.route_row(20) route) || ' P4='
  || pg_temp.reads_as(6, array[pg_temp.routed_item_of(pg_temp.rx(20))]) || ' PF='
  || pg_temp.reads_as(8, array[pg_temp.routed_item_of(pg_temp.rx(20))]),
  'ok route=completed/access ended=true P4=none PF=rx20@F4:entered_in_error/2');
set local session_replication_role = replica;
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, medication_display, frequency, instructions,
  prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key,
  request_sha256, correlation_id)
values ('e148000a-0000-4000-8000-000000000001', 'e1480006-0000-4000-8000-000000000001',
  'e1480001-0000-4000-8000-000000000004', 'e1480001-0000-4000-8000-000000000004', pg_temp.rx(99), 1,
  gen_random_uuid(), 'active', 'Paracetamol 500 mg tablet', 'Every 6 hours', 'Take with water',
  pg_temp.account(6), clock_timestamp(), pg_temp.account(6), pg_temp.membership(6), 'Handed in at the pharmacy counter',
  'changes-f4-own-item-0001', repeat('b', 64), 'changes-f4-own-item');
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(6);
select pg_temp.expect('R5f an own-work session at the receiving facility never reads a route-backed item''s notice',
  pg_temp.table_items(array['e148000a-0000-4000-8000-000000000001'::uuid]) || ' '
  || pg_temp.table_items(array[pg_temp.routed_item_of(pg_temp.rx(20))]) || ' '
  || pg_temp.notices(array[pg_temp.routed_item_of(pg_temp.rx(20))]), 'rx99 none none');
reset role;

-- 7. Never refuses, through the EHR runtime with ehr-api's change. N1:
-- every transition ehr-api allows (TRANSITIONS, prescriptions.service.ts),
-- from active and from on hold, on the dispensed rx24, each in a savepoint.
create temporary table changes_transitions (transition text primary key, outcome text) on commit drop;
grant select, insert on changes_transitions to public;
create function pg_temp.kept_transition(from_status text, to_status text) returns text language plpgsql as $f$
declare outcome text;
begin
  begin
    if from_status = 'on_hold' then
      outcome := pg_temp.dr(24, 'on_hold') || '+';
    else
      outcome := '';
    end if;
    outcome := outcome || pg_temp.dr(24, to_status) || ' ' || pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(24)));
    raise exception using errcode = 'P0001', message = 'undo', detail = outcome;
  exception when raise_exception then
    get stacked diagnostics outcome = pg_exception_detail;
  end;
  return outcome;
end
$f$;
select pg_temp.expect('N1 every transition of TRANSITIONS on a dispensed prescription goes through',
  (select string_agg(transition.from_status || '>' || transition.to_status || ': '
            || pg_temp.kept_transition(transition.from_status, transition.to_status), ' ; ')
     from (values ('active', 'on_hold'), ('active', 'completed'), ('active', 'cancelled'), ('active', 'entered_in_error'),
                  ('on_hold', 'active'), ('on_hold', 'cancelled'), ('on_hold', 'entered_in_error'))
          transition(from_status, to_status)),
  'active>on_hold: ok active>on_hold ; active>completed: ok active>completed ; active>cancelled: ok active>cancelled ; '
  || 'active>entered_in_error: ok active>entered_in_error ; on_hold>active: ok+ok active>on_hold on_hold>active ; '
  || 'on_hold>cancelled: ok+ok active>on_hold on_hold>cancelled ; '
  || 'on_hold>entered_in_error: ok+ok active>on_hold on_hold>entered_in_error');
-- N2: a row already at the next version (written as the owner before the
-- change) is kept, and the change goes through.
insert into pharmacy.prescription_changes_after_dispensing (work_item_id, facility_id, prescription_version,
  status_before, status_after, prior_content_sha256, content_sha256, changed_at)
values (pg_temp.work_item_of(pg_temp.rx(25)), 'e1480001-0000-4000-8000-000000000001',
        (pg_temp.current_rx(25)).row_version + 1, 'active', 'active', '\x01', '\x02', timestamptz '2026-01-01 00:00Z');
select set_config('changes.outcome', pg_temp.dr(25, 'on_hold'), true);
select pg_temp.expect('N2 a row already at the next version (inserted as owner) is kept and the change goes through',
  current_setting('changes.outcome') || ' '
  || (select string_agg(change_row.status_before || '>' || change_row.status_after || '@' || change_row.changed_at::date,
            ' ') from pharmacy.prescription_changes_after_dispensing change_row
       where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(25))) || ' '
  || (pg_temp.current_rx(25)).status, 'ok active>active@2026-01-01 on_hold');
-- N3: the order-route send of the draft rx26 activates it (0123/0133's
-- send_order_route): it goes through and records nothing.
set local role hid_ehr_api_runtime;
select pg_temp.expect('N3 ehr.send_order_route activating a draft: ok, no row',
  pg_temp.route_send(26) || ' ' || (pg_temp.current_rx(26)).status, 'sent active');
reset role;
select pg_temp.expect('N3 nothing recorded for rx26''s items',
  (select count(*)::text from pharmacy.prescription_changes_after_dispensing change_row
    join pharmacy.work_items item on item.id = change_row.work_item_id
   where item.source_ehr_prescription_id = pg_temp.rx(26)), '0');
-- N4: a change in replica mode (no ehr.record_versions row either).
set local session_replication_role = replica;
update ehr.prescriptions set status = 'on_hold', row_version = row_version + 1 where id = pg_temp.rx(27);
set local session_replication_role = origin;
select pg_temp.expect('N4 a change in replica mode: ok, no row',
  (pg_temp.current_rx(27)).status || ' ' || pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(27))), 'on_hold none');
-- N5: the owner changes a 0125 column (quantity_to_dispense) in DR's
-- session, as an owner-only repair would.
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Corrected the quantity', true);
update ehr.prescriptions set quantity_to_dispense = 42, quantity_unit = 'capsule' where id = pg_temp.rx(28);
select pg_temp.expect('N5 an owner UPDATE of a 0125 column after dispensing: ok, edited',
  pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(28))) || ' ' || pg_temp.ph_reads(array[28]),
  'active>active rx28:edited/1');
-- N6: a status this file does not know, with ehr.prescriptions' CHECK
-- widened in a savepoint: the change goes through, is recorded, and is not
-- shown.
savepoint unknown_status;
alter table ehr.prescriptions drop constraint prescriptions_status_check,
  add constraint prescriptions_status_check check (status in ('draft', 'active', 'on_hold', 'completed', 'cancelled',
    'entered_in_error', 'suspended'));
select pg_temp.expect('N6 a status this file does not know (CHECK widened in a savepoint): ok, recorded, not shown',
  pg_temp.dr(30, 'suspended') || ' ' || pg_temp.rows_of(pg_temp.work_item_of(pg_temp.rx(30))) || ' '
  || pg_temp.ph_reads(array[30]), 'ok active>suspended none');
rollback to savepoint unknown_status;

-- 8. Release A's shapes. What 0133's two readers, 0144's steps reader (when
-- 0144 is applied) and pharmacy-api's 0133 list (WORK_LIST_QUERY_0133, its
-- exact text at c839f61f, done work since 1 January 2026) answer for PH,
-- now and again with 0148 undone in its header's order (in a savepoint):
-- the same, for items dispensed and changed after (rx2, rx3, rx22 reversed),
-- held before any dispensing (rx1), handed in (rx19) and sent elsewhere
-- (rx23).
create function pg_temp.release_a_answers() returns text language plpgsql as $f$
declare
  items uuid[] := array(select pg_temp.work_item_of(pg_temp.rx(n)) from unnest(array[1, 2, 3, 19, 22, 23]) n);
  states text;
  withdrawn_items text;
  steps text := 'no 0144';
  listed text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  select string_agg(format('%s:%s/%s/%s', pg_temp.name_of(state.work_item_id), state.basis, state.withdrawn,
           coalesce(state.withdrawn_reason, '-')), ' ' order by pg_temp.name_of(state.work_item_id) collate "C")
    into states from pharmacy.own_work_item_states(items) state;
  select coalesce(string_agg(format('%s:%s', pg_temp.name_of(withdrawn.work_item_id), withdrawn.withdrawn_reason), ' '
           order by pg_temp.name_of(withdrawn.work_item_id) collate "C"), 'none')
    into withdrawn_items from pharmacy.own_withdrawn_work_items() withdrawn where withdrawn.work_item_id = any(items);
  if to_regprocedure('pharmacy.own_work_item_steps(uuid[])') is not null then
    execute 'select string_agg(format(''%s:%s/%s/%s/%s'', pg_temp.name_of(step.work_item_id), step.basis, step.withdrawn,
               step.sent_automatically, coalesce(step.accepted_with, ''-'')), '' ''
               order by pg_temp.name_of(step.work_item_id) collate "C")
          from pharmacy.own_work_item_steps($1) step' into steps using items;
  end if;
  execute 'select md5(string_agg(format(''%s/%s/%s'', listed.id, listed.dispensing_id, listed.reversal_id), '' ''))
             from (with withdrawn as materialized (select x.work_item_id, x.withdrawn_reason
    from pharmacy.own_withdrawn_work_items() x)
  select w.*,d.id::text as dispensing_id,d.status as dispensing_status,
  r.id::text as reversal_id from pharmacy.work_items w
  left join pharmacy.dispensings d on d.work_item_id=w.id
  left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id
  left join withdrawn x on x.work_item_id=w.id and w.order_route_id is null
  cross join lateral (select d.id is null and x.work_item_id is null as open_work) o
  where x.withdrawn_reason is distinct from ''sent_elsewhere''
    and (o.open_work or w.accepted_at >= ($1::date::timestamp at time zone ''Africa/Lagos''))
  order by o.open_work desc,case when o.open_work then w.accepted_at end asc,case when o.open_work then null else w.accepted_at end desc,
  case when o.open_work then w.id end asc,case when o.open_work then null else w.id end desc limit 200) listed'
    into listed using '2026-01-01';
  reset role;
  return 'states=' || states || ' | withdrawn=' || withdrawn_items || ' | steps=' || steps || ' | list=' || listed;
end
$f$;
grant execute on function pg_temp.release_a_answers() to public;
select set_config('changes.release_a', pg_temp.release_a_answers(), false);
select pg_temp.expect('8a own_work_item_states, own_withdrawn_work_items and own_work_item_steps answer as before for dispensed and changed items',
  split_part(current_setting('changes.release_a'), ' | list=', 1),
  'states=rx1:own-work/t/changed rx19:own-work/f/- rx2:own-work/f/- rx22:own-work/f/- '
  || 'rx23:own-work/t/sent_elsewhere rx3:own-work/f/- | withdrawn=rx1:changed rx23:sent_elsewhere | steps='
  || case when to_regprocedure('pharmacy.own_work_item_steps(uuid[])') is null then 'no 0144'
          else 'rx1:own-work/t/t/- rx19:own-work/f/f/- rx2:own-work/f/t/- '
            || 'rx22:own-work/f/t/- rx23:own-work/t/t/- rx3:own-work/f/t/-' end);
-- 8b: D8 (it fires before 0148's trigger, by name) marks the automatic send
-- withdrawn at the first change only: its time is before the first
-- recorded change's, and later changes do not move it.
select pg_temp.expect('8b 0133 D8 still marks the send once',
  (select string_agg(pg_temp.name_of(send.work_item_id) || ':' || (send.withdrawn_at is not null)
            || '/' || (send.withdrawn_at < (select min(change_row.changed_at)
                                              from pharmacy.prescription_changes_after_dispensing change_row
                                             where change_row.work_item_id = send.work_item_id)), ' '
            order by pg_temp.name_of(send.work_item_id) collate "C")
     from pharmacy.own_prescription_sends send
    where send.prescription_id in (pg_temp.rx(8), pg_temp.rx(16), pg_temp.rx(18))),
  'rx16:true/true rx18:true/true rx8:true/true');
savepoint release_a_undone;
drop trigger prescriptions_pharmacy_change_after_dispensing on ehr.prescriptions;
drop function pharmacy.work_item_changes_after_dispensing(uuid[]);
drop function pharmacy.prescription_change_after_dispensing();
drop table pharmacy.prescription_changes_after_dispensing;
select pg_temp.expect('8c WORK_LIST_QUERY_0133 answers as before (and 8a''s readers: the same answers with 0148 undone)',
  pg_temp.release_a_answers(), current_setting('changes.release_a'));
rollback to savepoint release_a_undone;

-- 11. The fingerprint. 11a: two changes of nothing to rx31 (ehr-api raises
-- the version), the first under DateStyle ISO, MDY and Africa/Lagos, the
-- second under SQL, DMY and UTC: every fingerprint is the same.
set local datestyle = 'ISO, MDY';
set local timezone = 'Africa/Lagos';
select pg_temp.expect('11a the first change under ISO, MDY and Africa/Lagos', pg_temp.dr(31, new_frequency => 'Every 8 hours'), 'ok');
set local datestyle = 'SQL, DMY';
set local timezone = 'UTC';
select set_config('changes.outcome', pg_temp.dr(31, new_frequency => 'Every 8 hours'), true);
select pg_temp.expect('11a the same digest under DateStyle ISO, MDY and SQL, DMY and TimeZone Africa/Lagos and UTC',
  current_setting('changes.outcome') || ' '
  || (select count(distinct digest)::text || '/' || count(*)
        from pharmacy.prescription_changes_after_dispensing change_row,
             unnest(array[change_row.prior_content_sha256, change_row.content_sha256]) digest
       where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(31))), 'ok 1/4');
set local datestyle = 'ISO, MDY';
set local timezone = 'UTC';
-- 11b: a nullable column added (in a savepoint): a later change of nothing
-- keeps the same fingerprint.
savepoint new_column;
alter table ehr.prescriptions add column changes_suite_note text;
select set_config('changes.outcome', pg_temp.dr(31, new_frequency => 'Every 8 hours'), true);
select pg_temp.expect('11b a nullable column added in a savepoint leaves existing digests unchanged',
  current_setting('changes.outcome') || ' '
  || (select count(distinct digest)::text || '/' || count(*)
        from pharmacy.prescription_changes_after_dispensing change_row,
             unnest(array[change_row.prior_content_sha256, change_row.content_sha256]) digest
       where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(31))), 'ok 1/6');
rollback to savepoint new_column;
-- 11c: on rx32, the owner moves created_at (DR's session), DR holds it and
-- resumes it (status, version and updated_at change): one fingerprint; then
-- the owner changes a 0125 value: another.
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Corrected the record time', true);
update ehr.prescriptions set created_at = created_at - interval '1 hour' where id = pg_temp.rx(32);
select pg_temp.expect('11c the status, version and time changes',
  pg_temp.dr(32, 'on_hold') || ' ' || pg_temp.dr(32, 'active'), 'ok ok');
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Corrected the strength', true);
update ehr.prescriptions set medication_strength = '500 mg' where id = pg_temp.rx(32);
select pg_temp.expect('11c a changed 0125 value changes it; status, row_version and the two times do not',
  (select string_agg(change_row.status_before || '>' || change_row.status_after || ':'
            || (change_row.prior_content_sha256 = change_row.content_sha256), ' ' order by change_row.prescription_version)
     from pharmacy.prescription_changes_after_dispensing change_row
    where change_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(32))),
  'active>active:true active>on_hold:true on_hold>active:true active>active:false');

-- 10. The undo order of the header, each in a savepoint. 10a: the table
-- dropped while the trigger stands (plpgsql records no dependency): every
-- change of an active or held prescription fails, for every image.
savepoint undo_table_first;
drop table pharmacy.prescription_changes_after_dispensing;
select pg_temp.expect('10a the table dropped with the trigger in place: a hold of an active prescription fails 42P01',
  pg_temp.dr(34, 'on_hold'), '42P01 relation "pharmacy.prescription_changes_after_dispensing" does not exist');
rollback to savepoint undo_table_first;
savepoint undo_trigger_first;
drop trigger prescriptions_pharmacy_change_after_dispensing on ehr.prescriptions;
drop table pharmacy.prescription_changes_after_dispensing;
select pg_temp.expect('10b the trigger dropped first: the change goes through', pg_temp.dr(34, 'on_hold'), 'ok');
rollback to savepoint undo_trigger_first;
savepoint undo_header_order;
drop trigger prescriptions_pharmacy_change_after_dispensing on ehr.prescriptions;
drop function pharmacy.work_item_changes_after_dispensing(uuid[]);
drop function pharmacy.prescription_change_after_dispensing();
drop table pharmacy.prescription_changes_after_dispensing;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select set_config('changes.undo_reader', left(pg_temp.try('select * from pharmacy.work_item_changes_after_dispensing('
  || quote_literal(array[pg_temp.work_item_of(pg_temp.rx(2))]::text) || '::uuid[])'), 5), true);
reset role;
select pg_temp.expect('10c the header''s order in full: the Pharmacy runtime gets 42883 from the reader, changes go through, 0133''s claims and D8 untouched',
  current_setting('changes.undo_reader') || ' ' || pg_temp.dr(34, 'on_hold') || ' ' || pg_temp.dr(34, 'active') || ' '
  || (to_regclass('pharmacy.prescription_item_claims') is not null)::text || ' '
  || (select count(*) from pg_trigger trigger_row where trigger_row.tgenabled = 'A'
        and trigger_row.tgname in ('work_items_claim_prescription', 'dispensings_claim_prescription')) || ' '
  || (select count(*) from pg_trigger trigger_row where trigger_row.tgrelid = 'ehr.prescriptions'::regclass
        and trigger_row.tgname = 'prescriptions_own_pharmacy_send_withdrawn' and trigger_row.tgenabled = 'O'),
  '42883 ok ok true 2 1');
rollback to savepoint undo_header_order;
savepoint undo_disabled;
alter table ehr.prescriptions disable trigger prescriptions_pharmacy_change_after_dispensing;
drop function pharmacy.work_item_changes_after_dispensing(uuid[]);
drop table pharmacy.prescription_changes_after_dispensing;
select pg_temp.expect('10d the trigger disabled, the reader and the table dropped: changes go through',
  pg_temp.dr(34, 'on_hold') || ' ' || pg_temp.dr(34, 'active'), 'ok ok');
rollback to savepoint undo_disabled;

-- 13. The oracle, over every row this suite wrote (owner-written ones
-- included): each recorded version is above its work item's version, so no
-- row is ever a change the pharmacy dispensed from.
select pg_temp.expect('13 every recorded row''s prescription_version is above its work item''s source_ehr_prescription_version',
  (select count(*) filter (where change_row.prescription_version <= item.source_ehr_prescription_version)::text || '/'
          || (count(*) > 40)::text
     from pharmacy.prescription_changes_after_dispensing change_row
     join pharmacy.work_items item on item.id = change_row.work_item_id), '0/true');

rollback;
