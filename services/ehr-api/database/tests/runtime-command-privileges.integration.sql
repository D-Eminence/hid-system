\set ON_ERROR_STOP on
-- Every runtime role can run, as itself, each kind of command it holds a
-- privilege for, and the row locks its service takes (Phase 4 Stage 9).
-- Rollback-only.
--
-- PostgreSQL checks privileges when a statement starts, before any row is read:
-- the table privilege, UPDATE for every table a SELECT ... FOR UPDATE / NO KEY
-- UPDATE / SHARE / KEY SHARE locks, and SELECT on every table, and EXECUTE on
-- every function, that the applicable row-level security policies read, as the
-- querying role, even when another permissive policy alone would allow the row.
-- Unit tests mock the database and the older suites ran these statements as
-- hid_schema_test_runtime or a superuser, so two kinds of defect only showed at
-- runtime:
-- - The services locked insert-only rows their runtime role cannot update
--   (42501 before any row is read), and Identity locked the nullable side of an
--   outer join (0A000). The services now lock only rows their role may update
--   (scripts/verify-runtime-locking-privileges.mjs checks the service SQL).
-- - Since 0058 the self-NIN insert policy on identity.patient_identifiers read
--   identity.verification_evidence, which the Identity runtime cannot read, so
--   every Identity runtime insert of an identifier failed, including the NIN
--   registration review. 0078 moves that check into a definer predicate.
--
-- Case 1 plans (EXPLAIN, which performs the start-of-statement privilege
-- checks without running anything) a no-op SELECT, INSERT, UPDATE, DELETE and
-- row lock as each runtime role on every table where that role holds the
-- matching privilege, and fails listing every refusal. Case 2 runs the lock
-- statements Stage 9 kept, changed or added, exactly, as their runtime roles.
-- Case 3 pins the boundary: Stage 9 granted no UPDATE, so the insert-only
-- tables whose locks were dropped still cannot be locked by their runtime role.
-- The rehearsal also runs this suite with a schema owner that is neither a
-- superuser nor BYPASSRLS; nothing here depends on the owner.
begin;

create temporary table runtime_command_probe (
  role_name text not null, table_name text not null, command text not null, outcome text not null
);
grant all on runtime_command_probe to public;

-- Case 1: every runtime role, every table, every command it holds.
do $$
declare
  target record; command text; statement text; columns text; probe text;
begin
  for target in
    select role.rolname, namespace.nspname, class.relname, class.oid
      from pg_roles role cross join pg_class class
      join pg_namespace namespace on namespace.oid = class.relnamespace
     where role.rolname in ('hid_identity_api_runtime', 'hid_ehr_api_runtime', 'hid_lab_api_runtime',
         'hid_pharmacy_api_runtime', 'hid_ocr_api_runtime', 'hid_outreach_api_runtime', 'hid_ocr_worker',
         'hid_notification_api_runtime', 'hid_notification_worker', 'hid_event_dispatcher')
       and class.relkind in ('r', 'p')
       and namespace.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
     order by 1, 2, 3
  loop
    foreach command in array array['select', 'insert', 'update', 'delete', 'lock'] loop
      statement := null;
      if command = 'select' and has_any_column_privilege(target.rolname, target.oid, 'SELECT') then
        statement := format('select 1 from %I.%I where false', target.nspname, target.relname);
      elsif command = 'insert' and has_any_column_privilege(target.rolname, target.oid, 'INSERT') then
        select string_agg(quote_ident(attribute.attname), ', ' order by attribute.attnum),
               string_agg('null', ', ')
          into columns, probe
          from pg_attribute attribute
         where attribute.attrelid = target.oid and attribute.attnum > 0 and not attribute.attisdropped
           and attribute.attgenerated = '' and attribute.attidentity <> 'a'
           and has_column_privilege(target.rolname, target.oid, attribute.attnum, 'INSERT');
        statement := format('insert into %I.%I (%s) select %s where false', target.nspname, target.relname, columns, probe);
      elsif command = 'update' and has_any_column_privilege(target.rolname, target.oid, 'UPDATE') then
        select quote_ident(attribute.attname) into columns
          from pg_attribute attribute
         where attribute.attrelid = target.oid and attribute.attnum > 0 and not attribute.attisdropped
           and has_column_privilege(target.rolname, target.oid, attribute.attnum, 'UPDATE')
         order by attribute.attnum limit 1;
        statement := format('update %I.%I set %s = %s where false', target.nspname, target.relname, columns, columns);
      elsif command = 'delete' and has_table_privilege(target.rolname, target.oid, 'DELETE') then
        statement := format('delete from %I.%I where false', target.nspname, target.relname);
      elsif command = 'lock' and has_any_column_privilege(target.rolname, target.oid, 'UPDATE') then
        statement := format('select 1 from %I.%I where false for update', target.nspname, target.relname);
      end if;
      continue when statement is null;
      begin
        execute format('set local role %I', target.rolname);
        execute 'explain (costs off) ' || statement;
        reset role;
        insert into runtime_command_probe values (target.rolname, target.nspname || '.' || target.relname, command, 'ok');
      exception when others then
        reset role;
        insert into runtime_command_probe
          values (target.rolname, target.nspname || '.' || target.relname, command, sqlstate || ': ' || sqlerrm);
      end;
    end loop;
  end loop;
