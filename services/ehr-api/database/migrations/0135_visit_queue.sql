-- 0135 The waiting list: check-in, stage and assignment (EHR-C7, Release A
-- of the Akos EHR plan of 18 November 2026). Written on
-- staging-novu-ci-20261005 at 1f5e2c2a (live afec3f75 plus a lock-file
-- change); this file requires 0001-0127, 0130, 0131 and 0132 applied (it
-- calls 0131's identity.own_facility_basis and 0132's
-- identity.resolve_patient_search_ref). 0128 (hid-system#264), 0129, 0133
-- and 0134 ship before it and change nothing it reads. The declaration is
-- signed separately (the release integrator's).
--
-- Owner, 18 November 2026: YES to patient names on the waiting list before
-- consent. Q101: a check-in-only visit never makes a patient this
-- facility's own (0131 already ignores a visit nobody started under the
-- patient's grant; the waiting list writes no visit at all). Defaults the
-- owner did not object to: five triage levels; a patient with a deny
-- directive still appears on the waiting list, marked "chart cannot be
-- opened".
--
-- WHAT IT DOES
--   1. ehr.visit_queue: one row per check-in at a facility. The patient, the
--      Lagos calendar day of the check-in, the stage (waiting, triage,
--      ready, with_clinician; then finished, left or cancelled, which close
--      the row), an optional triage level (1 most urgent to 5), an optional
--      assigned nurse, clinician or doctor of the same facility, how the
--      patient was found (search: a matchRef; own_facility: already this
--      facility's patient), who checked the patient in and when, and a row
--      version. No clinical content: no complaint, no note, no vital sign.
--      At most one open row per patient per facility (a unique partial
--      index). It is not a visit: ehr.encounters is untouched, so a
--      check-in is never a basis for opening the chart without a PIN (0131).
--      Row-level security enabled (not forced), no policy and no privilege
--      for any runtime role: only the three functions below (as the table's
--      owner) read or write it.
--   2. ehr.visit_queue_check_in(match ref, patient id) (SECURITY DEFINER),
--      for the EHR runtime. Exactly one of:
--        - a matchRef from a direct-care staff patient search made by this
--          account, membership and facility in the last 10 minutes (0132's
--          identity.resolve_patient_search_ref; an emergency search's
--          matchRef never checks in), or
--        - a patient id of a patient who is already this facility's own
--          (0131's identity.own_facility_basis is not null).
--      Never a bare patient id: any other patient id, an unknown one, an
--      inactive or merged patient or one the facility's seal does not allow
--      answers 'refused', the same for all of them. The caller holds
--      ehr.encounter.read and ehr.encounter.write at the session facility
--      (front desk, nurse, clinician, doctor; not lab or pharmacy staff, who
--      hold read only), for direct care, with an active membership. A
--      patient already on this facility's open list answers 'already_open'
--      with that row; otherwise 'checked_in' with the new row (stage
--      waiting). Under an advisory lock per facility and patient.
--   3. ehr.visit_queue_list(include closed today) (SECURITY DEFINER; not
--      STABLE, as it writes its audit rows), for the EHR runtime: the
--      same caller rule; this facility's open rows (and, when asked, the
--      rows closed today, Lagos day), most urgent first (triage level, then
--      check-in time), at most 200, with has_more when there are more.
--   4. ehr.visit_queue_update(entry id, row version, stage, triage level,
--      clear triage level, assigned membership, clear assignment)
--      (SECURITY DEFINER), for the EHR runtime: the same caller rule; moves
--      an open row of this facility between stages, closes it, sets or
--      clears the triage level and the assignee (an active member of this
--      facility holding ehr.encounter.write and ehr.note.write: nurse,
--      clinician or doctor). Outcomes: updated, not_found (no such row at
--      this facility), changed (another change came first: the row version
--      differs), closed (the row is already closed), assignee_invalid.
--   5. A card, the only patient details any of them answer: the patient's
--      id (a UUID, never a Health ID), full name, sex, date of birth and the
--      last 4 characters of the Health ID, the row's stage, triage level,
--      assignee, basis, check-in time and day, stage time and row version,
--      and chart_blocked: an active deny directive of the patient covers
--      this facility for direct-care reads or writes (owner default: still
--      listed, the chart cannot be opened). Only identity.patients is read
--      for the card; no clinical table is read.
--   6. Audit, written by the functions in the caller's transaction (so a
--      read that answers has its rows): check-in, one row per call
--      (ehr.visit-queue.check-in; success with the patient, or denied with
--      the patient when one was found and with no patient otherwise);
--      list, one collection row (ehr.visit-queue.list, the count, has_more
--      and the patient ids shown) plus one row per patient shown
--      (ehr.visit-queue.list.shown); update, one row (ehr.visit-queue.update,
--      success or denied with the outcome; failure with no patient for
--      not_found). Refusals the functions raise (permission, purpose,
--      invalid input) write nothing here: ehr-api's request audit records
--      those.
--   7. Owners and EXECUTE: the table and functions are owned by the owner of
--      identity.has_active_consent_grant (as 0131's and 0132's); EXECUTE on
--      2-4 for hid_ehr_runtime only (here when the role exists, and in
--      runtime-grants.sql); the card helper for no role.
--
-- Locks (measured with pg_locks before commit on a copy with 0130-0134),
-- taken first (section 0b), NOWAIT: SHARE ROW EXCLUSIVE on identity.patients,
-- identity.facilities and identity.staff_facility_memberships for the
-- foreign keys of a new, empty table (no scan), and ACCESS SHARE on
-- identity.consent_directives, identity.consent_directive_versions and
-- auth.permissions (section 0 and the card helper's body check), held to
-- commit; nothing else. Writes to the three tables wait until the file
-- commits; reads do not.
-- A busy table fails the attempt at once, and its subtransaction releases
-- what it took. The attempt is made again every 100 ms for at most 5 seconds,
-- so the file never waits while holding a lock and no request queues behind
-- a waiting lock; then 55P03 (nothing applied; the release can run again).
-- When this transaction already holds an earlier migration's locks that stop
-- other sessions' reads or writes (the runner's dry run applies every pending
-- file in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied, instead of keeping those locks while this file waits. Indexes are
-- locked only by planning (ACCESS SHARE), which only a REINDEX or DROP INDEX
-- could hold up.
--
-- Old services on this schema: nothing calls the new functions; today's
-- ehr-api answers exactly as before. The ehr-api of this branch needs this
-- file (and 0131 and 0132) before it serves the waiting list routes.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1-7. As above.
-- 8. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regprocedure('identity.organization_staff_kinds(uuid)') is null then
    raise exception using errcode = '55000', message = '0135: 0001-0127 must be applied first';
  end if;
  if to_regprocedure('identity.own_facility_basis(uuid, uuid)') is null
     or (select prorettype from pg_proc where oid = to_regprocedure('identity.own_facility_basis(uuid, uuid)'))
        is distinct from 'text'::regtype then
    raise exception using errcode = '55000', message = '0135: 0131 (identity.own_facility_basis(uuid, uuid) returning text) must be applied first';
  end if;
  if to_regprocedure('identity.resolve_patient_search_ref(text, text)') is null
     or (select prorettype from pg_proc where oid = to_regprocedure('identity.resolve_patient_search_ref(text, text)'))
        is distinct from 'uuid'::regtype then
    raise exception using errcode = '55000', message = '0135: 0132 (identity.resolve_patient_search_ref(text, text) returning uuid) must be applied first';
  end if;
  if to_regclass('ehr.visit_queue') is not null
     or to_regprocedure('ehr.visit_queue_check_in(text, uuid)') is not null
     or to_regprocedure('ehr.visit_queue_list(boolean)') is not null
     or to_regprocedure('ehr.visit_queue_update(uuid, bigint, text, smallint, boolean, uuid, boolean)') is not null
     or to_regprocedure('ehr.visit_queue_cards(uuid[], uuid, uuid, uuid)') is not null then
    raise exception using errcode = '55000', message = '0135: already applied';
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0135: these bodies are not as 0001-0127 left them: ' || mismatch;
  end if;
  if to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('platform.current_purpose_of_use()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null then
    raise exception using errcode = '55000', message = '0135: a function this file calls is missing';
  end if;
  if not exists (select 1 from auth.permissions where code = 'ehr.encounter.read' and active)
     or not exists (select 1 from auth.permissions where code = 'ehr.encounter.write' and active)
     or not exists (select 1 from auth.permissions where code = 'ehr.note.write' and active) then
    raise exception using errcode = '55000', message = '0135: ehr.encounter.read, ehr.encounter.write and ehr.note.write must exist';
  end if;
end
$$;

-- 0b. Locks (see Locks), NOWAIT, at most 5 s; one attempt when this
-- transaction already holds an earlier migration's locks.
do $locks$
declare
  attempt integer := 0;
  holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
begin
  loop
    attempt := attempt + 1;
    begin
      lock table identity.patients, identity.facilities, identity.staff_facility_memberships
        in share row exclusive mode nowait;
      lock table identity.consent_directives, identity.consent_directive_versions, auth.permissions
        in access share mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0135: identity.patients, identity.facilities, identity.staff_facility_memberships or a table 0135 reads (the consent directives, auth.permissions) is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0135: identity.patients, identity.facilities, identity.staff_facility_memberships or a table 0135 reads (the consent directives, auth.permissions) stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The waiting list.
create table ehr.visit_queue (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  queue_day date not null,
  stage text not null default 'waiting'
    check (stage in ('waiting', 'triage', 'ready', 'with_clinician', 'finished', 'left', 'cancelled')),
  triage_level smallint check (triage_level between 1 and 5),
  assigned_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
  check_in_basis text not null check (check_in_basis in ('search', 'own_facility')),
  checked_in_by_account_id uuid not null,
  checked_in_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  checked_in_at timestamptz not null default clock_timestamp(),
  stage_changed_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  updated_by_membership_id uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  constraint visit_queue_closed_ck
    check ((stage in ('finished', 'left', 'cancelled')) = (closed_at is not null)),
  constraint visit_queue_day_ck
    check (queue_day = (checked_in_at at time zone 'Africa/Lagos')::date)
);
create unique index visit_queue_one_open_ux on ehr.visit_queue (facility_id, patient_id) where closed_at is null;
create index visit_queue_open_idx on ehr.visit_queue (facility_id, triage_level, checked_in_at) where closed_at is null;
create index visit_queue_closed_day_idx on ehr.visit_queue (facility_id, queue_day) where closed_at is not null;
create index visit_queue_patient_idx on ehr.visit_queue (patient_id);
create index visit_queue_assigned_idx on ehr.visit_queue (assigned_membership_id) where assigned_membership_id is not null;
create index visit_queue_checked_in_by_idx on ehr.visit_queue (checked_in_by_membership_id);
alter table ehr.visit_queue enable row level security;
revoke all on ehr.visit_queue from public;
comment on table ehr.visit_queue is
  '0135 (EHR-C7): the waiting list. One row per check-in, no clinical content, at most one open row per patient per facility. Not a visit (ehr.encounters is untouched), so never a basis for opening the chart without a PIN. No runtime role reads it; ehr.visit_queue_check_in, ehr.visit_queue_list and ehr.visit_queue_update do, as its owner.';

-- 5. The card (used by 2-4; no EXECUTE for any role).
create function ehr.visit_queue_cards(requested_ids uuid[], viewer_facility uuid, viewer_organization uuid,
  viewer_staff uuid)
returns table (ord bigint, entry_id uuid, patient_id uuid, full_name text, sex text, date_of_birth date,
  health_id_last4 text, stage text, triage_level smallint, assigned_membership_id uuid, check_in_basis text,
  checked_in_at timestamptz, queue_day date, stage_changed_at timestamptz, closed_at timestamptz,
  row_version bigint, chart_blocked boolean)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select ordering.ord_position, entry.id, entry.patient_id, patient.full_name, patient.gender, patient.dob,
         right(patient.hid_code, 4), entry.stage, entry.triage_level, entry.assigned_membership_id,
         entry.check_in_basis, entry.checked_in_at, entry.queue_day, entry.stage_changed_at, entry.closed_at,
         entry.row_version,
         exists (
           select 1
             from identity.consent_directives directive
             join identity.consent_directive_versions directive_version
               on directive_version.directive_id = directive.id
              and directive_version.version_no = directive.current_version
            where directive.patient_id = entry.patient_id
              and directive_version.status = 'active'
              and directive_version.provision_type = 'deny'
              and directive_version.starts_at <= clock_timestamp()
              and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
              and (directive_version.facility_id is null or directive_version.facility_id = viewer_facility)
              and (cardinality(directive_version.actions) = 0
                   or directive_version.actions && array['read_records', 'write_records']::text[])
              and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any (directive_version.purposes))
              and (directive_version.grantee_type = 'all'
                   or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = viewer_facility)
                   or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = viewer_organization)
                   or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = viewer_staff)))
    from unnest(requested_ids) with ordinality ordering(id, ord_position)
    join ehr.visit_queue entry on entry.id = ordering.id and entry.facility_id = viewer_facility
    join identity.patients patient on patient.id = entry.patient_id
   order by ordering.ord_position
