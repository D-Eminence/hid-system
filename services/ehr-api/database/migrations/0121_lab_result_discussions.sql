-- 0121 Lab results in the patient chat only from finished visits, and the
-- clinician's "Discussed with the patient" mark for sensitive and critical
-- results (patient chat part 2). Owner decisions in chat (D-Eminence):
-- Q24, 2026-11-04, "yes": build patient chat part 2 now, (a) lab results in
-- the PATIENT chat only from finished visits (results from cancelled,
-- wrong-patient or still-open visits never reach the patient chat; the staff
-- chat keeps full access), (b) the server side of the "Discussed with the
-- patient" mark for sensitive and critical results (the EHR button is the
-- website lane's): a clinician with care access to the patient marks a released
-- result as discussed, and once marked that sensitive result may appear in the
-- patient chat with the server-added talk-to-your-doctor line; the mark can be
-- withdrawn with a reason; every mark is audited, (c) this migration. Q28,
-- "keep": PR 1's safer defaults stay (sensitive diagnoses and their medicines
-- stay out; the talk-to-your-doctor wording and the final sensitive test list
-- are still the owner's and Ola's to approve). The design's decisions, which
-- the owner confirms when signing the declaration:
--   D-A permission lab.result.discuss, for roles doctor and clinician (not
--       nurse); the list uses lab.result.released.read.
--   D-B a result is gated when its last released version is sensitive (PR 1's
--       unchanged list, in the services' code) or critical
--       (abnormal_flag critical_candidate); a gated result reaches the patient
--       chat only while a mark on that exact version is active.
--   D-C marking and withdrawing need an active direct-care write_records grant
--       (identity.has_active_consent_grant, which never counts break-glass);
--       listing needs read_records.
--   D-D a withdrawal names a reason code (marked_in_error, not_yet_discussed,
--       wrong_patient, other) and a reason of 8-500 characters. The reason text
--       is stored only in lab.result_discussion_events; it never goes into
--       audit.events, a log or a response; only the code does.
--   D-E a mark binds one result version; a released correction needs a new
--       mark. Withdrawing needs no currency check (the safe direction).
--   D-F a result is from a finished visit (for the patient only) when its work
--       item's encounter is completed, its lab request is active, on hold or
--       completed, and the route it came through (if any) did not end
--       wrong_patient or entered_in_error. A result from an unfinished visit
--       may be marked, but it stays out of the patient chat.
--   D-G the sensitive-test list stays in the services' TypeScript (PR 1, the
--       owner and Ola approve it); this database stores only the marks.
--   D-H two trails: the append-only event table is the clinical record of
--       every mark; lab-api also writes an ids-only audit.events row for every
--       call, success or refusal, in the same transaction.
--
-- Numbering: 0121 is applied after 0106-0120 in the release, but it uses and
-- requires none of their objects and applies on 0105 alone. Its preconditions
-- pin the bodies it relies on as 0001-0105 left them: if one of 0106-0120
-- replaces one of those bodies, this file refuses with 55000 and nothing is
-- applied; the bodies are then measured again and the pins updated in a new
-- file. Nothing else from 0106-0120 is read.
--
-- S1 lab.result_discussion_events: append-only, one row per mark or
--    withdrawal of one released result version, strictly alternating
--    (event_no 1, 3, 5... discussed; 2, 4, 6... withdrawn). The current state of
--    a (result, version) is the kind of its highest event_no; no row means not
--    discussed. Row-level security enabled and forced; one SELECT and one
--    INSERT policy (true), as 0086's command tables; no UPDATE or DELETE
--    policy; a trigger refuses UPDATE and DELETE (platform.reject_mutation);
--    no privilege for any role, PUBLIC included: only the commands below,
--    running as the owner, read or write it.
-- S2 lab_work_items_patient_result_gate: a permissive SELECT policy on
--    lab.work_items for the owner role only (TO <owner>), USING
--    lab.patient_self_context(patient_id). Under an owner that is neither a
--    superuser nor BYPASSRLS (production's), FORCE row-level security binds the
--    owner too, and no existing policy lets a patient-self session see a work
--    item, so the patient gate (S3) could not reach the visit. Runtime roles
--    are not the owner and no runtime role is a member of it (checked), so they
--    gain nothing; the patient-self session itself still reads no work item.
--    The other owner-run functions that read lab.work_items (the Lab insert
--    guards, the route send, return and access commands) run only in staff
--    or workload sessions, where lab.patient_self_context is false, so the
--    policy admits nothing new to them.
-- S3 Functions, all owned by the tables' owner, search_path pg_catalog,
--    pg_temp, every name schema-qualified, no EXECUTE for PUBLIC:
--    lab.result_visit_finished(encounter, lab request, route) (sql, stable,
--      SECURITY DEFINER, no EXECUTE for any role): D-F, under the caller's
--      row-level security; every answer it can give is fail-safe (a row it
--      cannot see reads as not finished).
--    lab.result_discussion_target(patient, result) (plpgsql, stable, invoker,
--      no EXECUTE for any role): the result as the session's facility sees it,
--      its own result (the local path) or one reported back through a route it
--      ordered (the routed path), with its current version, performing
--      facility and visit. Called only by the two commands.
--    lab.patient_self_result_gates(patient) (sql, stable, SECURITY DEFINER,
--      EXECUTE for hid_lab_runtime and hid_schema_test_runtime): in a
--      patient-self session for that patient only (else no row), one row per
--      released result: result_id, released_version (its last released
--      version), finished_visit, discussed (the latest event on that version is
--      a mark). IDs and booleans only.
--    lab.record_result_discussion(patient, result, version, idempotency key,
--      request sha256) and lab.withdraw_result_discussion(patient, result,
--      version, reason code, reason, idempotency key, request sha256) (plpgsql,
--      volatile, SECURITY DEFINER, #variable_conflict use_column, the RDS form
--      of 0105; EXECUTE for hid_lab_runtime and hid_schema_test_runtime):
--      42501 LAB_CONTEXT_REQUIRED (no correlation ID of 8-128 characters),
--      42501 PURPOSE_OF_USE_REQUIRED (purpose not direct-care), 22023
--      RESULT_DISCUSSION_INVALID, 42501 PERMISSION_DENIED (no
--      lab.result.discuss), 42501 PATIENT_ACCESS_DENIED (no direct-care
--      write_records grant), P0001 IDEMPOTENCY_KEY_REUSED, P0002
--      RESULT_NOT_FOUND, P0001 RESULT_VERSION_CHANGED, RESULT_NOT_RELEASED,
--      RESULT_ENTERED_IN_ERROR (record), RESULT_NOT_DISCUSSED (withdraw) and
--      RESULT_DISCUSSION_CHANGED (a repeated request whose event is no longer
--      the version's current state: a later mark or withdrawal changed it, so
--      the replay would misreport whether the patient sees the result). The
--      record command checks the local path's version against the result's
--      last released version (the one the list and the patient gate use), not
--      lab.results.current_version, which moves to a correction before it is
--      released: an older released version answers RESULT_VERSION_CHANGED, a
--      newer one RESULT_NOT_RELEASED. A repeated key with the same request, or
--      a mark of a version already discussed, answers the existing event with
--      replayed true. Serialized per (result, version) by a transaction
--      advisory lock, not FOR UPDATE: under FORCE row-level security a locking
--      read must also pass the UPDATE policies (0105 S4). The key is looked up
--      again after the lock, so a duplicate sent while the first is in flight
--      is a replay too; the same key raced for another (result, version) hits
--      the key's unique index and answers IDEMPOTENCY_KEY_REUSED.
--    lab.list_result_discussions(patient) (plpgsql, stable, SECURITY DEFINER,
--      EXECUTE for hid_lab_runtime and hid_schema_test_runtime): with
--      lab.result.released.read and a direct-care read_records grant, every
--      result of the patient this facility can see (local and routed) at its
--      last released, not invalidated version, with its test, flag, release
--      time, finished_visit and the latest event on that version (state, number,
--      time, membership, withdrawal reason code; never the reason text);
--      newest first, every row: the sensitive and critical gate is lab-api's
--      (D-G), so a cut here would drop older gated results before it ran;
--      lab-api keeps at most 500 gated rows and says when it cut.
-- S4 Permission lab.result.discuss (D-A), for roles doctor and clinician, as
--    0084 seeds its permission (ON CONFLICT: description refreshed, active).
-- S5 Post-checks: attributes, owners and exact ACLs of the six functions; the
--    table's FORCE row-level security, policies, trigger and empty ACL; the
--    S2 policy's roles; exactly the two role rows for lab.result.discuss.
--
-- 0. Preconditions (catalog reads only; each failure raises 55000 or 42501 and
--    nothing is applied): 0001-0105 applied (the existence of 0105's
--    ehr.resolve_document_scan_target is the marker, never its body, which
--    0121 does not use and 0106-0120 may replace; else "0121: 0001-0105 must
--    be applied first"); not applied yet (else "0121: already
--    applied"); the bodies relied on are 0001-0105's (md5 of pg_proc.prosrc,
--    measured on a throwaway PostgreSQL 16 database migrated 0001-0105 from
--    f11c9ec9): lab.patient_self_context 39aeca12d2c59b69877800a9a3a7c50b,
--    ehr.patient_self_context (0083) 9878cfbd3dec68263d2e4bffc7cd9975,
--    identity.has_active_consent_grant (0104) 732d11892dd4e27e1ff9093ae3b7de5a,
--    auth.membership_has_permission 65e3eaff93fe729fd5c5b986b80c9dd6,
--    platform.current_actor_subject cf14c2d4a16d44a79ea9dbef9dc79c2b,
--    current_membership_id 641989704fea95f885fbc38c6feb5aa5,
--    current_facility_id c4a7c2989e83d9cedbf1f7b785a5aaed,
--    current_purpose_of_use 74f7f2ea17dbbe825f7cfe543ad3e83f,
--    current_correlation_id 48d3bf187101d33bfda51dac829aa223,
--    platform.reject_mutation 398738f39f6eebed2c54da5009495def;
--    the columns read have their types and NOT NULLs, and
--    lab.result_releases has its unique (result_id, result_version); the
--    patient-self policies of 0030 and 0067 exist, and 0086's
--    order_routes_command_read (SELECT, USING true, for PUBLIC), through which
--    the owner sees a result's route in a patient-self session (the visit
--    check also refuses a route it cannot see); lab.work_items forces
--    row-level security; the eleven tables share one owner, the applier is it
--    or a member that inherits it and may SET ROLE to it, and no runtime role is
--    a member of it (so the S2 policy stays the owner's); roles doctor and
--    clinician exist.
-- 1. The table (S1). 2. The functions (S3). 3. The permission (S4).
-- 4. Owners and grants. 5. The policy (S2), last. 6. Post-checks (S5).
--
-- Locks (measured with pg_locks before commit on a 0105 copy): SHARE ROW
-- EXCLUSIVE on lab.result_releases, identity.patients, identity.facilities and
-- identity.staff_facility_memberships (the new table's foreign keys);
-- ROW EXCLUSIVE on auth.permissions and auth.role_permissions (S4), ROW SHARE
-- on auth.permissions and auth.roles (their foreign-key checks); ACCESS SHARE
-- on lab.results, lab.test_executions, lab.work_item_requested_tests,
-- ehr.encounters, ehr.lab_requests and ehr.order_routes (the SQL bodies
-- checked at creation); ACCESS EXCLUSIVE on lab.work_items (CREATE POLICY),
-- taken last, so a work-item read or write waits only for this transaction's
-- post-checks; ACCESS EXCLUSIVE on the new table and its indexes;
-- SHARE UPDATE EXCLUSIVE on the six new functions (their comments); catalog,
-- schema, role and the session's own temporary-schema locks. Behind a
-- conflicting lock the runner stops after its 5 s lock_timeout and applies
-- nothing.
--
-- Old services on this schema: today's lab-api never calls the new functions;
-- its staff and patient Lab queries read exactly as before (the S2 policy
-- applies to the owner only). Today's ehr-api is unaffected. Rollout order:
-- this migration, then lab-api (its patient query joins
-- lab.patient_self_result_gates; before 0121 that query fails and the patient
-- chat treats Lab as unavailable), then ehr-api. Applied migrations 0001
-- through 0105 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass.
create function pg_temp.result_discussions_0121_holds(holder oid, object_owner oid, object_acl aclitem[],
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
  table_owner oid;
begin
  -- a. Prerequisites: 0001-0105 (0105's scan-target function is the marker; its
  -- body is not pinned, as 0121 neither calls nor reads it).
  if to_regclass('lab.results') is null
     or to_regclass('lab.result_revisions') is null
     or to_regclass('lab.result_releases') is null
     or to_regclass('lab.result_invalidations') is null
     or to_regclass('lab.test_executions') is null
     or to_regclass('lab.work_item_requested_tests') is null
     or to_regclass('lab.work_items') is null
     or to_regclass('lab.order_route_result_reports') is null
     or to_regclass('ehr.encounters') is null
     or to_regclass('ehr.lab_requests') is null
     or to_regclass('ehr.order_routes') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('auth.permissions') is null
     or to_regclass('auth.role_permissions') is null
     or to_regclass('auth.roles') is null
     or to_regprocedure('ehr.resolve_document_scan_target(text,text,text,text)') is null then
    raise exception using errcode = '55000', message = '0121: 0001-0105 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('lab.result_discussion_events') is not null
     or to_regprocedure('lab.patient_self_result_gates(uuid)') is not null
     or to_regprocedure('lab.result_visit_finished(uuid,uuid,uuid)') is not null
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid = 'lab.work_items'::regclass
                   and policy_row.polname = 'lab_work_items_patient_result_gate') then
    raise exception using errcode = '55000', message = '0121: already applied';
  end if;
  -- c. The bodies relied on, as 0001-0105 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('lab.patient_self_context(uuid)', '39aeca12d2c59b69877800a9a3a7c50b'),
      ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)',
        '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_purpose_of_use()', '74f7f2ea17dbbe825f7cfe543ad3e83f'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where proc.oid is null or md5(proc.prosrc) <> expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0121: a function this migration relies on differs from 0001-0105: %s', mismatch);
  end if;
  -- d. The columns read, the release key the new foreign key uses, and the
  -- patient-self policies of 0030 and 0067 (the gate reads through them).
  select string_agg(format('%s.%s', expected.relation_name, expected.column_name), '; ') into mismatch
    from (values
      ('lab.results', 'id', 'uuid', true),
      ('lab.results', 'execution_id', 'uuid', true),
      ('lab.results', 'patient_id', 'uuid', true),
      ('lab.results', 'facility_id', 'uuid', true),
      ('lab.results', 'current_version', 'bigint', true),
      ('lab.result_revisions', 'result_id', 'uuid', true),
      ('lab.result_revisions', 'version', 'bigint', true),
      ('lab.result_revisions', 'abnormal_flag', 'text', true),
      ('lab.result_releases', 'result_id', 'uuid', true),
      ('lab.result_releases', 'patient_id', 'uuid', true),
      ('lab.result_releases', 'result_version', 'bigint', true),
      ('lab.result_releases', 'released_at', 'timestamp with time zone', true),
      ('lab.result_invalidations', 'result_id', 'uuid', true),
      ('lab.result_invalidations', 'result_version', 'bigint', true),
      ('lab.test_executions', 'id', 'uuid', true),
      ('lab.test_executions', 'requested_test_id', 'uuid', true),
      ('lab.test_executions', 'patient_id', 'uuid', true),
      ('lab.work_item_requested_tests', 'id', 'uuid', true),
      ('lab.work_item_requested_tests', 'work_item_id', 'uuid', true),
      ('lab.work_item_requested_tests', 'patient_id', 'uuid', true),
      ('lab.work_item_requested_tests', 'code_system', 'text', true),
      ('lab.work_item_requested_tests', 'code', 'text', true),
      ('lab.work_item_requested_tests', 'name', 'text', true),
      ('lab.work_items', 'id', 'uuid', true),
      ('lab.work_items', 'patient_id', 'uuid', true),
      ('lab.work_items', 'order_route_id', 'uuid', false),
      ('lab.work_items', 'source_encounter_id', 'uuid', true),
      ('lab.work_items', 'source_ehr_order_id', 'uuid', true),
      ('lab.work_items', 'ordering_facility_id', 'uuid', true),
      ('ehr.order_routes', 'id', 'uuid', true),
      ('ehr.order_routes', 'kind', 'text', true),
      ('ehr.order_routes', 'patient_id', 'uuid', true),
      ('ehr.order_routes', 'ordering_facility_id', 'uuid', true),
      ('ehr.order_routes', 'source_encounter_id', 'uuid', true),
      ('ehr.order_routes', 'source_lab_request_id', 'uuid', false),
      ('ehr.order_routes', 'ended_kind', 'text', false),
      ('lab.order_route_result_reports', 'route_id', 'uuid', true),
      ('lab.order_route_result_reports', 'result_id', 'uuid', true),
      ('lab.order_route_result_reports', 'result_version', 'bigint', true),
      ('lab.order_route_result_reports', 'kind', 'text', true),
      ('lab.order_route_result_reports', 'performing_facility_id', 'uuid', true),
      ('lab.order_route_result_reports', 'test_code_system', 'text', true),
      ('lab.order_route_result_reports', 'test_code', 'text', true),
      ('lab.order_route_result_reports', 'test_name', 'text', true),
      ('lab.order_route_result_reports', 'abnormal_flag', 'text', false),
      ('lab.order_route_result_reports', 'occurred_at', 'timestamp with time zone', true),
      ('ehr.encounters', 'id', 'uuid', true),
      ('ehr.encounters', 'status', 'text', true),
      ('ehr.lab_requests', 'id', 'uuid', true),
      ('ehr.lab_requests', 'status', 'text', true),
      ('identity.staff_facility_memberships', 'id', 'uuid', true),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid', false),
      ('identity.staff_facility_memberships', 'account_id', 'uuid', true),
      ('auth.permissions', 'code', 'text', true),
      ('auth.permissions', 'description', 'text', true),
      ('auth.permissions', 'active', 'boolean', true),
      ('auth.role_permissions', 'role_code', 'text', true),
      ('auth.role_permissions', 'permission_code', 'text', true))
         expected(relation_name, column_name, type_name, not_null)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = expected.relation_name::regclass
                        and attribute_row.attname = expected.column_name and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = expected.type_name
                        and attribute_row.attnotnull = expected.not_null);
  if mismatch is null then
    select string_agg(format('the unique key %s on %s', wanted.columns, wanted.relation_name), '; ') into mismatch
      from (values ('lab.result_releases', array['result_id', 'result_version']),
                   ('identity.staff_facility_memberships', array['id', 'facility_id', 'account_id']))
             wanted(relation_name, columns)
     where not exists (
       select 1 from pg_index index_row
        where index_row.indrelid = wanted.relation_name::regclass and index_row.indisunique
          and index_row.indisvalid and index_row.indpred is null and index_row.indexprs is null
          and index_row.indkey::text = (select string_agg(attribute_row.attnum::text, ' ' order by column_name.position)
                                          from unnest(wanted.columns) with ordinality column_name(name, position)
                                          join pg_attribute attribute_row
                                            on attribute_row.attrelid = wanted.relation_name::regclass
                                           and attribute_row.attname = column_name.name));
  end if;
  if mismatch is null then
    select string_agg(format('policy %s on %s', wanted.policy_name, wanted.relation_name), '; ') into mismatch
      from (values ('lab.results', 'lab_patient_self_read'), ('lab.result_revisions', 'lab_patient_self_read'),
                   ('lab.result_verifications', 'lab_patient_self_read'),
                   ('lab.result_releases', 'lab_patient_self_read'),
                   ('lab.result_invalidations', 'lab_patient_self_read'),
                   ('lab.test_executions', 'lab_patient_self_read'),
                   ('lab.work_item_requested_tests', 'lab_patient_self_read'),
                   ('lab.specimens', 'lab_patient_self_read'),
                   ('ehr.encounters', 'encounters_patient_self_read'),
                   ('ehr.lab_requests', 'investigations_patient_self_read')) wanted(relation_name, policy_name)
     where not exists (select 1 from pg_policy policy_row
                        where policy_row.polrelid = wanted.relation_name::regclass
                          and policy_row.polname = wanted.policy_name and policy_row.polcmd = 'r'
                          and policy_row.polpermissive);
  end if;
  if mismatch is null and not exists (select 1 from pg_policy policy_row
                                       where policy_row.polrelid = 'ehr.order_routes'::regclass
                                         and policy_row.polname = 'order_routes_command_read'
                                         and policy_row.polcmd = 'r' and policy_row.polpermissive
                                         and policy_row.polroles = array[0::oid]
                                         and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'true') then
    mismatch := 'policy order_routes_command_read on ehr.order_routes (SELECT, USING true, for PUBLIC)';
  end if;
  if mismatch is null and not exists (select 1 from pg_class relation
                                       where relation.oid = 'lab.work_items'::regclass
                                         and relation.relrowsecurity and relation.relforcerowsecurity) then
    mismatch := 'lab.work_items row-level security';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0121: an object this migration relies on differs from 0001-0105: %s', mismatch);
  end if;
  -- e. One owner, an applier that may act as it, no runtime role a member of
  -- it, and that owner's privileges, never through a superuser's bypass
  -- (production's migrator has none).
  table_owner := (select relation.relowner from pg_class relation where relation.oid = 'lab.results'::regclass);
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s is not owned by %s', relation.oid::regclass, pg_get_userbyid(table_owner)) as what
        from pg_class relation
       where relation.oid in ('lab.result_revisions'::regclass, 'lab.result_releases'::regclass,
                              'lab.result_invalidations'::regclass, 'lab.test_executions'::regclass,
                              'lab.work_item_requested_tests'::regclass, 'lab.work_items'::regclass,
                              'lab.order_route_result_reports'::regclass, 'ehr.encounters'::regclass,
                              'ehr.lab_requests'::regclass, 'ehr.order_routes'::regclass)
         and relation.relowner <> table_owner
      union all
      select format('%s is not %s and may not act as it (INHERIT and SET)', current_user, pg_get_userbyid(table_owner))
       where applier <> table_owner
         and not (pg_has_role(applier, table_owner, 'USAGE') and pg_has_role(applier, table_owner, 'SET'))
      union all
      select format('runtime role %s is a member of %s', role_row.rolname, pg_get_userbyid(table_owner))
        from pg_roles role_row
       where role_row.oid <> table_owner
         and (role_row.rolname like 'hid\_%\_runtime' or role_row.rolname in ('hid_schema_test_runtime',
                'hid_document_scanner', 'hid_ocr_worker', 'hid_audit_writer', 'hid_event_dispatcher',
                'hid_event_delivery_commands', 'hid_notification_worker'))
         and pg_has_role(role_row.oid, table_owner, 'USAGE')
      union all
      select format('%s lacks %s on schema %s', pg_get_userbyid(table_owner), wanted.privilege, namespace.nspname)
        from (values ('lab', 'CREATE'), ('lab', 'USAGE'), ('ehr', 'USAGE'), ('identity', 'USAGE'),
                     ('auth', 'USAGE'), ('platform', 'USAGE')) wanted(schema_name, privilege)
        join pg_namespace namespace on namespace.nspname = wanted.schema_name
       where not pg_temp.result_discussions_0121_holds(table_owner, namespace.nspowner, namespace.nspacl, 'n',
               wanted.privilege)
      union all
      select format('%s lacks %s on %s', pg_get_userbyid(table_owner), wanted.privilege, relation.oid::regclass)
        from (values ('auth.permissions', 'INSERT'), ('auth.permissions', 'UPDATE'), ('auth.permissions', 'SELECT'),
                     ('auth.role_permissions', 'INSERT'), ('auth.role_permissions', 'SELECT'),
                     ('auth.roles', 'SELECT'), ('identity.patients', 'REFERENCES'),
                     ('identity.facilities', 'REFERENCES'), ('identity.staff_facility_memberships', 'REFERENCES'),
                     ('identity.staff_facility_memberships', 'SELECT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
       where not pg_temp.result_discussions_0121_holds(table_owner, relation.relowner, relation.relacl, 'r',
               wanted.privilege)
      union all
      select format('%s lacks EXECUTE on %s', pg_get_userbyid(table_owner), proc.oid::regprocedure)
        from (values ('lab.patient_self_context(uuid)'), ('ehr.patient_self_context(uuid)'),
                     ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'),
                     ('auth.membership_has_permission(text,uuid,uuid,text)'), ('platform.current_actor_subject()'),
                     ('platform.current_membership_id()'), ('platform.current_facility_id()'),
                     ('platform.current_purpose_of_use()'), ('platform.current_correlation_id()'),
                     ('platform.reject_mutation()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
       where not pg_temp.result_discussions_0121_holds(table_owner, proc.proowner, proc.proacl, 'f', 'EXECUTE')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0121: missing privileges: %s', mismatch);
  end if;
  -- f. The roles S4 grants the permission to.
  if (select count(*) from auth.roles role_row where role_row.code in ('doctor', 'clinician')) <> 2 then
    raise exception using errcode = '55000', message = '0121: the doctor and clinician roles must exist';
  end if;
  raise notice '0121: owners checked: lab.results=%, applier=%', pg_get_userbyid(table_owner), current_user;
end
$$;

-- 1. The table (S1).
create table lab.result_discussion_events (
  id uuid primary key default gen_random_uuid(),
  result_id uuid not null,
  result_version bigint not null check (result_version > 0),
  patient_id uuid not null references identity.patients(id) on delete restrict,
  result_facility_id uuid not null references identity.facilities(id) on delete restrict,
  event_no integer not null check (event_no > 0),
  kind text not null check (kind in ('discussed', 'withdrawn')),
  reason_code text,
  reason text,
  actor_account_id uuid not null,
  actor_membership_id uuid not null,
  actor_facility_id uuid not null,
  occurred_at timestamptz not null default clock_timestamp(),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  constraint result_discussion_events_alternation_ck check ((kind = 'discussed') = (event_no % 2 = 1)),
  constraint result_discussion_events_reason_ck check (coalesce(
    (kind = 'discussed' and reason_code is null and reason is null)
    or (kind = 'withdrawn' and reason_code is not null and reason is not null
        and reason_code in ('marked_in_error', 'not_yet_discussed', 'wrong_patient', 'other')
        and reason = btrim(reason) and length(reason) between 8 and 500), false)),
  constraint result_discussion_events_release_fk foreign key (result_id, result_version)
    references lab.result_releases(result_id, result_version) on delete restrict,
  constraint result_discussion_events_actor_fk foreign key (actor_membership_id, actor_facility_id, actor_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint result_discussion_events_event_uq unique (result_id, result_version, event_no),
  constraint result_discussion_events_idempotency_uq unique (actor_facility_id, actor_account_id, idempotency_key)
);
create index result_discussion_events_patient_idx
  on lab.result_discussion_events (patient_id, result_id, result_version, event_no desc);
alter table lab.result_discussion_events enable row level security;
alter table lab.result_discussion_events force row level security;
create policy result_discussion_events_command_read on lab.result_discussion_events for select using (true);
create policy result_discussion_events_command_insert on lab.result_discussion_events for insert with check (true);
revoke all on lab.result_discussion_events from public;
create trigger result_discussion_events_no_mutation
  before update or delete on lab.result_discussion_events
  for each row execute function platform.reject_mutation();
comment on table lab.result_discussion_events is
  '0121: clinicians'' "Discussed with the patient" marks and their withdrawals, one released result version each, append-only and strictly alternating (odd event_no discussed, even withdrawn); the current state is the kind of the highest event_no. Written only by lab.record_result_discussion and lab.withdraw_result_discussion. The withdrawal reason text stays here: it never goes to audit.events, a log or a response.';

-- 2. The functions (S3).
create function lab.result_visit_finished(p_encounter_id uuid, p_lab_request_id uuid, p_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    exists (select 1 from ehr.encounters encounter
             where encounter.id = p_encounter_id and encounter.status = 'completed')
    and exists (select 1 from ehr.lab_requests request
                 where request.id = p_lab_request_id and request.status in ('active', 'on_hold', 'completed'))
    and (p_route_id is null
         or exists (select 1 from ehr.order_routes route
                     where route.id = p_route_id
                       and (route.ended_kind is null or route.ended_kind not in ('wrong_patient', 'entered_in_error')))),
    false)
$$;
comment on function lab.result_visit_finished(uuid, uuid, uuid) is
  '0121 (D-F): whether a Lab result''s visit is finished: its encounter completed, its lab request active, on hold or completed, and its route (if any) seen and not ended wrong_patient or entered_in_error. Read under the caller''s row-level security; a row it cannot see (the route included) reads as not finished. Owner only.';

create function lab.result_discussion_target(p_patient_id uuid, p_result_id uuid)
returns table (
  routed boolean,
  current_version bigint,
  result_facility_id uuid,
  encounter_id uuid,
  lab_request_id uuid,
  route_id uuid
)
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
begin
  -- The local path: the session facility's own result.
  return query
    select false, result_row.current_version, result_row.facility_id, work_item.source_encounter_id,
           work_item.source_ehr_order_id, work_item.order_route_id
      from lab.results result_row
      join lab.test_executions execution
        on execution.id = result_row.execution_id and execution.patient_id = result_row.patient_id
      join lab.work_item_requested_tests requested
        on requested.id = execution.requested_test_id and requested.patient_id = result_row.patient_id
      join lab.work_items work_item
        on work_item.id = requested.work_item_id and work_item.patient_id = result_row.patient_id
     where result_row.id = p_result_id and result_row.patient_id = p_patient_id
       and result_row.facility_id = platform.current_facility_id()
     limit 1;
  if found then
    return;
  end if;
  -- The routed path: a result reported back through a route this facility
  -- ordered for this patient.
  return query
    select true, report.result_version, report.performing_facility_id, route.source_encounter_id,
           route.source_lab_request_id, route.id
      from ehr.order_routes route
      join lateral (
        select released.result_version, released.performing_facility_id
          from lab.order_route_result_reports released
         where released.route_id = route.id and released.result_id = p_result_id and released.kind = 'released'
         order by released.result_version desc
         limit 1) report on true
     where route.patient_id = p_patient_id and route.kind = 'lab_request'
       and route.ordering_facility_id = platform.current_facility_id()
     limit 1;
end
$$;
comment on function lab.result_discussion_target(uuid, uuid) is
  '0121: the result as the session facility sees it (its own result, else one reported back through a route it ordered for this patient): current or last reported version, performing facility and visit. Called by the discussion commands as their owner; no EXECUTE for any role.';

create function lab.patient_self_result_gates(p_patient_id uuid)
returns table (result_id uuid, released_version bigint, finished_visit boolean, discussed boolean)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select result_row.id, release.result_version,
         lab.result_visit_finished(work_item.source_encounter_id, work_item.source_ehr_order_id,
           work_item.order_route_id),
         coalesce((select event.kind = 'discussed'
                     from lab.result_discussion_events event
                    where event.result_id = result_row.id and event.result_version = release.result_version
                      and event.patient_id = result_row.patient_id
                    order by event.event_no desc
                    limit 1), false)
    from lab.results result_row
    join lateral (select max(released.result_version) as result_version
                    from lab.result_releases released
                   where released.result_id = result_row.id and released.patient_id = result_row.patient_id) release
      on release.result_version is not null
    join lab.test_executions execution
      on execution.id = result_row.execution_id and execution.patient_id = result_row.patient_id
    join lab.work_item_requested_tests requested
      on requested.id = execution.requested_test_id and requested.patient_id = result_row.patient_id
    join lab.work_items work_item
      on work_item.id = requested.work_item_id and work_item.patient_id = result_row.patient_id
   where lab.patient_self_context(p_patient_id) and result_row.patient_id = p_patient_id
$$;
comment on function lab.patient_self_result_gates(uuid) is
  '0121: in a patient-self session for this patient only (else no row), one row per released Lab result: its last released version, whether its visit is finished (D-F) and whether a clinician''s mark on that version is active (D-B, D-E). IDs and booleans only.';

create function lab.record_result_discussion(p_patient_id uuid, p_result_id uuid, p_result_version bigint,
  p_idempotency_key text, p_request_sha256 text)
returns table (event_id uuid, event_no integer, state text, occurred_at timestamptz, finished_visit boolean,
  replayed boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  v_correlation text := platform.current_correlation_id();
  v_subject text;
  v_membership uuid;
  v_facility uuid;
  v_account uuid;
  v_prior lab.result_discussion_events%rowtype;
  v_latest lab.result_discussion_events%rowtype;
  v_target record;
  v_finished boolean;
  v_released bigint;
  v_constraint text;
  v_id uuid;
  v_no integer;
  v_at timestamptz;
begin
  -- 1. Context.
  if v_correlation is null or length(v_correlation) not between 8 and 128 then
    raise exception using errcode = '42501', message = 'LAB_CONTEXT_REQUIRED';
  end if;
  if platform.current_purpose_of_use() is distinct from 'direct-care' then
    raise exception using errcode = '42501', message = 'PURPOSE_OF_USE_REQUIRED';
  end if;
  -- 2. Arguments.
  if p_patient_id is null or p_result_id is null or p_result_version is null or p_result_version <= 0
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or p_request_sha256 is null or p_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'RESULT_DISCUSSION_INVALID';
  end if;
  v_subject := platform.current_actor_subject();
  v_membership := platform.current_membership_id();
  v_facility := platform.current_facility_id();
  -- 3. Permission. 4. Care access (D-C).
  if not coalesce(auth.membership_has_permission(v_subject, v_membership, v_facility, 'lab.result.discuss'), false) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if not coalesce(identity.has_active_consent_grant(p_patient_id, v_subject, v_membership, v_facility,
                    'write_records', 'direct-care'), false) then
    raise exception using errcode = '42501', message = 'PATIENT_ACCESS_DENIED';
  end if;
  select membership.account_id into v_account
    from identity.staff_facility_memberships membership
   where membership.id = v_membership and membership.facility_id = v_facility;
  -- 5. Idempotency.
  select * into v_prior
    from lab.result_discussion_events prior_event
   where prior_event.actor_facility_id = v_facility and prior_event.actor_account_id = v_account
     and prior_event.idempotency_key = p_idempotency_key;
  if v_prior.id is not null
     and (v_prior.request_sha256 <> p_request_sha256 or v_prior.kind <> 'discussed'
          or v_prior.result_id <> p_result_id or v_prior.result_version <> p_result_version
          or v_prior.patient_id <> p_patient_id) then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  -- 6. The result as this facility sees it.
  select * into v_target from lab.result_discussion_target(p_patient_id, p_result_id) target;
  if v_target.current_version is null then
    raise exception using errcode = 'P0002', message = 'RESULT_NOT_FOUND';
  end if;
  v_finished := lab.result_visit_finished(v_target.encounter_id, v_target.lab_request_id, v_target.route_id);
  -- 7. The version (a replay skips this, step 9): the last released one, not
  -- entered in error (D-E). On the local path that is the newest release, not
  -- lab.results.current_version, which moves to a correction before it is
  -- released (the list and the patient gate show the released version).
  if v_prior.id is null then
    if not v_target.routed then
      select max(released.result_version) into v_released
        from lab.result_releases released
       where released.result_id = p_result_id;
      if v_released is null or p_result_version > v_released then
        raise exception using errcode = 'P0001', message = 'RESULT_NOT_RELEASED';
      end if;
      if p_result_version < v_released then
        raise exception using errcode = 'P0001', message = 'RESULT_VERSION_CHANGED';
      end if;
      if exists (select 1 from lab.result_invalidations invalidation
                  where invalidation.result_id = p_result_id and invalidation.result_version >= p_result_version) then
        raise exception using errcode = 'P0001', message = 'RESULT_ENTERED_IN_ERROR';
      end if;
    elsif p_result_version <> v_target.current_version then
      raise exception using errcode = 'P0001', message = 'RESULT_VERSION_CHANGED';
    elsif exists (select 1 from lab.order_route_result_reports report
                   where report.route_id = v_target.route_id and report.result_id = p_result_id
                     and report.kind = 'entered_in_error' and report.result_version >= p_result_version) then
      raise exception using errcode = 'P0001', message = 'RESULT_ENTERED_IN_ERROR';
    end if;
  end if;
  -- 8. One writer per (result, version).
  perform pg_advisory_xact_lock(hashtextextended('lab.result_discussion:' || p_result_id::text || ':'
    || p_result_version::text, 0));
  select * into v_latest
    from lab.result_discussion_events latest_event
   where latest_event.result_id = p_result_id and latest_event.result_version = p_result_version
   order by latest_event.event_no desc
   limit 1;
  -- 9. A repeated request, looked up again under the lock (a duplicate sent
  -- while the first was in flight finds it now): its event, while that is still
  -- the version's state; after a later withdrawal the replay would claim a mark
  -- the patient chat no longer honours.
  if v_prior.id is null then
    select * into v_prior
      from lab.result_discussion_events prior_event
     where prior_event.actor_facility_id = v_facility and prior_event.actor_account_id = v_account
       and prior_event.idempotency_key = p_idempotency_key;
    if v_prior.id is not null
       and (v_prior.request_sha256 <> p_request_sha256 or v_prior.kind <> 'discussed'
            or v_prior.result_id <> p_result_id or v_prior.result_version <> p_result_version
            or v_prior.patient_id <> p_patient_id) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
  end if;
  if v_prior.id is not null then
    if v_latest.kind is distinct from 'discussed' then
      raise exception using errcode = 'P0001', message = 'RESULT_DISCUSSION_CHANGED';
    end if;
    return query select v_prior.id, v_prior.event_no, 'discussed'::text, v_prior.occurred_at, v_finished, true;
    return;
  end if;
  -- 10. Already discussed: the existing mark.
  if v_latest.kind = 'discussed' then
    return query select v_latest.id, v_latest.event_no, 'discussed'::text, v_latest.occurred_at, v_finished, true;
    return;
  end if;
  -- 11. The mark. The key raced for another (result, version) (another
  -- advisory lock) meets the key's unique index: a reused key.
  begin
    insert into lab.result_discussion_events as new_event (result_id, result_version, patient_id,
      result_facility_id, event_no, kind, actor_account_id, actor_membership_id, actor_facility_id, idempotency_key,
      request_sha256, correlation_id)
    values (p_result_id, p_result_version, p_patient_id, v_target.result_facility_id,
      coalesce(v_latest.event_no, 0) + 1, 'discussed', v_account, v_membership, v_facility, p_idempotency_key,
      p_request_sha256, v_correlation)
    returning new_event.id, new_event.event_no, new_event.occurred_at into v_id, v_no, v_at;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'result_discussion_events_idempotency_uq' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    raise;
  end;
  return query select v_id, v_no, 'discussed'::text, v_at, v_finished, false;
end
$$;
comment on function lab.record_result_discussion(uuid, uuid, bigint, text, text) is
  '0121: marks one released Lab result version (the last released one) as discussed with the patient (D-A to D-F). 42501 LAB_CONTEXT_REQUIRED, PURPOSE_OF_USE_REQUIRED, PERMISSION_DENIED (lab.result.discuss), PATIENT_ACCESS_DENIED (direct-care write_records); 22023 RESULT_DISCUSSION_INVALID; P0001 IDEMPOTENCY_KEY_REUSED, RESULT_VERSION_CHANGED, RESULT_NOT_RELEASED, RESULT_ENTERED_IN_ERROR, RESULT_DISCUSSION_CHANGED (a repeated request whose mark was withdrawn since); P0002 RESULT_NOT_FOUND. A repeated request or a version already discussed answers the existing mark with replayed true.';

create function lab.withdraw_result_discussion(p_patient_id uuid, p_result_id uuid, p_result_version bigint,
  p_reason_code text, p_reason text, p_idempotency_key text, p_request_sha256 text)
returns table (event_id uuid, event_no integer, state text, occurred_at timestamptz, finished_visit boolean,
  replayed boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  v_correlation text := platform.current_correlation_id();
  v_subject text;
  v_membership uuid;
  v_facility uuid;
  v_account uuid;
  v_prior lab.result_discussion_events%rowtype;
  v_latest lab.result_discussion_events%rowtype;
  v_target record;
  v_finished boolean;
  v_constraint text;
  v_id uuid;
  v_no integer;
  v_at timestamptz;
begin
  -- 1. Context.
  if v_correlation is null or length(v_correlation) not between 8 and 128 then
    raise exception using errcode = '42501', message = 'LAB_CONTEXT_REQUIRED';
  end if;
  if platform.current_purpose_of_use() is distinct from 'direct-care' then
    raise exception using errcode = '42501', message = 'PURPOSE_OF_USE_REQUIRED';
  end if;
  -- 2. Arguments (D-D), the table's rules.
  if p_patient_id is null or p_result_id is null or p_result_version is null or p_result_version <= 0
     or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or p_request_sha256 is null or p_request_sha256 !~ '^[0-9a-f]{64}$'
     or p_reason_code is null
     or p_reason_code not in ('marked_in_error', 'not_yet_discussed', 'wrong_patient', 'other')
     or p_reason is null or p_reason <> btrim(p_reason) or length(p_reason) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'RESULT_DISCUSSION_INVALID';
  end if;
  v_subject := platform.current_actor_subject();
  v_membership := platform.current_membership_id();
  v_facility := platform.current_facility_id();
  -- 3. Permission. 4. Care access (D-C).
  if not coalesce(auth.membership_has_permission(v_subject, v_membership, v_facility, 'lab.result.discuss'), false) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if not coalesce(identity.has_active_consent_grant(p_patient_id, v_subject, v_membership, v_facility,
                    'write_records', 'direct-care'), false) then
    raise exception using errcode = '42501', message = 'PATIENT_ACCESS_DENIED';
  end if;
  select membership.account_id into v_account
    from identity.staff_facility_memberships membership
   where membership.id = v_membership and membership.facility_id = v_facility;
  -- 5. Idempotency.
  select * into v_prior
    from lab.result_discussion_events prior_event
   where prior_event.actor_facility_id = v_facility and prior_event.actor_account_id = v_account
     and prior_event.idempotency_key = p_idempotency_key;
  if v_prior.id is not null
     and (v_prior.request_sha256 <> p_request_sha256 or v_prior.kind <> 'withdrawn'
          or v_prior.result_id <> p_result_id or v_prior.result_version <> p_result_version
          or v_prior.patient_id <> p_patient_id) then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  -- 6. The result as this facility sees it.
  select * into v_target from lab.result_discussion_target(p_patient_id, p_result_id) target;
  if v_target.current_version is null then
    raise exception using errcode = 'P0002', message = 'RESULT_NOT_FOUND';
  end if;
  v_finished := lab.result_visit_finished(v_target.encounter_id, v_target.lab_request_id, v_target.route_id);
  -- 7. The version was released (no currency check: withdrawing is the safe
  -- direction, D-E). A replay skips this (step 9).
  if v_prior.id is null
     and ((not v_target.routed and not exists (
            select 1 from lab.result_releases released
             where released.result_id = p_result_id and released.result_version = p_result_version))
          or (v_target.routed and not exists (
            select 1 from lab.order_route_result_reports report
             where report.route_id = v_target.route_id and report.result_id = p_result_id
               and report.result_version = p_result_version and report.kind = 'released'))) then
    raise exception using errcode = 'P0002', message = 'RESULT_NOT_FOUND';
  end if;
  -- 8. One writer per (result, version).
  perform pg_advisory_xact_lock(hashtextextended('lab.result_discussion:' || p_result_id::text || ':'
    || p_result_version::text, 0));
  select * into v_latest
    from lab.result_discussion_events latest_event
   where latest_event.result_id = p_result_id and latest_event.result_version = p_result_version
   order by latest_event.event_no desc
   limit 1;
  -- 9. A repeated request, looked up again under the lock (a duplicate sent
  -- while the first was in flight finds it now): its event, while that is still
  -- the version's state; after a later mark the replay would tell the
  -- clinician the result is hidden while the patient chat shows it.
  if v_prior.id is null then
    select * into v_prior
      from lab.result_discussion_events prior_event
     where prior_event.actor_facility_id = v_facility and prior_event.actor_account_id = v_account
       and prior_event.idempotency_key = p_idempotency_key;
    if v_prior.id is not null
       and (v_prior.request_sha256 <> p_request_sha256 or v_prior.kind <> 'withdrawn'
            or v_prior.result_id <> p_result_id or v_prior.result_version <> p_result_version
            or v_prior.patient_id <> p_patient_id) then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
  end if;
  if v_prior.id is not null then
    if v_latest.kind is distinct from 'withdrawn' then
      raise exception using errcode = 'P0001', message = 'RESULT_DISCUSSION_CHANGED';
    end if;
    return query select v_prior.id, v_prior.event_no, 'withdrawn'::text, v_prior.occurred_at, v_finished, true;
    return;
  end if;
  -- 10. The withdrawal of the active mark. The key raced for another
  -- (result, version) meets the key's unique index: a reused key.
  if v_latest.id is null or v_latest.kind <> 'discussed' then
    raise exception using errcode = 'P0001', message = 'RESULT_NOT_DISCUSSED';
  end if;
  begin
    insert into lab.result_discussion_events as new_event (result_id, result_version, patient_id,
      result_facility_id, event_no, kind, reason_code, reason, actor_account_id, actor_membership_id,
      actor_facility_id, idempotency_key, request_sha256, correlation_id)
    values (p_result_id, p_result_version, p_patient_id, v_target.result_facility_id, v_latest.event_no + 1,
      'withdrawn', p_reason_code, p_reason, v_account, v_membership, v_facility, p_idempotency_key, p_request_sha256,
      v_correlation)
    returning new_event.id, new_event.event_no, new_event.occurred_at into v_id, v_no, v_at;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'result_discussion_events_idempotency_uq' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    raise;
  end;
  return query select v_id, v_no, 'withdrawn'::text, v_at, v_finished, false;
end
$$;
comment on function lab.withdraw_result_discussion(uuid, uuid, bigint, text, text, text, text) is
  '0121: withdraws the active "Discussed with the patient" mark of one released Lab result version, with a reason code and a reason of 8-500 characters (D-D; the reason is stored only in lab.result_discussion_events). Refusals as lab.record_result_discussion (RESULT_DISCUSSION_CHANGED: a repeated request whose result was marked again since), and P0001 RESULT_NOT_DISCUSSED; no currency check.';

create function lab.list_result_discussions(p_patient_id uuid)
returns table (
  result_id uuid,
  result_version bigint,
  test_code_system text,
  test_code text,
  test_name text,
  abnormal_flag text,
  released_at timestamptz,
  finished_visit boolean,
  discussion_state text,
  discussion_event_no integer,
  discussion_at timestamptz,
  discussion_by_membership_id uuid,
  withdrawal_reason_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  v_correlation text := platform.current_correlation_id();
  v_subject text;
  v_membership uuid;
  v_facility uuid;
begin
  if v_correlation is null or length(v_correlation) not between 8 and 128 then
    raise exception using errcode = '42501', message = 'LAB_CONTEXT_REQUIRED';
  end if;
  if platform.current_purpose_of_use() is distinct from 'direct-care' then
    raise exception using errcode = '42501', message = 'PURPOSE_OF_USE_REQUIRED';
  end if;
  if p_patient_id is null then
    raise exception using errcode = '22023', message = 'RESULT_DISCUSSION_INVALID';
  end if;
  v_subject := platform.current_actor_subject();
  v_membership := platform.current_membership_id();
  v_facility := platform.current_facility_id();
  if not coalesce(auth.membership_has_permission(v_subject, v_membership, v_facility, 'lab.result.released.read'),
                  false) then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;
  if not coalesce(identity.has_active_consent_grant(p_patient_id, v_subject, v_membership, v_facility,
                    'read_records', 'direct-care'), false) then
    raise exception using errcode = '42501', message = 'PATIENT_ACCESS_DENIED';
  end if;
  return query
    select listed.result_id, listed.result_version, listed.test_code_system, listed.test_code, listed.test_name,
           listed.abnormal_flag, listed.released_at, listed.finished_visit, latest.kind, latest.event_no,
           latest.occurred_at, latest.actor_membership_id, latest.reason_code
      from (
        -- The local path: this facility's own results.
        select result_row.id as result_id, release.result_version, requested.code_system as test_code_system,
               requested.code as test_code, requested.name as test_name, revision.abnormal_flag,
               release.released_at,
               lab.result_visit_finished(work_item.source_encounter_id, work_item.source_ehr_order_id,
                 work_item.order_route_id) as finished_visit
          from lab.results result_row
          join lab.test_executions execution
            on execution.id = result_row.execution_id and execution.patient_id = result_row.patient_id
          join lab.work_item_requested_tests requested
            on requested.id = execution.requested_test_id and requested.patient_id = result_row.patient_id
          join lab.work_items work_item
            on work_item.id = requested.work_item_id and work_item.patient_id = result_row.patient_id
          join lateral (select released.result_version, released.released_at
                          from lab.result_releases released
                         where released.result_id = result_row.id
                         order by released.result_version desc
                         limit 1) release on true
          join lab.result_revisions revision
            on revision.result_id = result_row.id and revision.version = release.result_version
         where result_row.patient_id = p_patient_id and result_row.facility_id = v_facility
           and not exists (select 1 from lab.result_invalidations invalidation
                            where invalidation.result_id = result_row.id
                              and invalidation.result_version >= release.result_version)
        union all
        -- The routed path: results reported back through routes this facility
        -- ordered for this patient.
        select report.result_id, report.result_version, report.test_code_system, report.test_code,
               report.test_name, report.abnormal_flag, report.occurred_at,
               lab.result_visit_finished(route.source_encounter_id, route.source_lab_request_id, route.id)
          from ehr.order_routes route
          join lateral (select distinct on (released.result_id) released.*
                          from lab.order_route_result_reports released
                         where released.route_id = route.id and released.kind = 'released'
                         order by released.result_id, released.result_version desc) report on true
         where route.patient_id = p_patient_id and route.kind = 'lab_request'
           and route.ordering_facility_id = v_facility
           and not exists (select 1 from lab.order_route_result_reports in_error
                            where in_error.route_id = route.id and in_error.result_id = report.result_id
                              and in_error.kind = 'entered_in_error'
                              and in_error.result_version >= report.result_version)
      ) listed
      left join lateral (select event.kind, event.event_no, event.occurred_at, event.actor_membership_id,
                                event.reason_code
                           from lab.result_discussion_events event
                          where event.result_id = listed.result_id and event.result_version = listed.result_version
                            and event.patient_id = p_patient_id
                          order by event.event_no desc
                          limit 1) latest on true
     order by listed.released_at desc, listed.result_id;
end
$$;
comment on function lab.list_result_discussions(uuid) is
  '0121: with lab.result.released.read and a direct-care read_records grant, every result of the patient this facility can see (its own, and those reported back through routes it ordered) at its last released, not invalidated version: test, flag, release time, finished visit (D-F) and the latest discussion event on that version (state, number, time, membership, withdrawal reason code; never the reason text). Newest first, every row: lab-api applies the sensitive and critical gate (D-G) and keeps at most 500 gated rows.';

-- 3. The permission (S4, D-A).
insert into auth.permissions (code, description) values
  ('lab.result.discuss', 'Mark a released Lab result as discussed with the patient, or withdraw the mark')
on conflict (code) do update
  set description = excluded.description, active = true;
insert into auth.role_permissions (role_code, permission_code)
select role_row.code, 'lab.result.discuss'
  from auth.roles role_row
 where role_row.code in ('doctor', 'clinician')
on conflict (role_code, permission_code) do nothing;

-- 4. Owners and grants. The tables' owner owns the six functions (a no-op
-- when the applier is that owner).
do $$
declare
  table_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'lab.results'::regclass);
  signature text;
begin
  if (select relation.relowner from pg_class relation
       where relation.oid = 'lab.result_discussion_events'::regclass) <> table_owner then
    execute format('alter table lab.result_discussion_events owner to %I', pg_get_userbyid(table_owner));
  end if;
  foreach signature in array array['lab.result_visit_finished(uuid,uuid,uuid)',
                                   'lab.result_discussion_target(uuid,uuid)',
                                   'lab.patient_self_result_gates(uuid)',
                                   'lab.record_result_discussion(uuid,uuid,bigint,text,text)',
                                   'lab.withdraw_result_discussion(uuid,uuid,bigint,text,text,text,text)',
                                   'lab.list_result_discussions(uuid)'] loop
    if (select proc.proowner from pg_proc proc where proc.oid = signature::regprocedure) <> table_owner then
      execute format('alter function %s owner to %I', signature, pg_get_userbyid(table_owner));
    end if;
  end loop;
end
$$;

-- Here and in runtime-grants.sql.
revoke all on lab.result_discussion_events from public;
revoke all on function lab.result_visit_finished(uuid, uuid, uuid), lab.result_discussion_target(uuid, uuid),
  lab.patient_self_result_gates(uuid), lab.record_result_discussion(uuid, uuid, bigint, text, text),
  lab.withdraw_result_discussion(uuid, uuid, bigint, text, text, text, text), lab.list_result_discussions(uuid)
  from public;

do $$
declare
  grantee text;
begin
  foreach grantee in array array['hid_lab_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function lab.patient_self_result_gates(uuid), '
        || 'lab.record_result_discussion(uuid, uuid, bigint, text, text), '
        || 'lab.withdraw_result_discussion(uuid, uuid, bigint, text, text, text, text), '
        || 'lab.list_result_discussions(uuid) to %I', grantee);
    end if;
  end loop;
end
$$;

-- 5. The policy (S2), last: it holds ACCESS EXCLUSIVE on lab.work_items until
-- commit. For the owner role only.
do $$
begin
  execute format('create policy lab_work_items_patient_result_gate on lab.work_items for select to %I '
    || 'using (lab.patient_self_context(patient_id))',
    pg_get_userbyid((select relation.relowner from pg_class relation where relation.oid = 'lab.work_items'::regclass)));
end
$$;
comment on policy lab_work_items_patient_result_gate on lab.work_items is
  '0121: lets the table owner (only) see a patient''s work items in that patient''s own patient-self session, so lab.patient_self_result_gates can reach the visit under FORCE row-level security. No runtime role is the owner or a member of it.';

-- 6. Post-checks (S5), after the grants, so the ACLs are the final ones.
do $$
declare
  mismatch text;
  table_owner oid := (select relation.relowner from pg_class relation where relation.oid = 'lab.results'::regclass);
begin
  select string_agg(format('%s: owner=%s definer=%s volatile=%s language=%s strict=%s config=%s result=%s',
           proc.oid::regprocedure, pg_get_userbyid(proc.proowner), proc.prosecdef, proc.provolatile,
           language_row.lanname, proc.proisstrict, proc.proconfig, pg_get_function_result(proc.oid)), '; ')
    into mismatch
    from (values
      ('lab.result_visit_finished(uuid,uuid,uuid)', true, 's', 'sql', 'boolean'),
      ('lab.result_discussion_target(uuid,uuid)', false, 's', 'plpgsql',
        'TABLE(routed boolean, current_version bigint, result_facility_id uuid, encounter_id uuid, '
        || 'lab_request_id uuid, route_id uuid)'),
      ('lab.patient_self_result_gates(uuid)', true, 's', 'sql',
        'TABLE(result_id uuid, released_version bigint, finished_visit boolean, discussed boolean)'),
      ('lab.record_result_discussion(uuid,uuid,bigint,text,text)', true, 'v', 'plpgsql',
        'TABLE(event_id uuid, event_no integer, state text, occurred_at timestamp with time zone, '
        || 'finished_visit boolean, replayed boolean)'),
      ('lab.withdraw_result_discussion(uuid,uuid,bigint,text,text,text,text)', true, 'v', 'plpgsql',
        'TABLE(event_id uuid, event_no integer, state text, occurred_at timestamp with time zone, '
        || 'finished_visit boolean, replayed boolean)'),
      ('lab.list_result_discussions(uuid)', true, 's', 'plpgsql',
        'TABLE(result_id uuid, result_version bigint, test_code_system text, test_code text, test_name text, '
        || 'abnormal_flag text, released_at timestamp with time zone, finished_visit boolean, '
        || 'discussion_state text, discussion_event_no integer, discussion_at timestamp with time zone, '
        || 'discussion_by_membership_id uuid, withdrawal_reason_code text)'))
         expected(signature, definer, volatility, language_name, result)
    join pg_proc proc on proc.oid = expected.signature::regprocedure
    join pg_language language_row on language_row.oid = proc.prolang
   where proc.proowner <> table_owner
      or proc.prosecdef <> expected.definer or proc.provolatile <> expected.volatility
      or language_row.lanname <> expected.language_name or proc.proisstrict
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]
      or pg_get_function_result(proc.oid) is distinct from expected.result
      or (expected.language_name = 'plpgsql' and proc.prosrc not like '%#variable_conflict use_column%');
  if mismatch is null
     and (select count(*) from pg_proc proc
           where proc.pronamespace = 'lab'::regnamespace
             and proc.proname in ('result_visit_finished', 'result_discussion_target', 'patient_self_result_gates',
                                  'record_result_discussion', 'withdraw_result_discussion',
                                  'list_result_discussions')) <> 6 then
    mismatch := 'function count';
  end if;
  if mismatch is null and not exists (
       select 1 from pg_class relation
        where relation.oid = 'lab.result_discussion_events'::regclass and relation.relowner = table_owner
          and relation.relrowsecurity and relation.relforcerowsecurity
          and not exists (select 1 from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                           where acl.grantee <> relation.relowner)) then
    mismatch := 'lab.result_discussion_events owner, row-level security or ACL';
  end if;
  if mismatch is null and (
       select string_agg(format('%s:%s:%s:%s', policy_row.polname, policy_row.polcmd, policy_row.polroles,
                pg_get_expr(coalesce(policy_row.polqual, policy_row.polwithcheck), policy_row.polrelid)), ','
                order by policy_row.polname)
         from pg_policy policy_row where policy_row.polrelid = 'lab.result_discussion_events'::regclass)
     is distinct from 'result_discussion_events_command_insert:a:{0}:true,result_discussion_events_command_read:r:{0}:true' then
    mismatch := 'lab.result_discussion_events policies';
  end if;
  if mismatch is null and (
       select count(*) from pg_trigger trigger_row
        where trigger_row.tgrelid = 'lab.result_discussion_events'::regclass
          and trigger_row.tgname = 'result_discussion_events_no_mutation'
          and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure
          and trigger_row.tgenabled = 'O' and trigger_row.tgtype = 27) <> 1 then
    mismatch := 'the append-only trigger';
  end if;
  if mismatch is null and (
       select count(*) from pg_policy policy_row
        where policy_row.polrelid = 'lab.work_items'::regclass
          and policy_row.polname = 'lab_work_items_patient_result_gate'
          and policy_row.polcmd = 'r' and policy_row.polpermissive
          and policy_row.polroles = array[(select relation.relowner from pg_class relation
                                            where relation.oid = 'lab.work_items'::regclass)]
          and pg_get_expr(policy_row.polqual, policy_row.polrelid) = 'lab.patient_self_context(patient_id)') <> 1 then
    mismatch := 'the policy lab_work_items_patient_result_gate';
  end if;
  if mismatch is null and (
       (select array_agg(grant_row.role_code order by grant_row.role_code) from auth.role_permissions grant_row
         where grant_row.permission_code = 'lab.result.discuss') is distinct from array['clinician', 'doctor']
       or not exists (select 1 from auth.permissions permission_row
                       where permission_row.code = 'lab.result.discuss' and permission_row.active)) then
    mismatch := 'the permission lab.result.discuss and its two role rows';
  end if;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0121: not as this file makes it: %s', mismatch);
  end if;
  -- EXECUTE: the four runtime commands to hid_lab_runtime and
  -- hid_schema_test_runtime (where they exist) only; the two helpers to none.
  select string_agg(granted.what, '; ') into mismatch
    from (
      select proc.oid::regprocedure || ' ' || case when acl.grantee = 0 then 'public' else pg_get_userbyid(acl.grantee)::text end
             || ' ' || acl.privilege_type as what
        from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
       where proc.pronamespace = 'lab'::regnamespace
         and proc.proname in ('result_visit_finished', 'result_discussion_target', 'patient_self_result_gates',
                              'record_result_discussion', 'withdraw_result_discussion', 'list_result_discussions')
         and acl.grantee <> proc.proowner
         and (acl.grantee = 0 or proc.proname in ('result_visit_finished', 'result_discussion_target')
              or pg_get_userbyid(acl.grantee) not in ('hid_lab_runtime', 'hid_schema_test_runtime')
              or acl.privilege_type <> 'EXECUTE')
      union all
      select 'missing ' || role_row.rolname || ' EXECUTE on ' || proc.oid::regprocedure
        from pg_roles role_row, pg_proc proc
       where role_row.rolname in ('hid_lab_runtime', 'hid_schema_test_runtime')
         and proc.pronamespace = 'lab'::regnamespace
         and proc.proname in ('patient_self_result_gates', 'record_result_discussion', 'withdraw_result_discussion',
                              'list_result_discussions')
         and not exists (select 1 from aclexplode(proc.proacl) acl
                          where acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE')) granted;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0121: an ACL is not this file''s: %s', mismatch);
  end if;
end
$$;