end $$;

do $$
declare
  failures text := (select string_agg(format('%s %s %s: %s', role_name, command, table_name, outcome), '; '
                       order by role_name, table_name, command)
                      from runtime_command_probe where outcome <> 'ok');
  probes integer := (select count(*) from runtime_command_probe);
begin
  if failures is not null then
    raise exception 'Runtime roles cannot run commands they hold privileges for: %', failures;
  end if;
  -- The probe must have covered the commands Stage 9 is about.
  if probes < 200 or not exists (select 1 from runtime_command_probe
      where role_name = 'hid_identity_api_runtime' and table_name = 'identity.patient_identifiers' and command = 'insert')
    or not exists (select 1 from runtime_command_probe
      where role_name = 'hid_identity_api_runtime' and table_name = 'identity.registration_cases' and command = 'lock')
    or not exists (select 1 from runtime_command_probe
      where role_name = 'hid_ocr_api_runtime' and table_name = 'ocr.jobs' and command = 'lock')
    or not exists (select 1 from runtime_command_probe
      where role_name = 'hid_outreach_api_runtime' and table_name = 'outreach.campaigns' and command = 'lock') then
    raise exception 'The runtime command probe did not cover the Stage 9 commands (% probes)', probes;
  end if;
end $$;

-- Case 2: the lock statements the services take after Stage 9, as their
-- runtime roles, with the session the services set. No row matches; the
-- statements must start, and lock only the rows their role may update.
create temporary table runtime_lock_case (
  name text primary key, run_as text not null, statement text not null, outcome text
);
grant all on runtime_lock_case to public;
insert into runtime_lock_case(name, run_as, statement) values
  ('identity registration case review lock', 'hid_identity_api_runtime',
   $sql$select registration.id from identity.registration_cases registration
          where registration.id = '00000000-0000-4000-8000-000000000000'
            and registration.facility_id = platform.current_facility_id() for update$sql$),
  ('ocr job lock (validation, confirmation, publication)', 'hid_ocr_api_runtime',
   $sql$select id from ocr.jobs where id = '00000000-0000-4000-8000-000000000000' for update$sql$),
  ('ocr job key share before a publication row (publish and failure)', 'hid_ocr_api_runtime',
   $sql$select id from ocr.jobs where id = '00000000-0000-4000-8000-000000000000' for key share$sql$),
  ('outreach campaign share lock for a campaign-linked registration', 'hid_outreach_api_runtime',
   $sql$select campaign.status from outreach.campaigns campaign
          join outreach.campaign_members member on member.campaign_id = campaign.id
           and member.facility_id = campaign.facility_id and member.membership_id = '00000000-0000-4000-8000-000000000000'
          where campaign.id = '00000000-0000-4000-8000-000000000000'
            and campaign.facility_id = '00000000-0000-4000-8000-000000000000' for share of campaign$sql$),
  ('lab specimen lock', 'hid_lab_api_runtime',
   $sql$select id from lab.specimens where id = '00000000-0000-4000-8000-000000000000' for update$sql$);