$$;
comment on function ehr.visit_queue_cards(uuid[], uuid, uuid, uuid) is
  '0135: the waiting-list card of each given row at the viewer''s facility, in the given order: patient id, full name, sex, date of birth, last 4 characters of the Health ID, stage, triage level, assignee, basis, times, row version, and chart_blocked (an active deny directive covers this facility for direct care). Reads identity.patients and the deny directives only. Called by the waiting-list functions as their owner; no role may execute it.';
revoke all on function ehr.visit_queue_cards(uuid[], uuid, uuid, uuid) from public;

-- 2. Check-in.
create function ehr.visit_queue_check_in(requested_match_ref text, requested_patient_id uuid)
returns table (outcome text, ord bigint, entry_id uuid, patient_id uuid, full_name text, sex text,
  date_of_birth date, health_id_last4 text, stage text, triage_level smallint, assigned_membership_id uuid,
  check_in_basis text, checked_in_at timestamptz, queue_day date, stage_changed_at timestamptz,
  closed_at timestamptz, row_version bigint, chart_blocked boolean)
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
  actor_purpose text := platform.current_purpose_of_use();
  actor_organization uuid;
  actor_staff uuid;
  ref_value text := nullif(btrim(coalesce(requested_match_ref, '')), '');
  patient_value uuid;
  basis_value text;
  refusal text;
  entry_value uuid;
  already boolean := false;
  now_value timestamptz := clock_timestamp();
