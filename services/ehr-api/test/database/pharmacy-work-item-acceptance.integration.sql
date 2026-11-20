\set ON_ERROR_STOP on
-- 0147 (ORD-4 of the Akos EHR plan; owner decision Q125 B, 19 November
-- 2026): a pharmacist accepts a prescription that was sent to this hospital's
-- own pharmacy by itself (0133 D7) before dispensing it, and the work item's
-- history and the steps reader say so.
-- Rollback-only. Through the exact runtime roles the services use
-- (hid_ehr_api_runtime, hid_pharmacy_api_runtime), in the session the services
-- set (the new images also set app.own_facility_work to '0133', 0133 D13).
-- Cases:
--   1. structure: pharmacy.work_item_acceptances' columns, keys and CHECKs,
--      row-level security enabled and forced, the four policies (the two
--      consent policies and the two own-work policies exactly as
--      pharmacy.dispensings' are, for this table), SELECT and INSERT only, to
--      the Pharmacy and schema test runtimes only, the two triggers (the
--      insert validator, and 0023's immutability function); the insert
--      trigger function owned by pharmacy.validate_dispensing()'s owner (the
--      role 0133 D5's ehr.prescriptions policies name), SECURITY DEFINER,
--      VOLATILE, its search_path, executed by no role; the steps reader
--      SECURITY DEFINER, STABLE, its search_path, executed by the Pharmacy and
--      schema test runtimes only; the replaced event validator keeps the
--      attributes pharmacy-session-guards pins and its ACL; the event
--      table's two CHECKs widened and validated; the bodies (md5);
--   2. PH, a pharmacist with no consent grant and the own-work switch set,
--      accepts DR's automatically sent rx1: one acceptance row, then one
--      pharmacist_accepted event of version 2 (pharmacy-api's two
--      statements); PH reads both back; the steps reader says accepted, by PH,
--      with 'accept'; PG, a pharmacist with a grant, accepts rx12 on the
--      consent basis; PH dispenses rx1 after its acceptance;
--   3. a second acceptance: by PG, by PH with another key, and PH's key again
--      on another item, each 23505; a second pharmacist_accepted event 23505;
--   4. refusals (23514 unless said): rx2 held and rx3 edited (DETAIL
--      changed), rx4 sent to an outside pharmacy (sent_elsewhere), rx5
--      dispensed with no acceptance (not_claimed), rx8 completed and rx9 at
--      another version than the item's (no DETAIL: 0101's check), rx7's
--      route-backed item at F4 (PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY /
--      order_route), rx6 handed in by hand (hand_off), another facility's
--      pharmacist (at F2, and claiming F1), an emergency session, a row naming
--      another member, or only another member's account or membership,
--      another patient than its item's (PG, whose grants cover both) or
--      another facility than its item's, an unknown work item, today's
--      pharmacy-api (no switch: the policies refuse rx11 under a superuser or
--      BYPASSRLS owner, the trigger under any other, and the trigger answers
--      a held item's step only under the former); the events: another actor
--      than the acceptance's, no acceptance, another reason, the wrong pair of
--      type and version, and, before PG's own event for rx12, PG's event
--      written in PH's session, another patient or facility than the
--      acceptance's, and sessions whose account and membership are two
--      members' (each of the validator's binding clauses alone); UPDATE and
--      DELETE (no privilege; and 0023's immutability for the owner);
--   5. Release A's shapes still pass: 0133 D7's send (a prescription_accepted
--      event of version 1), pharmacy-api's hand-in (its event of version 1),
--      0086's route acceptance (its event of version 1), a dispensing with no
--      acceptance; 0077's refusals of a version 1 event unchanged;
--   6. a dispensing of a received item accepts it first, in its own
--      transaction (accepted_with 'dispensing', the dispensing's key and
--      digest), then dispenses it;
--   7. the steps reader, for PH (own-work) and DR (the consenting doctor):
--      received, accepted (accept or dispensing), hand_off (not sent
--      automatically), withdrawn and why, dispensed; its first four columns
--      exactly pharmacy.own_work_item_states'; nothing for F2's pharmacist (at
--      F2, and claiming F1), nothing for F4's route-backed item; without a
--      session nothing; 201 ids and a null array refused with 22023; a hold
--      after an acceptance reads withdrawn and keeps the acceptance.
-- Fixtures inserted as the suite runner with session_replication_role =
-- replica where the services would not write them (identity rows, the
-- outside pharmacy's approval). Synthetic values only; uuid prefix e147.
set plpgsql.variable_conflict = error;
begin;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception 'pharmacist acceptance: %: got [%], want [%]', label, got, want;
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
-- The outcome with the error's DETAIL: 'ok', or 'SQLSTATE message / detail'.
create function pg_temp.try_detail(statement text) returns text language plpgsql as $f$
declare failure_detail text;
begin
  execute statement;
  return 'ok';
exception when others then
  get stacked diagnostics failure_detail = pg_exception_detail;
  return sqlstate || ' ' || sqlerrm || ' / ' || coalesce(nullif(failure_detail, ''), '-');
end
$f$;

-- 1. Structure.
do $$
declare
  mismatch text;
  owner_oid oid := (select relowner from pg_class where oid = 'pharmacy.work_items'::regclass);
  validator_owner oid := (select proowner from pg_proc where oid = 'pharmacy.validate_dispensing()'::regprocedure);
begin
  -- The table: its columns, keys and CHECKs, the owner's, row-level security
  -- enabled and forced.
  if (select string_agg(attribute.attname || ' ' || format_type(attribute.atttypid, attribute.atttypmod)
            || case when attribute.attnotnull then ' not null' else '' end, ', ' order by attribute.attnum)
        from pg_attribute attribute
       where attribute.attrelid = 'pharmacy.work_item_acceptances'::regclass and attribute.attnum > 0
         and not attribute.attisdropped)
     is distinct from 'id uuid not null, work_item_id uuid not null, patient_id uuid not null, facility_id uuid not null, '
       || 'accepted_by uuid not null, accepted_by_membership_id uuid not null, accepted_at timestamp with time zone '
       || 'not null, accepted_with text not null, idempotency_key text not null, request_sha256 character(64) not null, '
       || 'correlation_id text not null'
     or (select string_agg(pg_get_constraintdef(constraint_row.oid), '; '
                  order by pg_get_constraintdef(constraint_row.oid) collate "C")
           from pg_constraint constraint_row
          where constraint_row.conrelid = 'pharmacy.work_item_acceptances'::regclass and constraint_row.convalidated)
        is distinct from 'CHECK (((length(correlation_id) >= 8) AND (length(correlation_id) <= 128))); '
          || 'CHECK ((accepted_with = ANY (ARRAY[''accept''::text, ''dispensing''::text]))); '
          || 'CHECK ((idempotency_key ~ ''^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$''::text)); '
          || 'CHECK ((request_sha256 ~ ''^[0-9a-f]{64}$''::text)); PRIMARY KEY (id); '
          || 'UNIQUE (facility_id, accepted_by, idempotency_key); UNIQUE (work_item_id)'
     or exists (select 1 from pg_constraint constraint_row
                 where constraint_row.conrelid = 'pharmacy.work_item_acceptances'::regclass and constraint_row.contype = 'f')
     or (select relation.relowner = owner_oid and relation.relrowsecurity and relation.relforcerowsecurity
           from pg_class relation where relation.oid = 'pharmacy.work_item_acceptances'::regclass) is not true then
    raise exception 'pharmacist acceptance: the table is not 0147''s (columns, keys, CHECKs, no foreign key, owner, forced row-level security)';
  end if;
  -- The four policies: pharmacy.dispensings' four, for this table (the
  -- consent policies with this table's names, the own-work policies in
  -- 0133's exact form for a row anchored on its work item).
  select string_agg(coalesce(mine.polname, '-') || ' vs ' || coalesce(theirs.polname, '-'), '; ') into mismatch
    from (select replace(policy_row.polname, 'dispensings', 'work_item_acceptances') as polname, policy_row.polcmd,
                 replace(coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-'), 'dispensings.',
                   'work_item_acceptances.') as qual,
                 replace(coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '-'), 'dispensings.',
                   'work_item_acceptances.') as with_check, policy_row.polpermissive, policy_row.polroles
            from pg_policy policy_row where policy_row.polrelid = 'pharmacy.dispensings'::regclass) theirs
    full join (select policy_row.polname, policy_row.polcmd,
                      coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-') as qual,
                      coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '-') as with_check,
                      policy_row.polpermissive, policy_row.polroles
                 from pg_policy policy_row where policy_row.polrelid = 'pharmacy.work_item_acceptances'::regclass) mine
      on mine.polname = theirs.polname and mine.polcmd = theirs.polcmd and mine.qual = theirs.qual
     and mine.with_check = theirs.with_check and mine.polpermissive = theirs.polpermissive
     and mine.polroles = theirs.polroles
   where mine.polname is null or theirs.polname is null;
  if mismatch is not null
     or (select string_agg(policy_row.polname || ':' || policy_row.polcmd::text, ' '
                  order by policy_row.polname::text collate "C")
           from pg_policy policy_row where policy_row.polrelid = 'pharmacy.work_item_acceptances'::regclass)
        is distinct from 'pharmacy_work_item_acceptances_insert:a pharmacy_work_item_acceptances_read:r '
          || 'staff_own_work_insert:a staff_own_work_read:r' then
    raise exception 'pharmacist acceptance: the policies are not pharmacy.dispensings'' four: %', coalesce(mismatch, 'names');
  end if;
  -- Who holds what on the table, through any membership: SELECT and INSERT
  -- for the Pharmacy and schema test runtimes (and the Pharmacy API's login
  -- role through its runtime), nothing else for anyone.
  select string_agg(format('%s %s=%s', role_row.rolname, privilege.name,
           has_table_privilege(role_row.oid, 'pharmacy.work_item_acceptances', privilege.name)), '; ') into mismatch
    from pg_roles role_row
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege(name)
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_table_privilege(role_row.oid, 'pharmacy.work_item_acceptances', privilege.name)
         <> (role_row.rolname in ('hid_pharmacy_runtime', 'hid_pharmacy_api_runtime', 'hid_schema_test_runtime')
             and privilege.name in ('SELECT', 'INSERT'));
  if mismatch is not null then
    raise exception 'pharmacist acceptance: privileges on the table differ: %', mismatch;
  end if;
  -- The two triggers, in origin mode as 0023's.
  if (select string_agg(pg_get_triggerdef(trigger_row.oid) || ' ' || trigger_row.tgenabled::text, '; '
            order by trigger_row.tgname::text collate "C")
        from pg_trigger trigger_row
       where trigger_row.tgrelid = 'pharmacy.work_item_acceptances'::regclass and not trigger_row.tgisinternal)
     is distinct from 'CREATE TRIGGER pharmacy_work_item_acceptance_validate BEFORE INSERT ON '
       || 'pharmacy.work_item_acceptances FOR EACH ROW EXECUTE FUNCTION pharmacy.validate_work_item_acceptance() O; '
       || 'CREATE TRIGGER pharmacy_work_item_acceptances_immutable BEFORE DELETE OR UPDATE ON '
       || 'pharmacy.work_item_acceptances FOR EACH ROW EXECUTE FUNCTION pharmacy.reject_immutable_evidence() O' then
    raise exception 'pharmacist acceptance: the triggers are not 0147''s';
  end if;
  -- The functions: bodies (md5), owner (the insert validator's: the dispensing
  -- validator's owner), SECURITY DEFINER, volatility, not STRICT, search_path.
  select string_agg(format('%s md5=%s owner=%s definer=%s volatile=%s strict=%s config=%s', expected.proc_name,
           coalesce(md5(proc.prosrc), 'none (missing)'), pg_get_userbyid(proc.proowner), proc.prosecdef,
           proc.provolatile, proc.proisstrict, proc.proconfig), '; ')
    into mismatch
    from (values
      ('pharmacy.validate_work_item_acceptance()', 'edcba164be5587a3f448ab8cb8f555aa', 'v',
        '{"search_path=pg_catalog, pg_temp"}'),
      ('pharmacy.own_work_item_steps(uuid[])', '624bf894d7ff773ccf71d878af474bfc', 's',
        '{"search_path=pg_catalog, pg_temp"}'),
      ('pharmacy.validate_work_item_event()', '8a8d6680cf2fd4dcf57047979d771f2e', 'v',
        '{"search_path=pharmacy, platform, pg_temp"}')) expected(proc_name, digest, volatility, config)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc_name)
   where proc.oid is null or md5(proc.prosrc) <> expected.digest or proc.proowner <> validator_owner
      or proc.proowner <> owner_oid or not proc.prosecdef or proc.provolatile <> expected.volatility
      or proc.proisstrict or proc.proconfig::text <> expected.config;
  if mismatch is not null then
    raise exception 'pharmacist acceptance: the functions are not 0147''s: %', mismatch;
  end if;
  -- The replaced event validator: still the owner of pharmacy.context_allows'
  -- (pharmacy-session-guards pins it), its owner's alone, its trigger kept.
  if (select proc.proowner from pg_proc proc where proc.oid = 'pharmacy.validate_work_item_event()'::regprocedure)
       <> (select proc.proowner from pg_proc proc where proc.oid = 'pharmacy.context_allows(uuid,uuid,text)'::regprocedure)
     or exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid in ('pharmacy.validate_work_item_event()'::regprocedure,
                         'pharmacy.validate_work_item_acceptance()'::regprocedure)
                   and acl.grantee <> proc.proowner)
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'pharmacy.work_item_events'::regclass
            and trigger_row.tgname = 'pharmacy_work_item_event_validate' and trigger_row.tgenabled = 'O'
            and trigger_row.tgfoid = 'pharmacy.validate_work_item_event()'::regprocedure) <> 1 then
    raise exception 'pharmacist acceptance: the event validator''s owner, ACL or trigger changed, or a trigger function has a grant';
  end if;
  -- Who may execute the reader and the trigger function, through any
  -- membership.
  select string_agg(format('%s %s=%s', expected.proc_name, role_row.rolname,
           has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')), '; ') into mismatch
    from (values
      ('pharmacy.validate_work_item_acceptance()', array[]::text[]),
      ('pharmacy.own_work_item_steps(uuid[])', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime'])) expected(proc_name, allowed)
    cross join pg_roles role_row
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')
         <> (role_row.rolname = any(expected.allowed));
  if mismatch is not null
     or exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid = 'pharmacy.own_work_item_steps(uuid[])'::regprocedure and acl.grantee = 0) then
    raise exception 'pharmacist acceptance: EXECUTE differs: %', coalesce(mismatch, 'PUBLIC may execute the reader');
  end if;
  -- The reader's columns.
  if pg_get_function_result('pharmacy.own_work_item_steps(uuid[])'::regprocedure)
     is distinct from 'TABLE(work_item_id uuid, basis text, withdrawn boolean, withdrawn_reason text, '
       || 'sent_automatically boolean, accepted_at timestamp with time zone, accepted_by_membership_id uuid, '
       || 'accepted_with text)' then
    raise exception 'pharmacist acceptance: the reader''s columns are not 0147''s';
  end if;
  -- The event table's CHECKs, widened under 0023's names and validated.
  if (select string_agg(constraint_row.conname || ' ' || constraint_row.convalidated || ' '
            || pg_get_constraintdef(constraint_row.oid), '; ' order by constraint_row.conname::text collate "C")
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'pharmacy.work_item_events'::regclass and constraint_row.contype = 'c'
         and constraint_row.conname in ('work_item_events_event_type_check', 'work_item_events_event_version_check'))
     is distinct from 'work_item_events_event_type_check true CHECK ((event_type = ANY (ARRAY['
       || '''prescription_accepted''::text, ''pharmacist_accepted''::text]))); work_item_events_event_version_check true '
       || 'CHECK ((event_version = ANY (ARRAY[1, 2])))' then
    raise exception 'pharmacist acceptance: the event CHECKs are not widened as 0147 widens them';
  end if;
end $$;

-- Fixtures. Organization O (e1470000...01) with facilities F1 "Acceptance
-- Test Hospital" (e1470001...01) and F2 "Acceptance Test Annex" (...02); an
-- outside pharmacy, organization O4 "Acceptance Outside Pharmacy Ltd" (a
-- governed, approved pharmacy) with facility F4 (...04). Members (account
-- e1470002...n, staff e1470003...n, membership e1470004...n, role
-- e1470005...n):
--   1 DR doctor F1 (write grants)   2 PH pharmacist F1 (no grant)
--   3 PG pharmacist F1 (write grants)   4 P2 pharmacist F2   5 P4 pharmacist F4
-- Patients (e1470006...n): 1 Ada (an active account, so an order route can
-- reach her), 2 Bisi. DR and PG hold write grants for both at F1.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'acceptance-test'),
  ('emergency', 'Emergency treatment', 'acceptance-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1470000-0000-4000-8000-000000000001', 'Acceptance Test Organization', 'acceptance-test-organization'),
  ('e1470000-0000-4000-8000-000000000004', 'Acceptance Outside Pharmacy Ltd', 'acceptance-outside-pharmacy');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1470001-0000-4000-8000-000000000001', 'e1470000-0000-4000-8000-000000000001', 'Acceptance Test Hospital',
   'ACCEPTANCE-1', 'Africa/Lagos', true, 'verified'),
  ('e1470001-0000-4000-8000-000000000002', 'e1470000-0000-4000-8000-000000000001', 'Acceptance Test Annex',
   'ACCEPTANCE-2', 'Africa/Lagos', true, 'verified'),
  ('e1470001-0000-4000-8000-000000000004', 'e1470000-0000-4000-8000-000000000004', 'Acceptance Outside Pharmacy',
   'ACCEPTANCE-4', 'Africa/Lagos', true, 'verified');
create temporary table acceptance_members (n integer primary key, code text, role_code text, site integer,
  organization integer) on commit drop;
insert into acceptance_members values (1, 'dr', 'doctor', 1, 1), (2, 'ph', 'pharmacist', 1, 1),
  (3, 'pg', 'pharmacist', 1, 1), (4, 'p2', 'pharmacist', 2, 1), (5, 'p4', 'pharmacist', 4, 4);
grant select on acceptance_members to public;
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1470002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:acceptance-' || code,
       'acceptance-' || code || '@example.invalid', 'Acceptance ' || upper(code), 'active'
  from acceptance_members
union all
select 'e1470015-0000-4000-8000-000000000001', 'synthetic:acceptance-patient-ada', 'acceptance-ada@example.invalid',
       'Ada Accept', 'active';
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1470003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1470002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'Acceptance ' || upper(code),
       'acceptance-' || code || '@example.invalid', 'verified', role_code
  from acceptance_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1470004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1470003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1470002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1470000-0000-4000-8000-00000000000' || organization)::uuid,
       ('e1470001-0000-4000-8000-00000000000' || site)::uuid, role_code, role_code, true, true
  from acceptance_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1470005-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1470002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
       ('e1470004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1470001-0000-4000-8000-00000000000' || site)::uuid, 'Acceptance suite role'
  from acceptance_members;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1470006-0000-4000-8000-000000000001', 'e1470015-0000-4000-8000-000000000001', 'HID-ACCAAA2', 'Ada', 'Accept',
   'Ada Accept', 'female', '1990-04-05', 'active'),
  ('e1470006-0000-4000-8000-000000000002', null, 'HID-ACCBBB3', 'Bisi', 'Accept', 'Bisi Accept', 'female',
   '1985-01-02', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select gen_random_uuid(), ('e1470006-0000-4000-8000-00000000000' || patient)::uuid,
       ('e1470003-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1470002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1470004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       'e1470001-0000-4000-8000-000000000001', 'write_records', 'direct-care', 'active',
       'Synthetic acceptance consent', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days'
  from (values (1, 1), (1, 2), (3, 1), (3, 2)) consent(member, patient);
-- The outside pharmacy (as 0133's suite): its governed approval and product,
-- and orders between facilities switched on (control_settings readable by a
-- non-superuser owner).
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
values ('e1470013-0000-4000-8000-000000000004', 'pharmacy', 'Acceptance Outside Pharmacy Ltd', 'pharmacy', 'RC9914704',
  'Acceptance Outside Admin', 'admin@acceptance-outside.invalid', 'approved', 'verified', '914704', clock_timestamp(),
  'e1470000-0000-4000-8000-000000000004', 'e1470001-0000-4000-8000-000000000004', 'e1470002-0000-4000-8000-000000000001',
  'Governed approval for the acceptance suite', clock_timestamp(), 'Acceptance Outside Pharmacy Ltd',
  'Private Company Limited by Shares', '2019-05-01', '7 Outside Road, Ikeja, Lagos', 'active');
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
values ('e1470000-0000-4000-8000-000000000004', 'pharmacy', 'e1470001-0000-4000-8000-000000000004', 'active',
  'e1470013-0000-4000-8000-000000000004');
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
select set_config('acceptance.attestation', (select text_row.version from ehr.order_route_attestation_texts text_row
  where text_row.kind = 'prescription' order by text_row.created_at desc, text_row.version desc limit 1), true);

-- The session the services set (DatabaseService.withTransaction); the new
-- images also set app.own_facility_work to '0133' (switched => false is a
-- session of today's images).
create function pg_temp.as_member(member integer, site integer default null, purpose text default 'direct-care',
  correlation text default null, switched boolean default true) returns void language sql as $f$
  select set_config('app.own_facility_work', case when switched then '0133' else '' end, true),
         set_config('app.actor_subject', 'synthetic:acceptance-' || (select code from acceptance_members where n = member), true),
         set_config('app.facility_id', 'e1470001-0000-4000-8000-00000000000'
           || coalesce(site, (select acceptance_members.site from acceptance_members where n = member)), true),
         set_config('app.correlation_id', coalesce(correlation, 'acceptance-' || substr(md5(random()::text), 1, 12)), true),
         set_config('app.membership_id', 'e1470004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'), true),
         set_config('app.purpose_of_use', purpose, true);
$f$;
-- A session no service sets: member's account (its subject), another
-- member's membership. It shows that the account and the membership are each
-- checked against the row, not only together.
create function pg_temp.as_member_with(member integer, other_membership integer) returns void language sql as $f$
  select pg_temp.as_member(member);
  select set_config('app.membership_id', 'e1470004-0000-4000-8000-0000000000' || lpad(other_membership::text, 2, '0'),
    true);
$f$;
-- Whether A3's owner is a superuser or has BYPASSRLS (pgadmin on the
-- container cluster), so that forced row-level security does not hide the
-- work items and prescriptions from the trigger.
create function pg_temp.owner_bypasses() returns boolean language sql as $f$
  select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
    join pg_roles role_row on role_row.oid = proc.proowner
   where proc.oid = 'pharmacy.validate_work_item_acceptance()'::regprocedure
$f$;
create function pg_temp.rx(n integer) returns uuid language sql immutable as $f$
  select ('e1470007-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.account(member integer) returns uuid language sql immutable as $f$
  select ('e1470002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid
$f$;
create function pg_temp.membership(member integer) returns uuid language sql immutable as $f$
  select ('e1470004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid
$f$;
-- D7's send, as ehr-api calls it: its answer as text.
create function pg_temp.send(prescription uuid, version bigint) returns text language plpgsql as $f$
declare answer text;
begin
  select string_agg(sent.outcome || case when sent.work_item_id is null then '' else ':item' end, ',') into answer
    from ehr.send_prescription_to_own_pharmacy(prescription, version) sent;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- Owner reads (the suite runner's): a prescription's own work item, its
-- route-backed one, and the prescription a work item came from ('rxN').
create function pg_temp.work_item_of(prescription uuid) returns uuid language sql security definer as $f$
  select id from pharmacy.work_items where source_ehr_prescription_id = prescription and order_route_id is null
$f$;
create function pg_temp.routed_item_of(prescription uuid) returns uuid language sql security definer as $f$
  select id from pharmacy.work_items where source_ehr_prescription_id = prescription and order_route_id is not null
$f$;
create function pg_temp.rx_of(work_item uuid) returns text language sql security definer as $f$
  select 'rx' || ltrim(right(source_ehr_prescription_id::text, 2), '0') from pharmacy.work_items where id = work_item
$f$;
create function pg_temp.member_of(membership uuid) returns text language sql security definer as $f$
  select case when membership is not null
              then coalesce((select code from acceptance_members where pg_temp.membership(n) = membership), '?') end
$f$;
-- pharmacy-api's acceptance INSERT (ORD-4's accept route, or a dispensing's
-- first step) of a work item by the session's member, with the item's own
-- patient and facility. The refusals change one value each: as_member names
-- another member as the acceptor (account and membership), as_account only
-- the account, as_membership only the membership; patient and facility
-- replace the item's own.
create function pg_temp.acceptance_sql(work_item uuid, member integer, accepted_with text default 'accept',
  key text default null, as_member integer default null, as_account integer default null,
  as_membership integer default null, patient uuid default null, facility uuid default null)
returns text language sql security definer as $f$
  select format($i$insert into pharmacy.work_item_acceptances (work_item_id, patient_id, facility_id, accepted_by,
        accepted_by_membership_id, accepted_with, idempotency_key, request_sha256, correlation_id)
      values (%L, %L, %L, %L, %L, %L, %L, %L, %L)$i$,
    w.id, coalesce(patient, w.patient_id), coalesce(facility, w.facility_id),
    pg_temp.account(coalesce(as_account, as_member, member)),
    pg_temp.membership(coalesce(as_membership, as_member, member)), accepted_with,
    coalesce(key, 'acceptance-accept-' || replace(gen_random_uuid()::text, '-', '')), repeat('c', 64),
    current_setting('app.correlation_id'))
  from pharmacy.work_items w where w.id = work_item
$f$;
-- pharmacy-api's event INSERT after the acceptance (a pharmacist_accepted
-- event of version 2 by default, with the fixed reason) by member, with the
-- item's own patient and facility; the refusals replace one value each
-- (as_membership: another member's membership as the actor's).
create function pg_temp.event_sql(work_item uuid, member integer, reason text default 'Accepted by the pharmacist',
  version integer default 2, kind text default 'pharmacist_accepted', as_membership integer default null,
  patient uuid default null, facility uuid default null) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.work_item_events (work_item_id, patient_id, facility_id, event_version,
        event_type, actor_id, actor_membership_id, reason, correlation_id)
      values (%L, %L, %L, %s, %L, %L, %L, %L, %L)$i$,
    w.id, coalesce(patient, w.patient_id), coalesce(facility, w.facility_id), version, kind, pg_temp.account(member),
    pg_temp.membership(coalesce(as_membership, member)), reason, current_setting('app.correlation_id'))
  from pharmacy.work_items w where w.id = work_item
$f$;
-- pharmacy-api's dispensing INSERT (PharmacyService.dispense) by the
-- session's member, with the given key (the acceptance a dispensing writes
-- first takes the same key and digest).
create function pg_temp.dispense_sql(work_item uuid, member integer, key text default null)
returns text language sql security definer as $f$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,%L,%L,21,'capsule',%L,%L,'Dispensed to the patient',%L,%L,%L)$i$,
    gen_random_uuid(), w.id, w.patient_id, w.facility_id, w.medication_code_system, w.medication_code,
    w.medication_display, pg_temp.account(member), pg_temp.membership(member),
    coalesce(key, 'acceptance-dispense-' || replace(gen_random_uuid()::text, '-', '')), repeat('d', 64),
    current_setting('app.correlation_id'))
  from pharmacy.work_items w where w.id = work_item
$f$;
-- pharmacy-api's hand-in (PharmacyService.accept, a pharmacist bringing in a
-- prescription by hand) of prescription n by the session's member: the work
-- item and its prescription_accepted event of version 1, as two statements.
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
    pg_temp.membership(member), 'acceptance-hand-in-' || replace(gen_random_uuid()::text, '-', ''), repeat('a', 64),
    current_setting('app.correlation_id'))
  from ehr.prescriptions p where p.id = pg_temp.rx(n)
$f$;
-- DR's order-route send of prescription n to F4's pharmacy, as the new
-- ehr-api calls it (the switch set): 'sent' (the route kept as
-- acceptance.route_<n>), or 'SQLSTATE message'.
create function pg_temp.route_send(n integer) returns text language plpgsql as $f$
declare
  source ehr.prescriptions%rowtype;
  sent record;
  key text := 'acceptance-route-' || replace(gen_random_uuid()::text, '-', '');
begin
  perform pg_temp.as_member(1);
  select prescription.* into source from ehr.prescriptions prescription where prescription.id = pg_temp.rx(n);
  select * into sent from ehr.send_order_route(gen_random_uuid(), 'prescription', source.patient_id, source.id,
    source.encounter_id, source.row_version, 'e1470001-0000-4000-8000-000000000004',
    current_setting('acceptance.attestation'), key, encode(sha256(key::bytea), 'hex'));
  perform set_config('acceptance.route_' || n, sent.route_id::text, true);
  return 'sent';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.route_row(n integer) returns setof ehr.order_routes language sql security definer as $f$
  select * from ehr.order_routes where id = nullif(current_setting('acceptance.route_' || n, true), '')::uuid
$f$;
-- P4's acceptance of prescription n's route at F4 (pharmacy-api's call).
create function pg_temp.route_accept(n integer) returns text language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_member(5);
  select * into accepted from pharmacy.accept_order_route(current_setting('acceptance.route_' || n)::uuid,
    (select route.row_version from pg_temp.route_row(n) route), 'health_id', 'HID-ACCAAA2',
    'Patient collected the prescription', 'acceptance-route-accept-' || n || '-' || substr(md5(random()::text), 1, 8),
    repeat('a', 64));
  return accepted.result;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The steps reader's answer for prescriptions' own items (the session's),
-- one 'rxN:basis/withdrawn/reason/sent automatically/accepted with/by/at'
-- each, in the reader's order.
create function pg_temp.steps(prescriptions integer[]) returns text language sql as $f$
  select coalesce(string_agg(format('%s:%s/%s/%s/%s/%s/%s/%s', pg_temp.rx_of(step.work_item_id), step.basis,
           step.withdrawn::text, coalesce(step.withdrawn_reason, '-'), step.sent_automatically::text,
           coalesce(step.accepted_with, '-'), coalesce(pg_temp.member_of(step.accepted_by_membership_id), '-'),
           (step.accepted_at is not null)::text), ' '
           order by length(pg_temp.rx_of(step.work_item_id)), pg_temp.rx_of(step.work_item_id)), 'none')
    from pharmacy.own_work_item_steps(array(select pg_temp.work_item_of(pg_temp.rx(n)) from unnest(prescriptions) n)) step
$f$;
-- Every own item of these prescriptions, as an array (owner read).
create function pg_temp.own_items(prescriptions integer[]) returns uuid[] language sql security definer as $f$
  select array(select pg_temp.work_item_of(pg_temp.rx(n)) from unnest(prescriptions) n)
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', proc.signature);
  end loop;
end $$;

-- The EHR rows, through the EHR runtime with the EHR API's statements, as DR
-- at F1: encounter E1 for Ada and E2 for Bisi; prescriptions (draft, then
-- activated as prescriptions.service.ts update does): rx1 to rx8 for Ada,
-- rx9 to rx12 for Bisi.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e1470008-0000-4000-8000-00000000000' || n)::uuid, ('e1470006-0000-4000-8000-00000000000' || n)::uuid,
       'e1470001-0000-4000-8000-000000000001', pg_temp.account(1), pg_temp.membership(1), 'ambulatory', 'in_progress',
       clock_timestamp()
  from generate_series(1, 2) n;
create function pg_temp.prescribe(n integer, patient integer) returns void language sql as $f$
  insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, ends_on, status)
  values (pg_temp.rx(n), ('e1470008-0000-4000-8000-00000000000' || patient)::uuid,
    ('e1470006-0000-4000-8000-00000000000' || patient)::uuid, 'e1470001-0000-4000-8000-000000000001',
    pg_temp.account(1), pg_temp.membership(1), 'http://www.whocc.no/atc', 'J01CA04',
    'Amoxicillin 500 mg capsule (' || n || ')', 1, 'capsule', 'oral', 'Every 8 hours', 'Take after food for 7 days',
    date '2026-11-18', date '2026-11-25', 'draft');
$f$;
create function pg_temp.set_status(n integer, new_status text, reason text) returns void language plpgsql as $f$
begin
  perform set_config('app.change_reason', reason, true);
  update ehr.prescriptions set status = new_status where id = pg_temp.rx(n);
  if not found then raise exception 'acceptance suite: prescription % not updated', n; end if;
end $f$;
grant execute on function pg_temp.prescribe(integer, integer), pg_temp.set_status(integer, text, text) to public;
select pg_temp.prescribe(n, case when n <= 8 then 1 else 2 end) from generate_series(1, 12) n;
select pg_temp.set_status(n, 'active', 'First activation (no reason needed)') from generate_series(1, 12) n;
-- 5 (D7). DR's activations send rx1-rx5 and rx8-rx12 to F1's pharmacy by
-- themselves: each a work item accepted by DR with 0133's fixed reason and
-- one prescription_accepted event of version 1, through the replaced
-- validator's 0077 branch. rx6 (handed in by hand below) and rx7 (sent to an
-- outside pharmacy) are not sent.
select pg_temp.expect('5 D7 sends rx1-rx5 and rx8-rx12',
  (select string_agg(pg_temp.send(pg_temp.rx(n), 2), ' ' order by n) from unnest(array[1, 2, 3, 4, 5, 8, 9, 10, 11, 12]) n),
  'sent:item sent:item sent:item sent:item sent:item sent:item sent:item sent:item sent:item sent:item');
reset role;
select pg_temp.expect('5 each sent item has one event: prescription_accepted, version 1, by DR, the fixed reason',
  (select string_agg(distinct format('%s/%s/%s/%s/%s', event_row.event_type, event_row.event_version,
     (event_row.actor_id = pg_temp.account(1))::text, event_row.reason,
     (select count(*) from pharmacy.work_item_events other where other.work_item_id = item.id)), ' ')
     from pharmacy.work_items item join pharmacy.work_item_events event_row on event_row.work_item_id = item.id
    where item.facility_id = 'e1470001-0000-4000-8000-000000000001'),
  'prescription_accepted/1/true/Sent automatically when the prescription was activated/1');

-- 7 (part). PH's steps before anything: received (own-work, sent
-- automatically, nothing accepted).
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('7 PH: rx1 and rx11 read received',
  pg_temp.steps(array[1, 11]), 'rx1:own-work/false/-/true/-/-/false rx11:own-work/false/-/true/-/-/false');

-- 2. PH accepts DR's rx1 on the own-work basis: the acceptance, then its
-- event (pharmacy-api's two statements in the accept route's transaction).
select pg_temp.expect('2 PH accepts rx1',
  pg_temp.try(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2, key => 'acceptance-ph-rx1-key-0001')), 'ok');
-- An event that is not the acceptance's actor's (PG), then one without an
-- acceptance (rx11), then another reason: each refused before PH's own.
select pg_temp.as_member(3);
select pg_temp.expect('4 PG''s pharmacist_accepted event for rx1 (PH accepted it): refused',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(1)), 3)),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
select pg_temp.as_member(2);
select pg_temp.expect('4 PH''s pharmacist_accepted event for rx11 (no acceptance): refused',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(11)), 2)),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
select pg_temp.expect('4 PH''s event for rx1 with another reason: refused',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2, 'Accepted for dispensing today')),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
select pg_temp.expect('4 a pharmacist_accepted event of version 1: refused with 0077''s message',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2, version => 1)),
  '23514 Pharmacy work-item event does not match its accepted prescription');
select pg_temp.expect('4 a prescription_accepted event of version 2: refused with 0077''s message',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2, 'Accepted by the pharmacist', 2,
    'prescription_accepted')), '23514 Pharmacy work-item event does not match its accepted prescription');
select pg_temp.expect('2 PH writes rx1''s pharmacist_accepted event',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2)), 'ok');
select pg_temp.expect('2 PH reads back rx1''s one acceptance (accept, by PH) and its two events',
  (select format('%s/%s/%s', acceptance.accepted_with, pg_temp.member_of(acceptance.accepted_by_membership_id),
     (acceptance.accepted_by = pg_temp.account(2))::text)
     from pharmacy.work_item_acceptances acceptance where acceptance.work_item_id = pg_temp.work_item_of(pg_temp.rx(1)))
  || ' ' || (select string_agg(event_row.event_type || ':' || event_row.event_version || ':'
       || pg_temp.member_of(event_row.actor_membership_id), ' ' order by event_row.event_version)
       from pharmacy.work_item_events event_row where event_row.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))),
  'accept/ph/true prescription_accepted:1:dr pharmacist_accepted:2:ph');
select pg_temp.expect('7 PH: rx1 reads accepted (accept, by PH)', pg_temp.steps(array[1]),
  'rx1:own-work/false/-/true/accept/ph/true');

-- 3. A second acceptance, and a second event.
select pg_temp.expect('3 PH accepting rx1 again, with another key: 23505',
  pg_temp.try(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2)),
  '23505 duplicate key value violates unique constraint "work_item_acceptances_work_item_id_key"');
select pg_temp.expect('3 PH''s rx1 key again, for rx11: 23505',
  pg_temp.try(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(11)), 2, key => 'acceptance-ph-rx1-key-0001')),
  '23505 duplicate key value violates unique constraint '
  || '"work_item_acceptances_facility_id_accepted_by_idempotency_k_key"');
select pg_temp.expect('3 a second pharmacist_accepted event for rx1: 23505',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2)),
  '23505 duplicate key value violates unique constraint "work_item_events_work_item_id_event_version_key"');
select pg_temp.as_member(3);
select pg_temp.expect('3 PG (a grant) accepting rx1 after PH: 23505',
  pg_temp.try(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(1)), 3)),
  '23505 duplicate key value violates unique constraint "work_item_acceptances_work_item_id_key"');
-- 2. PG, with grants, accepts rx12 on the consent basis.
select pg_temp.expect('2 PG accepts rx12 (the consent policies)',
  pg_temp.try(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(12)), 3)), 'ok');
-- 4. Before PG writes rx12's event: the event's binding to the session and
-- to the acceptance, one value at a time. Each of these events passes every
-- other clause of the validator, and without the clause it tests it would be
-- written, or would meet only the row-level security policies: PG's grants
-- cover Ada and Bisi, so another patient passes them; PH's own-work policy
-- allows Bisi's rx12 at F1, so PG's event written in PH's session passes
-- them too; pharmacy.work_item_events has no key that ties its patient to
-- its work item.
select pg_temp.as_member(2);
select pg_temp.expect('4 PH writes PG''s pharmacist_accepted event for rx12 (PG''s acceptance): refused',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(12)), 3)),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
select pg_temp.as_member(3);
select pg_temp.expect('4 PG''s event for Bisi''s rx12 naming Ada: refused',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(12)), 3,
    patient => 'e1470006-0000-4000-8000-000000000001')),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
select pg_temp.expect('4 PG''s event for F1''s rx12 naming F2: refused',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(12)), 3,
    facility => 'e1470001-0000-4000-8000-000000000002')),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
-- In sessions no service sets (one member's account, another's membership),
-- the actor's account and membership are each checked against the
-- acceptance's and against the session's. Under a superuser or BYPASSRLS
-- owner (pgadmin on the container cluster) only the clause tested refuses
-- each; under an owner with neither, forced row-level security also hides
-- PG's acceptance from these sessions, so the validator finds none and gives
-- the same answer for that reason too.
select pg_temp.as_member_with(2, 3);
select pg_temp.expect('4 PH''s account with PG''s membership, as session and actor: refused (the acceptance is PG''s)',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(12)), 2, as_membership => 3)),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
select pg_temp.expect('4 PG''s event in that session: refused (PG is not the session''s account)',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(12)), 3)),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
select pg_temp.as_member_with(3, 2);
select pg_temp.expect('4 PG''s account with PH''s membership, as session and actor: refused (the acceptance''s '
    || 'membership is PG''s)',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(12)), 3, as_membership => 2)),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
select pg_temp.expect('4 PG''s event in that session: refused (PG''s membership is not the session''s)',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(12)), 3)),
  '23514 Pharmacy work-item event does not match its pharmacist acceptance');
select pg_temp.as_member(3);
select pg_temp.expect('2 PG writes rx12''s event',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(12)), 3)), 'ok');
select pg_temp.expect('7 PG: rx12 reads accepted on the consent basis', pg_temp.steps(array[12]),
  'rx12:consent/false/-/true/accept/pg/true');
reset role;

-- 4. Refusals. DR holds rx2, edits rx3 (a new version), sends rx4 to F4 (the
-- new ehr-api, so the own claim is released) and completes rx8; rx7 goes to
-- F4 (no own item) and P4 accepts it there.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.set_status(2, 'on_hold', 'Held by the prescriber');
select set_config('app.change_reason', 'Changed the frequency', true);
update ehr.prescriptions set frequency = 'Every 12 hours' where id = pg_temp.rx(3);
select pg_temp.expect('4 rx4 (in F1''s pharmacy, undispensed) and rx7 are sent to F4',
  pg_temp.route_send(4) || ' ' || pg_temp.route_send(7), 'sent sent');
select pg_temp.as_member(1);
select pg_temp.set_status(8, 'completed', 'Course completed');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('5 (0086) P4 accepts rx7''s route at F4: a route-backed item', pg_temp.route_accept(7), 'accepted');
reset role;
select pg_temp.expect('5 (0086) rx7''s route-backed item: one prescription_accepted event of version 1 by P4',
  (select string_agg(event_row.event_type || ':' || event_row.event_version || ':'
     || pg_temp.member_of(event_row.actor_membership_id), ' ')
     from pharmacy.work_item_events event_row where event_row.work_item_id = pg_temp.routed_item_of(pg_temp.rx(7))),
  'prescription_accepted:1:p4');
-- rx9 at another version than its item's, without the change being marked:
-- a version raised as replica (D8's trigger does not fire), so only 0101's
-- check stands between it and an acceptance.
set local session_replication_role = replica;
update ehr.prescriptions set row_version = row_version + 1 where id = pg_temp.rx(9);
set local session_replication_role = origin;
select pg_temp.expect('4 rx9 is at version 3, its item at 2, its send not withdrawn',
  (select p.row_version || '/' || w.source_ehr_prescription_version || '/' || (s.withdrawn_at is null)
     from ehr.prescriptions p join pharmacy.work_items w on w.source_ehr_prescription_id = p.id
     join pharmacy.own_prescription_sends s on s.work_item_id = w.id where p.id = pg_temp.rx(9)), '3/2/true');
-- rx5 dispensed with no acceptance (today's pharmacy-api), rx6 handed in by PG.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('5 PH dispenses rx5 with no acceptance (today''s dispensing)',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(5)), 2)), 'ok');
select pg_temp.as_member(3);
select pg_temp.expect('5 PG hands in rx6 (the work item and its prescription_accepted event of version 1)',
  pg_temp.try(pg_temp.hand_in_sql(6, 3)), 'ok');
select pg_temp.as_member(2);
select pg_temp.expect('4 PH: the held rx2 is refused, changed',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(2)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / changed');
select pg_temp.expect('4 PH: the edited rx3 (version 3; its item holds 2) is refused, changed',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(3)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / changed');
select pg_temp.expect('4 PH: rx4, sent to F4, is refused, sent elsewhere',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(4)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / sent_elsewhere');
select pg_temp.expect('4 PH: the dispensed rx5 is refused, not claimed',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(5)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / not_claimed');
select pg_temp.expect('4 PH: the completed rx8 is refused (0101''s check, no detail)',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(8)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / -');
select pg_temp.expect('4 PH: rx9 at another version than its item''s is refused (0101''s check, no detail)',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(9)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / -');
select pg_temp.expect('4 PH: rx6, handed in by hand, is refused (accepted when handed in)',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(6)), 2)),
  '23514 PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY / hand_off');
select pg_temp.as_member(3);
select pg_temp.expect('4 PG (who handed it in, a grant): rx6 is refused too',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(6)), 3)),
  '23514 PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY / hand_off');
select pg_temp.as_member(5);
select pg_temp.expect('4 P4 at F4: rx7''s route-backed item is refused (accepted by the route''s Accept)',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.routed_item_of(pg_temp.rx(7)), 5)),
  '23514 PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY / order_route');
-- The session and the row: another facility's pharmacist (at F2, and
-- claiming F1), an emergency session, a row naming PG while PH is signed in,
-- an unknown work item; and today's pharmacy-api (no switch), which the
-- policies refuse (42501; under forced row-level security on the owner, the
-- trigger does not even find the item: 23514).
select pg_temp.as_member(4);
select pg_temp.expect('4 P2 at F2: F1''s rx11 is refused',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(11)), 4)),
  '23514 Pharmacist acceptance does not match its work item and actor context / -');
select pg_temp.as_member(4, 1);
select pg_temp.expect('4 P2 claiming F1: rx11 is refused',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(11)), 4)),
  '23514 Pharmacist acceptance does not match its work item and actor context / -');
select pg_temp.as_member(2, purpose => 'emergency');
select pg_temp.expect('4 PH in an emergency session: refused',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(11)), 2)),
  '23514 Pharmacist acceptance does not match its work item and actor context / -');
select pg_temp.as_member(2);
select pg_temp.expect('4 PH writing an acceptance in PG''s name: refused',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(11)), 2, as_member => 3)),
  '23514 Pharmacist acceptance does not match its work item and actor context / -');
-- One value of the row at a time: each of these passes every other check
-- of the trigger and, without the one it tests, would be written (PH's
-- own-work policy allows Bisi's rx11 whoever the row names; PG's grants
-- cover Ada and Bisi), except the F4 item, which the trigger would then
-- refuse as route-backed (under an owner with neither superuser nor
-- BYPASSRLS, forced row-level security hides that item from the trigger, so
-- it is refused as not found too).
select pg_temp.expect('4 PH writing an acceptance with PG''s account and PH''s membership: refused',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(11)), 2, as_account => 3)),
  '23514 Pharmacist acceptance does not match its work item and actor context / -');
select pg_temp.expect('4 PH writing an acceptance with PH''s account and PG''s membership: refused',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(11)), 2, as_membership => 3)),
  '23514 Pharmacist acceptance does not match its work item and actor context / -');
select pg_temp.as_member(3);
select pg_temp.expect('4 PG: Bisi''s rx11 naming Ada as its patient is refused',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(11)), 3,
    patient => 'e1470006-0000-4000-8000-000000000001')),
  '23514 Pharmacist acceptance does not match its work item and actor context / -');
select pg_temp.expect('4 PG at F1: F4''s route-backed rx7 item naming F1 as its facility is refused',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.routed_item_of(pg_temp.rx(7)), 3,
    facility => 'e1470001-0000-4000-8000-000000000001')),
  '23514 Pharmacist acceptance does not match its work item and actor context / -');
select pg_temp.as_member(2);
select pg_temp.expect('4 PH: an unknown work item is refused',
  pg_temp.try_detail(format($s$insert into pharmacy.work_item_acceptances (work_item_id, patient_id, facility_id,
      accepted_by, accepted_by_membership_id, accepted_with, idempotency_key, request_sha256, correlation_id)
    values (gen_random_uuid(), 'e1470006-0000-4000-8000-000000000002', 'e1470001-0000-4000-8000-000000000001',
      %L, %L, 'accept', 'acceptance-unknown-item-0001', repeat('c', 64), 'acceptance-unknown-item')$s$,
    pg_temp.account(2), pg_temp.membership(2))),
  '23514 Pharmacist acceptance does not match its work item and actor context / -');
-- Today's pharmacy-api (no switch) for PH, who holds no grant: nothing lets
-- PH write, and the row is refused. Which check refuses it is the trigger
-- owner's kind. A superuser or BYPASSRLS owner (pgadmin on the container
-- cluster) reads every item as that owner: the trigger passes rx11 on to the
-- policies (42501), and for a held item (rx2) it answers the item's step
-- (changed) before the policies would refuse the row, as 0101's dispensing
-- validator does. Under an owner with neither (production's, and the
-- RDS-like rehearsal's), forced row-level security hides the items from the
-- trigger too: both get the context answer, which says nothing about the
-- item.
select pg_temp.as_member(2, switched => false);
select pg_temp.expect('4 PH as today''s pharmacy-api (no switch, no grant): rx11 is refused, by the policies under a '
    || 'superuser or BYPASSRLS owner, by the trigger under any other',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(11)), 2)),
  case when pg_temp.owner_bypasses()
       then '42501 new row violates row-level security policy for table "work_item_acceptances" / -'
       else '23514 Pharmacist acceptance does not match its work item and actor context / -' end);
select pg_temp.expect('4 PH as today''s pharmacy-api: the held rx2 is refused, with its step only under a superuser or '
    || 'BYPASSRLS owner',
  pg_temp.try_detail(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(2)), 2)),
  case when pg_temp.owner_bypasses()
       then '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / changed'
       else '23514 Pharmacist acceptance does not match its work item and actor context / -' end);
select pg_temp.as_member(2);
-- UPDATE and DELETE: no runtime role holds either; 0023's immutability
-- function refuses them for the owner too (below, as the suite runner).
select pg_temp.expect('4 PH: UPDATE and DELETE of an acceptance are refused (no privilege)',
  pg_temp.try(format($s$update pharmacy.work_item_acceptances set accepted_with = 'dispensing' where work_item_id = %L$s$,
    pg_temp.work_item_of(pg_temp.rx(1)))) || ' / '
  || pg_temp.try(format($s$delete from pharmacy.work_item_acceptances where work_item_id = %L$s$,
    pg_temp.work_item_of(pg_temp.rx(1)))),
  '42501 permission denied for table work_item_acceptances / 42501 permission denied for table work_item_acceptances');
reset role;
select pg_temp.expect('4 the owner: UPDATE and DELETE of an acceptance are refused (append-only)',
  pg_temp.try(format($s$update pharmacy.work_item_acceptances set accepted_with = 'dispensing' where work_item_id = %L$s$,
    pg_temp.work_item_of(pg_temp.rx(1)))) || ' / '
  || pg_temp.try(format($s$delete from pharmacy.work_item_acceptances where work_item_id = %L$s$,
    pg_temp.work_item_of(pg_temp.rx(1)))),
  '55000 Pharmacy clinical operational evidence is append-only / 55000 Pharmacy clinical operational evidence is '
  || 'append-only');
select pg_temp.expect('4 nothing was written by the refusals: two acceptances (rx1, rx12), two pharmacist events',
  (select count(*) from pharmacy.work_item_acceptances)::text || ' '
  || (select count(*) from pharmacy.work_item_events where event_type = 'pharmacist_accepted')::text, '2 2');

-- 5. 0077's version 1 refusals are unchanged: a second prescription_accepted
-- event of an item (its key), and one that is not its acceptance's.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('5 a second prescription_accepted event for rx6: 23505',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(6)), 3, 'Handed in at the pharmacy counter', 1,
    'prescription_accepted')),
  '23505 duplicate key value violates unique constraint "work_item_events_work_item_id_event_version_key"');
select pg_temp.as_member(2);
select pg_temp.expect('5 a prescription_accepted event for rx11 not by its acceptor (DR): refused as by 0077',
  pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(11)), 2,
    'Sent automatically when the prescription was activated', 1, 'prescription_accepted')),
  '23514 Pharmacy work-item event does not match its accepted prescription');

-- 6. A dispensing of the received rx10 accepts it first, in its own
-- transaction: the acceptance with 'dispensing', the dispensing's key and
-- digest, its event, then the dispensing.
select pg_temp.expect('6 PH dispenses rx10: acceptance (dispensing), event, dispensing',
  pg_temp.try(pg_temp.acceptance_sql(pg_temp.work_item_of(pg_temp.rx(10)), 2, 'dispensing',
    'acceptance-dispense-rx10-key-0001')) || ' '
  || pg_temp.try(pg_temp.event_sql(pg_temp.work_item_of(pg_temp.rx(10)), 2)) || ' '
  || pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(10)), 2, 'acceptance-dispense-rx10-key-0001')),
  'ok ok ok');
-- 2. PH dispenses rx1 after accepting it.
select pg_temp.expect('2 PH dispenses rx1 after its acceptance',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2)), 'ok');
reset role;
select pg_temp.expect('6 rx10''s acceptance and dispensing share the key and the digest''s owner',
  (select format('%s/%s/%s', acceptance.accepted_with, (acceptance.idempotency_key = dispensing.idempotency_key)::text,
     (acceptance.accepted_by = dispensing.dispensed_by)::text)
     from pharmacy.work_item_acceptances acceptance
     join pharmacy.dispensings dispensing on dispensing.work_item_id = acceptance.work_item_id
    where acceptance.work_item_id = pg_temp.work_item_of(pg_temp.rx(10))), 'dispensing/true/true');

-- 7. The steps reader. A hold after an acceptance: DR holds rx12 (PG
-- accepted it).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.set_status(12, 'on_hold', 'Held after the pharmacy accepted it');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('7 PH (own-work): every step of F1''s own items',
  pg_temp.steps(array[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12]),
  'rx1:own-work/false/-/true/accept/ph/true rx2:own-work/true/changed/true/-/-/false '
  || 'rx3:own-work/true/changed/true/-/-/false rx4:own-work/true/sent_elsewhere/true/-/-/false '
  || 'rx5:own-work/false/-/true/-/-/false rx6:own-work/false/-/false/-/-/false '
  || 'rx8:own-work/false/-/true/-/-/false rx9:own-work/false/-/true/-/-/false '
  || 'rx10:own-work/false/-/true/dispensing/ph/true rx11:own-work/false/-/true/-/-/false '
  || 'rx12:own-work/true/changed/true/accept/pg/true');
select pg_temp.expect('7 PH: the first four columns are exactly the states reader''s',
  (select string_agg(format('%s/%s/%s/%s', step.work_item_id, step.basis, step.withdrawn, step.withdrawn_reason), ' '
            order by step.work_item_id)
     from pharmacy.own_work_item_steps(pg_temp.own_items(array[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12])) step),
  (select string_agg(format('%s/%s/%s/%s', state.work_item_id, state.basis, state.withdrawn, state.withdrawn_reason), ' '
            order by state.work_item_id)
     from pharmacy.own_work_item_states(pg_temp.own_items(array[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12])) state));
-- DR, the consenting doctor (pharmacy-api reads the prescriber's progress in
-- the prescriber's session): the same steps, on the consent basis.
select pg_temp.as_member(1);
select pg_temp.expect('7 DR (consent): the same steps',
  pg_temp.steps(array[1, 6, 10, 11, 12]),
  'rx1:consent/false/-/true/accept/ph/true rx6:consent/false/-/false/-/-/false '
  || 'rx10:consent/false/-/true/dispensing/ph/true rx11:consent/false/-/true/-/-/false '
  || 'rx12:consent/true/changed/true/accept/pg/true');
select pg_temp.expect('7 DR: the first four columns are exactly the states reader''s',
  (select string_agg(format('%s/%s/%s/%s', step.work_item_id, step.basis, step.withdrawn, step.withdrawn_reason), ' '
            order by step.work_item_id)
     from pharmacy.own_work_item_steps(pg_temp.own_items(array[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12])) step),
  (select string_agg(format('%s/%s/%s/%s', state.work_item_id, state.basis, state.withdrawn, state.withdrawn_reason), ' '
            order by state.work_item_id)
     from pharmacy.own_work_item_states(pg_temp.own_items(array[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12])) state));
-- Nothing for another facility: P2 at F2 and claiming F1; P4 at F4 for its
-- route-backed item (an own item reader).
select pg_temp.as_member(4);
select pg_temp.expect('7 P2 at F2: nothing of F1''s', pg_temp.steps(array[1, 6, 10, 11, 12]), 'none');
select pg_temp.as_member(4, 1);
select pg_temp.expect('7 P2 claiming F1: nothing', pg_temp.steps(array[1, 6, 10, 11, 12]), 'none');
select pg_temp.as_member(5);
select pg_temp.expect('7 P4 at F4: nothing for rx7''s route-backed item',
  (select count(*)::text from pharmacy.own_work_item_steps(array[pg_temp.routed_item_of(pg_temp.rx(7))])), '0');
select pg_temp.as_member(2, switched => false);
select pg_temp.expect('7 PH as today''s pharmacy-api (no switch, no grant): nothing',
  pg_temp.steps(array[1, 11]), 'none');
select pg_temp.as_member(2);
select pg_temp.expect('7 201 ids, and no array: refused',
  pg_temp.try(format('select * from pharmacy.own_work_item_steps(%L::uuid[])',
    array(select gen_random_uuid() from generate_series(1, 201))::text)) || ' / '
  || pg_temp.try('select * from pharmacy.own_work_item_steps(null)'),
  '22023 OWN_WORK_ITEM_STEPS_INVALID / 22023 OWN_WORK_ITEM_STEPS_INVALID');
select pg_temp.expect('7 200 ids are answered (the two it knows)',
  (select count(*)::text from pharmacy.own_work_item_steps(pg_temp.own_items(array[1, 11])
     || array(select gen_random_uuid() from generate_series(1, 198)))), '2');
reset role;
set local role hid_pharmacy_api_runtime;
select set_config('app.facility_id', '', true), set_config('app.membership_id', '', true),
       set_config('app.actor_subject', '', true);
select pg_temp.expect('7 without a session: nothing', pg_temp.steps(array[1, 11]), 'none');
reset role;
-- The Lab and EHR runtimes may not call the reader nor write an acceptance.
set local role hid_lab_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('7 the Lab runtime may not call the reader',
  left(pg_temp.try('select count(*) from pharmacy.own_work_item_steps(array[]::uuid[])'), 5), '42501');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('7 the EHR runtime may not call the reader',
  left(pg_temp.try('select count(*) from pharmacy.own_work_item_steps(array[]::uuid[])'), 5), '42501');
reset role;

rollback;