do $$
declare lock_case record;
begin
  for lock_case in select * from runtime_lock_case order by name loop
    begin
      execute format('set local role %I', lock_case.run_as);
      perform set_config('app.actor_subject', 'synthetic:stage9-lock-probe', true);
      perform set_config('app.facility_id', '00000000-0000-4000-8000-000000000000', true);
      perform set_config('app.membership_id', '00000000-0000-4000-8000-000000000000', true);
      perform set_config('app.purpose_of_use', 'healthcare-operations', true);
      perform set_config('app.correlation_id', 'stage9-lock-probe', true);
      execute lock_case.statement;
      reset role;
      update runtime_lock_case set outcome = 'ok' where name = lock_case.name;
    exception when others then
      reset role;
      update runtime_lock_case set outcome = sqlstate || ': ' || sqlerrm where name = lock_case.name;
    end;
  end loop;
end $$;

-- Case 3: the insert-only tables whose locks Stage 9 dropped stay without
-- UPDATE for their runtime roles; their rows are never updated.
create temporary table runtime_lock_boundary (run_as text, table_name text, outcome text);
grant all on runtime_lock_boundary to public;
do $$
declare boundary record;
begin
  for boundary in select * from (values
      ('hid_pharmacy_api_runtime', 'pharmacy.work_items'), ('hid_pharmacy_api_runtime', 'pharmacy.dispensings'),
      ('hid_pharmacy_api_runtime', 'pharmacy.dispensing_reversals'),
      ('hid_pharmacy_api_runtime', 'pharmacy.imported_medication_evidence'),
      ('hid_lab_api_runtime', 'lab.imported_evidence'), ('hid_lab_api_runtime', 'lab.work_items'),
      ('hid_lab_api_runtime', 'lab.accessions'), ('hid_ocr_api_runtime', 'ocr.validations'),
      ('hid_ocr_api_runtime', 'ocr.patient_confirmations'), ('hid_outreach_api_runtime', 'outreach.campaign_members'),
      ('hid_identity_api_runtime', 'identity.patients')) as boundary(run_as, table_name)
  loop
    begin
      execute format('set local role %I', boundary.run_as);
      execute format('select 1 from %s where false for update', boundary.table_name);
      reset role;
      insert into runtime_lock_boundary values (boundary.run_as, boundary.table_name, 'ok');
    exception when others then
      reset role;
      insert into runtime_lock_boundary values (boundary.run_as, boundary.table_name, sqlstate);
    end;
  end loop;
end $$;

do $$
declare
  lock_failures text := (select string_agg(format('%s (%s): %s', name, run_as, coalesce(outcome, 'not run')), '; ' order by name)
                           from runtime_lock_case where outcome is distinct from 'ok');
  boundary_failures text := (select string_agg(format('%s %s: %s', run_as, table_name, outcome), '; ' order by run_as, table_name)
                               from runtime_lock_boundary where outcome <> '42501');
begin
  if lock_failures is not null then raise exception 'Service lock statements failed as their runtime role: %', lock_failures; end if;
  if boundary_failures is not null then
    raise exception 'A runtime role can lock an insert-only table (expected 42501): %', boundary_failures;
  end if;
  if (select count(*) from runtime_lock_boundary) <> 11 then raise exception 'The lock boundary case did not run'; end if;
end $$;

-- Case 4: a campaign-linked Outreach registration share-locks its campaign,
-- which passes only the campaign UPDATE policy (outreach.campaign.write). A role
-- that may register without that permission would have every campaign-linked
-- registration refused, so every such role must hold it.
do $$
declare missing text := (
  select string_agg(registration.role_code, ', ' order by registration.role_code)
    from auth.role_permissions registration
   where registration.permission_code = 'outreach.registration.write'
     and not exists (select 1 from auth.role_permissions campaign
       where campaign.role_code = registration.role_code and campaign.permission_code = 'outreach.campaign.write'));
begin
  if missing is not null then
    raise exception 'Roles with outreach.registration.write but not outreach.campaign.write: %', missing;
  end if;
  if not exists (select 1 from auth.role_permissions where permission_code = 'outreach.registration.write') then
    raise exception 'No role holds outreach.registration.write';
  end if;