begin
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.read')
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.write') then
    raise exception using errcode = '42501', message = 'VISIT_QUEUE_NOT_PERMITTED';
  end if;
  select membership.organization_id, membership.staff_id into actor_organization, actor_staff
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = '42501', message = 'VISIT_QUEUE_NOT_PERMITTED';
  end if;
  if actor_purpose is distinct from 'direct-care' then
    raise exception using errcode = '22023', message = 'VISIT_QUEUE_DIRECT_CARE_ONLY';
  end if;
  if (ref_value is null) = (requested_patient_id is null)
     or (ref_value is not null and (length(ref_value) > 200 or ref_value !~ '^[A-Za-z0-9_-]+$')) then
    raise exception using errcode = '22023', message = 'VISIT_QUEUE_CHECK_IN_INVALID';
  end if;

  if ref_value is not null then
    patient_value := identity.resolve_patient_search_ref(ref_value, 'direct-care');
    if patient_value is null then
      refusal := 'match_ref_not_valid';
    else
      basis_value := 'search';
    end if;
  else
    select patient.id into patient_value
      from identity.patients patient
     where patient.id = requested_patient_id and patient.status = 'active'
       and identity.sealed_demo_facility(actor_facility) = identity.sealed_demo_patient(patient.id)
       and identity.sealed_qa_facility(actor_facility) = identity.sealed_qa_patient(patient.id);
    if patient_value is null then
      refusal := 'patient_not_available';
    elsif identity.own_facility_basis(patient_value, actor_facility) is null then
      refusal := 'not_own_facility_patient';
    else
      basis_value := 'own_facility';
    end if;
  end if;

  if refusal is not null then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
      actor_organization, actor_facility,
      case when refusal = 'not_own_facility_patient' then patient_value end,
      'ehr.visit-queue.check-in', 'denied', 'visit-queue-entry', null, actor_purpose, 'application', 'ehr-api',
      jsonb_build_object('by', case when ref_value is not null then 'match_ref' else 'patient_id' end,
        'refusal', refusal)
    );
    outcome := 'refused';
    return next;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'visit-queue:' || actor_facility::text || ':' || patient_value::text, 0));
  select entry.id into entry_value
    from ehr.visit_queue entry
   where entry.facility_id = actor_facility and entry.patient_id = patient_value and entry.closed_at is null;
  if found then
    already := true;
  else
    insert into ehr.visit_queue (facility_id, patient_id, queue_day, check_in_basis, checked_in_by_account_id,
      checked_in_by_membership_id, checked_in_at, stage_changed_at, updated_by_membership_id, updated_at)
    values (actor_facility, patient_value, (now_value at time zone 'Africa/Lagos')::date, basis_value, actor_account,
      actor_membership, now_value, now_value, actor_membership, now_value)
    returning id into entry_value;
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, patient_value, 'ehr.visit-queue.check-in', 'success',
    'visit-queue-entry', entry_value::text, actor_purpose, 'application', 'ehr-api',
    jsonb_build_object('by', case when ref_value is not null then 'match_ref' else 'patient_id' end,
      'basis', basis_value, 'alreadyOpen', already)
  );

  return query
    select case when already then 'already_open' else 'checked_in' end, card.*
      from ehr.visit_queue_cards(array[entry_value], actor_facility, actor_organization, actor_staff) card;
end
$$;
comment on function ehr.visit_queue_check_in(text, uuid) is
  '0135 (EHR-C7; owner, 18 November 2026): check a patient in on this facility''s waiting list. Exactly one of a matchRef from this member''s own direct-care staff patient search in the last 10 minutes (0132) or the id of a patient who is already this facility''s own (0131 basis); never a bare patient id (anything else answers refused, the same for every reason). Needs ehr.encounter.read and ehr.encounter.write here, for direct care. Answers checked_in or already_open with the card. Writes no visit. Audited (ehr.visit-queue.check-in).';
revoke all on function ehr.visit_queue_check_in(text, uuid) from public;

-- 3. The list.
create function ehr.visit_queue_list(requested_include_closed_today boolean)
returns table (ord bigint, entry_id uuid, patient_id uuid, full_name text, sex text, date_of_birth date,
  health_id_last4 text, stage text, triage_level smallint, assigned_membership_id uuid, check_in_basis text,
  checked_in_at timestamptz, queue_day date, stage_changed_at timestamptz, closed_at timestamptz,
  row_version bigint, chart_blocked boolean, has_more boolean)
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
  actor_purpose text := platform.current_purpose_of_use();
  actor_organization uuid;
  actor_staff uuid;
  list_limit constant integer := 200;
  today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  found_ids uuid[];
  shown_ids uuid[];
  shown_patients uuid[];
  more boolean;