end $$;

-- Case 5: lab.validate_work_item_child (0018, repaired by 0078) guards both the
-- requested tests and the events of a work item. Every Lab acceptance of an EHR
-- order inserts its acceptance event, which failed with 42703 because the
-- requested-test check read new.ordinal on lab.work_item_events. Isolated: the
-- work item is inserted in replica mode, and only this guard is enabled
-- (ENABLE ALWAYS TRIGGER) for the requested-test and event inserts.
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, priority, test_code_system, test_code, test_name,
  clinical_indication, requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key,
  request_sha256, correlation_id) values
  ('e8f90000-0000-4000-8000-000000000001', 'e8f90000-0000-4000-8000-000000000002',
   'e8f90000-0000-4000-8000-000000000003', 'e8f90000-0000-4000-8000-000000000003',
   'e8f90000-0000-4000-8000-000000000004', 1, 'e8f90000-0000-4000-8000-000000000005', 'routine',
   'http://loinc.org', '718-7', 'Haemoglobin', 'Synthetic Stage 9 order', 'e8f90000-0000-4000-8000-000000000006',
   '2026-10-01 09:00:00+00', 'e8f90000-0000-4000-8000-000000000006', 'e8f90000-0000-4000-8000-000000000007',
   'runtime-command-privileges-work-item', repeat('a', 64), 'runtime-command-privileges');
alter table lab.work_item_events enable always trigger lab_work_item_event_validate;
alter table lab.work_item_requested_tests enable always trigger lab_work_item_test_validate;
create temporary table lab_child_case (name text primary key, expected text not null, outcome text);
grant all on lab_child_case to public;
insert into lab_child_case (name, expected) values
  ('acceptance event of the work item', 'ok'),
  ('event naming another patient', '23514'),
  ('requested test matching the order', 'ok'),
  ('requested test with another ordinal', '23514'),
  ('requested test with another code', '23514');
do $$
declare child record;
begin
  for child in select * from lab_child_case loop
    begin
      if child.name like 'requested test%' then
        insert into lab.work_item_requested_tests (work_item_id, facility_id, patient_id, "ordinal", code_system, code, name)
        values ('e8f90000-0000-4000-8000-000000000001', 'e8f90000-0000-4000-8000-000000000003',
                'e8f90000-0000-4000-8000-000000000002',
                case when child.name like '%ordinal' then 2 else 1 end, 'http://loinc.org',
                case when child.name like '%code' then '2345-7' else '718-7' end, 'Haemoglobin');
      else
        insert into lab.work_item_events (work_item_id, facility_id, patient_id, event_version, event_type, actor_id,
          actor_membership_id, reason, correlation_id)
        values ('e8f90000-0000-4000-8000-000000000001', 'e8f90000-0000-4000-8000-000000000003',
                case when child.name like '%another patient' then 'e8f90000-0000-4000-8000-000000000008'::uuid
                     else 'e8f90000-0000-4000-8000-000000000002'::uuid end,
                1, 'accepted', 'e8f90000-0000-4000-8000-000000000006', 'e8f90000-0000-4000-8000-000000000007',
                'Accepted exact EHR laboratory order version', 'runtime-command-privileges');
      end if;
      raise exception using errcode = 'S9000', message = 'undo the probe';
    exception when others then
      update lab_child_case set outcome = case when sqlstate = 'S9000' then 'ok' else sqlstate || ': ' || sqlerrm end
       where name = child.name;
    end;
  end loop;
end $$;
alter table lab.work_item_events enable trigger lab_work_item_event_validate;
alter table lab.work_item_requested_tests enable trigger lab_work_item_test_validate;
set local session_replication_role = origin;
do $$
declare failures text := (select string_agg(format('%s: expected %s, got %s', name, expected, coalesce(outcome, 'not run')),
                            '; ' order by name)
                            from lab_child_case where outcome is null or split_part(outcome, ':', 1) <> expected);
begin
  if failures is not null then raise exception 'Lab work-item child guard: %', failures; end if;
end $$;

select 'runtime command privileges: ' || count(*) || ' probes passed' as result from runtime_command_probe;
rollback;