begin
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.read')
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.write') then
    raise exception using errcode = '42501', message = 'VISIT_QUEUE_NOT_PERMITTED';
  end if;
  select membership.organization_id, membership.staff_id into actor_organization, actor_staff
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = '42501', message = 'VISIT_QUEUE_NOT_PERMITTED';
  end if;
  if actor_purpose is distinct from 'direct-care' then
    raise exception using errcode = '22023', message = 'VISIT_QUEUE_DIRECT_CARE_ONLY';
  end if;

  select array_agg(listed.id order by listed.closed_first, listed.level_order, listed.checked_in_at, listed.id)
    into found_ids
    from (
      select entry.id, (entry.closed_at is not null) as closed_first, coalesce(entry.triage_level, 6) as level_order,
             entry.checked_in_at
        from ehr.visit_queue entry
       where entry.facility_id = actor_facility
         and (entry.closed_at is null
              or (coalesce(requested_include_closed_today, false) and entry.queue_day = today
                  and entry.closed_at is not null))
       order by (entry.closed_at is not null), coalesce(entry.triage_level, 6), entry.checked_in_at, entry.id
       limit list_limit + 1
    ) listed;
  more := coalesce(cardinality(found_ids), 0) > list_limit;
  shown_ids := coalesce(found_ids[1:list_limit], array[]::uuid[]);
  select coalesce(array_agg(entry.patient_id order by ordering.ord_position), array[]::uuid[]) into shown_patients
    from unnest(shown_ids) with ordinality ordering(id, ord_position)
    join ehr.visit_queue entry on entry.id = ordering.id;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, null, 'ehr.visit-queue.list', 'success',
    'visit-queue', null, actor_purpose, 'application', 'ehr-api',
    jsonb_build_object('includeClosedToday', coalesce(requested_include_closed_today, false),
      'resultCount', cardinality(shown_ids), 'hasMore', more, 'patientIds', to_jsonb(shown_patients))
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  )
  select actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
         actor_organization, actor_facility, entry.patient_id, 'ehr.visit-queue.list.shown', 'success',
         'visit-queue-entry', entry.id::text, actor_purpose, 'application', 'ehr-api',
         jsonb_build_object('stage', entry.stage)
    from unnest(shown_ids) with ordinality ordering(id, ord_position)
    join ehr.visit_queue entry on entry.id = ordering.id
   order by ordering.ord_position;

  return query
    select card.*, more
      from ehr.visit_queue_cards(shown_ids, actor_facility, actor_organization, actor_staff) card;
end
$$;
comment on function ehr.visit_queue_list(boolean) is
  '0135 (EHR-C7; owner, 18 November 2026: names on the waiting list before consent): this facility''s open waiting-list rows (and, when asked, those closed today, Lagos day), most urgent first, at most 200, has_more when there are more. Needs ehr.encounter.read and ehr.encounter.write here (front desk, nurse, clinician, doctor; not lab or pharmacy staff), for direct care. Cards only (name, sex, date of birth, last 4 of the Health ID); no clinical content. Audited: one ehr.visit-queue.list row and one ehr.visit-queue.list.shown row per patient shown.';
revoke all on function ehr.visit_queue_list(boolean) from public;

-- 4. Stage, triage level and assignee.
create function ehr.visit_queue_update(requested_entry_id uuid, requested_row_version bigint, requested_stage text,
  requested_triage_level smallint, requested_clear_triage boolean, requested_assigned_membership_id uuid,
  requested_clear_assignment boolean)
returns table (outcome text, ord bigint, entry_id uuid, patient_id uuid, full_name text, sex text,
  date_of_birth date, health_id_last4 text, stage text, triage_level smallint, assigned_membership_id uuid,
  check_in_basis text, checked_in_at timestamptz, queue_day date, stage_changed_at timestamptz,
  closed_at timestamptz, row_version bigint, chart_blocked boolean)
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
  actor_purpose text := platform.current_purpose_of_use();
  actor_organization uuid;
  actor_staff uuid;
  entry_row ehr.visit_queue%rowtype;
  outcome_value text;
  assignee_subject text;
  closing boolean;
  now_value timestamptz := clock_timestamp();
begin
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.read')
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.encounter.write') then
    raise exception using errcode = '42501', message = 'VISIT_QUEUE_NOT_PERMITTED';
  end if;
  select membership.organization_id, membership.staff_id into actor_organization, actor_staff
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = '42501', message = 'VISIT_QUEUE_NOT_PERMITTED';
  end if;
  if actor_purpose is distinct from 'direct-care' then
    raise exception using errcode = '22023', message = 'VISIT_QUEUE_DIRECT_CARE_ONLY';
  end if;
  if requested_entry_id is null or requested_row_version is null or requested_row_version < 1
     or (requested_stage is not null
         and requested_stage not in ('waiting', 'triage', 'ready', 'with_clinician', 'finished', 'left', 'cancelled'))
     or (requested_triage_level is not null and requested_triage_level not between 1 and 5)
     or (requested_triage_level is not null and coalesce(requested_clear_triage, false))
     or (requested_assigned_membership_id is not null and coalesce(requested_clear_assignment, false))
     or (requested_stage is null and requested_triage_level is null and not coalesce(requested_clear_triage, false)
         and requested_assigned_membership_id is null and not coalesce(requested_clear_assignment, false)) then
    raise exception using errcode = '22023', message = 'VISIT_QUEUE_UPDATE_INVALID';
  end if;

  select entry.* into entry_row
    from ehr.visit_queue entry
   where entry.id = requested_entry_id and entry.facility_id = actor_facility
   for update;
  if not found then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
      actor_organization, actor_facility, null, 'ehr.visit-queue.update', 'failure',
      'visit-queue-entry', requested_entry_id::text, actor_purpose, 'application', 'ehr-api',
      jsonb_build_object('outcome', 'not_found')
    );
    outcome := 'not_found';
    return next;
    return;
  end if;

  if entry_row.closed_at is not null then
    outcome_value := 'closed';
  elsif entry_row.row_version <> requested_row_version then
    outcome_value := 'changed';
  elsif requested_assigned_membership_id is not null then
    select account_row.subject into assignee_subject
      from identity.staff_facility_memberships membership
      join auth.accounts account_row on account_row.id = membership.account_id
     where membership.id = requested_assigned_membership_id and membership.facility_id = actor_facility
       and membership.active and membership.migration_hold_reason is null;
    if assignee_subject is null
       or not auth.membership_has_permission(assignee_subject, requested_assigned_membership_id, actor_facility,
                                             'ehr.encounter.write')
       or not auth.membership_has_permission(assignee_subject, requested_assigned_membership_id, actor_facility,
                                             'ehr.note.write') then
      outcome_value := 'assignee_invalid';
    end if;
  end if;

  if outcome_value is not null then
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    ) values (
      actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
      actor_organization, actor_facility, entry_row.patient_id, 'ehr.visit-queue.update', 'denied',
      'visit-queue-entry', entry_row.id::text, actor_purpose, 'application', 'ehr-api',
      jsonb_build_object('outcome', outcome_value)
    );
    return query
      select outcome_value, card.*
        from ehr.visit_queue_cards(array[entry_row.id], actor_facility, actor_organization, actor_staff) card;
    return;
  end if;

  closing := coalesce(requested_stage in ('finished', 'left', 'cancelled'), false);
  update ehr.visit_queue entry
     set stage = coalesce(requested_stage, entry.stage),
         stage_changed_at = case when requested_stage is not null and requested_stage <> entry.stage
                                 then now_value else entry.stage_changed_at end,
         closed_at = case when closing then now_value else null end,
         triage_level = case when coalesce(requested_clear_triage, false) then null
                             else coalesce(requested_triage_level, entry.triage_level) end,
         assigned_membership_id = case when coalesce(requested_clear_assignment, false) then null
                                       else coalesce(requested_assigned_membership_id, entry.assigned_membership_id) end,
         updated_by_membership_id = actor_membership,
         updated_at = now_value,
         row_version = entry.row_version + 1
   where entry.id = entry_row.id;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, entry_row.patient_id, 'ehr.visit-queue.update', 'success',
    'visit-queue-entry', entry_row.id::text, actor_purpose, 'application', 'ehr-api',
    jsonb_build_object('outcome', 'updated', 'fromStage', entry_row.stage,
      'stage', coalesce(requested_stage, entry_row.stage),
      'triageLevelChanged', requested_triage_level is not null or coalesce(requested_clear_triage, false),
      'assigneeChanged', requested_assigned_membership_id is not null or coalesce(requested_clear_assignment, false))
  );

  return query
    select 'updated', card.*
      from ehr.visit_queue_cards(array[entry_row.id], actor_facility, actor_organization, actor_staff) card;
end
$$;
comment on function ehr.visit_queue_update(uuid, bigint, text, smallint, boolean, uuid, boolean) is
  '0135 (EHR-C7): move an open waiting-list row of this facility between stages (waiting, triage, ready, with_clinician), close it (finished, left, cancelled), set or clear its triage level (1-5) and its assignee (an active nurse, clinician or doctor here: ehr.encounter.write and ehr.note.write). Needs ehr.encounter.read and ehr.encounter.write here, for direct care, and the row version read. Outcomes updated, not_found, changed, closed, assignee_invalid. Audited (ehr.visit-queue.update).';
revoke all on function ehr.visit_queue_update(uuid, bigint, text, smallint, boolean, uuid, boolean) from public;

-- 7. Owners and EXECUTE.
do $$
declare
  grant_owner name := (select pg_get_userbyid(proowner) from pg_proc
                        where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
begin
  if grant_owner <> current_user then
    execute format('alter table ehr.visit_queue owner to %I', grant_owner);
    execute format('alter function ehr.visit_queue_cards(uuid[], uuid, uuid, uuid) owner to %I', grant_owner);
    execute format('alter function ehr.visit_queue_check_in(text, uuid) owner to %I', grant_owner);
    execute format('alter function ehr.visit_queue_list(boolean) owner to %I', grant_owner);
    execute format('alter function ehr.visit_queue_update(uuid, bigint, text, smallint, boolean, uuid, boolean) owner to %I', grant_owner);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.visit_queue_check_in(text, uuid), ehr.visit_queue_list(boolean),
      ehr.visit_queue_update(uuid, bigint, text, smallint, boolean, uuid, boolean) to hid_ehr_runtime;
  end if;
end
$$;

-- 8. Post-checks.
do $$
begin
  if exists (select 1 from pg_class class_row, lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid = 'ehr.visit_queue'::regclass and acl.grantee <> class_row.relowner) then
    raise exception using errcode = '55000', message = '0135: ehr.visit_queue is granted to a role';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'ehr.visit_queue'::regclass) then
    raise exception using errcode = '55000', message = '0135: row-level security is not enabled on ehr.visit_queue';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('ehr.visit_queue_check_in(text, uuid)'::regprocedure,
                                 'ehr.visit_queue_list(boolean)'::regprocedure,
                                 'ehr.visit_queue_update(uuid, bigint, text, smallint, boolean, uuid, boolean)'::regprocedure)
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime')) then
    raise exception using errcode = '55000', message = '0135: a waiting-list function is granted to a role other than hid_ehr_runtime';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = 'ehr.visit_queue_cards(uuid[], uuid, uuid, uuid)'::regprocedure
                and acl.grantee <> proc.proowner) then
    raise exception using errcode = '55000', message = '0135: ehr.visit_queue_cards is granted to a role';
  end if;
  if (select count(*) from pg_proc
       where oid in ('ehr.visit_queue_check_in(text, uuid)'::regprocedure, 'ehr.visit_queue_list(boolean)'::regprocedure,
                     'ehr.visit_queue_update(uuid, bigint, text, smallint, boolean, uuid, boolean)'::regprocedure)
         and prosecdef and proconfig = array['search_path=pg_catalog, pg_temp']) <> 3 then
    raise exception using errcode = '55000', message = '0135: a waiting-list function is not SECURITY DEFINER with a fixed search_path';
  end if;
end
$$;
