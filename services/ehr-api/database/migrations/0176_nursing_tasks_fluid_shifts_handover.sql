-- 0176 NUR-1 Nursing on the ward: nursing tasks, fluid balance, clinical
-- shifts and assignments, and shift handover (Release D, the department sprint
-- the owner approved on 25 November 2026, verbatim: "I approve Q147–Q290 at
-- the recommended options"). Written on claude/sprint-inpatient-backend at
-- e224bc62 (staging at 0cfddcc9: 0001-0153 applied) after 0174 and 0175 in the
-- same pull request. The number is provisional (given at merge). The
-- declaration in config/production-schema-compatibility.json stays unsigned
-- until the owner signs this file.
--
-- Owner decisions (25 November 2026, each at its recommended option): Q193 A
-- (clinical shifts defined once here, reused by the Duty roster; the cashier's
-- day is the "till day"), Q194 A (critical results on wards also reach the
-- nurses on shift and the on-call doctor), Q201 A and Q202 A (the ICU chart's
-- hourly fluid balance), Q156 A (ward-team access, still switched off), and the
-- section's smaller choices Q-NUR-6 A (fluid balance is part of the
-- observation chart: the vitals codes), Q-NUR-13 A (task name, due time and
-- assignee on the ward's list; the completion record is chart content),
-- Q-NUR-15 A (a fluid day runs from 07:00 to 07:00 Lagos time; the facility
-- can choose another start hour) and Q-NUR-16 A (no shift is seeded for real
-- facilities).
--
-- What it changes (nothing else):
-- T1 ehr.nursing_tasks: admission, facility, patient, name (1-120), due_at,
--    assigned_membership_id, repeat_every_hours (1-168), status (assigned,
--    in_progress, completed, cancelled), started, completed (with
--    completion_record, 1-2000) and cancelled (cancel_reason, 8-300) with who
--    and when, previous_task_id (repeats), who created and changed it,
--    row_version. Never deleted.
-- T2 ehr.fluid_balance_entries: admission, visit, patient, facility,
--    direction (in, out), kind (intake: oral, iv, enteral_tube, blood_product,
--    other; output: urine, vomit, drain, stool, tube_aspirate, blood_loss,
--    other), volume_ml (1-10000) or not_measured, recorded_at, note (0-200),
--    status (recorded, entered_in_error) with reason, member and time.
--    One-way status change only; never deleted.
-- T3 ehr.facility_nursing_settings: facility, fluid_day_starts_at_hour (0-23,
--    7 when the facility has no row).
-- T4 ehr.clinical_shifts: facility, name (1-40, unique among the facility's
--    active shifts in any case), starts_at and ends_at (Lagos time; a shift may
--    cross midnight), active, row_version. Never deleted; up to 8 active.
-- T5 ehr.shift_assignments: facility, shift_date (Lagos), shift, ward,
--    membership, duty (nurse, nurse_in_charge, on_call_doctor); unique per
--    (date, shift, ward, member); one nurse in charge and one on-call doctor
--    per (date, shift, ward). ehr.shift_patient_allocations: the assignment and
--    the admission; unique (date, shift, admission), so a patient has one nurse
--    per shift. ehr.shift_assignment_events: every replacement of a ward's list
--    (ids only), append only, numbered per (date, shift, ward).
-- T6 ehr.shift_handovers: ward, shift_date, shift, status (draft, given,
--    accepted), who gave and accepted it and when; unique (ward, date, shift).
--    ehr.shift_handover_items: the sheet, the admission, the clinical note
--    (type "Nursing handover", on the stay's visit), watch.
-- T7 Functions (SECURITY DEFINER, search_path pg_catalog, pg_temp, owned like
--    0135's, EXECUTE for hid_ehr_runtime only) for routes 8-18:
--    ehr.nursing_task_list, ehr.nursing_task_create, ehr.nursing_task_start,
--    ehr.nursing_task_complete, ehr.nursing_task_cancel,
--    ehr.nursing_task_update, ehr.fluid_balance_read, ehr.fluid_balance_record,
--    ehr.fluid_balance_entered_in_error, ehr.clinical_shift_list,
--    ehr.clinical_shift_create, ehr.clinical_shift_update,
--    ehr.shift_assignments_read, ehr.shift_assignments_set, ehr.handover_read,
--    ehr.handover_note_put, ehr.handover_give, ehr.handover_accept. Helpers no
--    role may execute: ehr.nursing_task_json, ehr.clinical_shift_window,
--    ehr.clinical_shifts_at, ehr.clinical_shift_next,
--    ehr.nursing_fluid_day_start_hour, ehr.nursing_tasks_close_for_discharge
--    (called from the trigger admissions_nursing_tasks_close, AFTER UPDATE OF
--    status on ehr.admissions, so 0171's discharge body does not change: a
--    discharge or a cancel cancels the stay's open tasks with the reason
--    "Discharged"), and the guards.
-- T8 Replaced, md5-pinned before and after:
--    - 0174's ehr.observation_fluid_hours: the hourly fluid in, out and
--      running balance of the ICU grid (the running balance restarts at the
--      fluid day's start);
--    - 0171's ehr.admission_notice_recipients (Q194 A): the responsible doctor,
--      and now the nurses allocated to the patient on the current shift, the
--      ward's nurse in charge and its on-call doctor;
--    - 0173's identity.open_ward_stay (Q156 A, still switched off): a nurse
--      allocated to the patient on the current clinical shift counts as the
--      patient's ward team for that shift (only the ward-team condition
--      changes). Rahman and the DPO review this part as an identity and consent
--      change.
-- T9 Audit, in the request's transaction: ehr.nursing-task.list (with .shown
--    per patient), .create, .start, .complete, .cancel, .update;
--    ehr.fluid-balance.read, .record, .entered-in-error;
--    ehr.clinical-shift.create, .update; ehr.shift-assignment.set;
--    ehr.handover.read (with .shown per patient), .note, .give, .accept. Rows
--    hold ids, outcomes, codes and counts; never a name, task name, value,
--    note text, completion record or reason text. This file writes no audit
--    row: it changes no existing row.
--
-- Locks (measured with pg_locks before commit and compared by the migrations
-- suite), taken first, NOWAIT: SHARE ROW EXCLUSIVE on ehr.admissions (the new
-- tables' foreign keys and the trigger), ehr.wards, ehr.encounters,
-- ehr.clinical_notes, identity.facilities, identity.patients and
-- identity.staff_facility_memberships (foreign keys of new, empty tables); ROW
-- EXCLUSIVE on audit.events; ACCESS SHARE on ehr.beds, ehr.vitals,
-- ehr.vital_corrections, ehr.clinical_note_revisions,
-- ehr.medication_administrations, ehr.inpatient_switches and
-- auth.account_roles (named by the bodies or read by the post-checks).
-- A busy table fails the attempt at once, and its subtransaction releases what
-- it took. The attempt is made 50 times, 100 ms apart (about 5 seconds); then
-- 55P03 (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes, one attempt
-- and no sleep: 55P03 at once, nothing applied. Both refusals begin "0176: "
-- and end "run the release again at a quieter time" (#306).
--
-- Old images on this schema: nothing calls the new functions. The trigger on
-- ehr.admissions finds no task while no one can make one (0177), and ADT-1's
-- image is unchanged by it.
--
-- Undo (not in the ledger; a migration only if the owner signs it): put the
-- three replaced bodies back, drop the trigger, the functions and the nine
-- tables.
--
-- The whole file is one statement (do $nur0176$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0170, 0171, 0173, 0174 and 0175
--    applied; "0176: already applied" when every object of this file is there;
--    "0176: the schema is not in the reviewed state" for any half state; the
--    bodies it calls or replaces md5-pinned.
-- 2. T1-T8.
-- 3. Post-checks: the tables' row-level security and privileges, the trigger,
--    the replaced bodies (md5), the functions' security and grants, no audit
--    row written.

do $nur0176$
declare
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_mismatch text;
  v_present integer;
  v_owner name;
  v_audit_rows bigint;
  v_definition text;
  v_old_team constant text := E'    elsif not (admission_row.responsible_membership_id = actor_membership\n'
    || E'               or exists (select 1 from ehr.ward_staff staff where staff.ward_id = admission_row.ward_id\n'
    || E'                           and staff.membership_id = actor_membership)) then\n';
  v_new_team constant text := E'    elsif not (admission_row.responsible_membership_id = actor_membership\n'
    || E'               or exists (select 1 from ehr.ward_staff staff where staff.ward_id = admission_row.ward_id\n'
    || E'                           and staff.membership_id = actor_membership)\n'
    || E'               -- 0176 (NUR-1, Q193 A): a nurse allocated to the patient on the current clinical shift.\n'
    || E'               or exists (select 1 from ehr.shift_patient_allocations allocation\n'
    || E'                            join ehr.clinical_shifts_at(actor_facility, clock_timestamp()) current_shift\n'
    || E'                              on current_shift.shift_id = allocation.shift_id\n'
    || E'                             and current_shift.shift_date = allocation.shift_date\n'
    || E'                           where allocation.admission_id = admission_row.id\n'
    || E'                             and allocation.membership_id = actor_membership)) then\n';
  v_tables constant text[] := array['ehr.nursing_tasks', 'ehr.fluid_balance_entries', 'ehr.facility_nursing_settings',
    'ehr.clinical_shifts', 'ehr.shift_assignments', 'ehr.shift_patient_allocations', 'ehr.shift_assignment_events',
    'ehr.shift_handovers', 'ehr.shift_handover_items'];
  v_runtime constant text[] := array['nursing_task_list', 'nursing_task_create', 'nursing_task_start',
    'nursing_task_complete', 'nursing_task_cancel', 'nursing_task_update', 'fluid_balance_read',
    'fluid_balance_record', 'fluid_balance_entered_in_error', 'clinical_shift_list', 'clinical_shift_create',
    'clinical_shift_update', 'shift_assignments_read', 'shift_assignments_set', 'handover_read', 'handover_note_put',
    'handover_give', 'handover_accept'];
begin
  -- Before the locks (catalog reads only): the files whose tables step 0 locks.
  if to_regclass('ehr.admissions') is null or to_regclass('ehr.wards') is null
     or to_regclass('ehr.medication_administrations') is null then
    raise exception using errcode = '55000', message = '0176: 0170, 0171 and 0175 must be applied first';
  end if;

  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table ehr.admissions, ehr.wards, ehr.encounters, ehr.clinical_notes, identity.facilities, identity.patients,
    identity.staff_facility_memberships in share row exclusive mode nowait;
  lock table audit.events in row exclusive mode nowait;
  lock table ehr.beds, ehr.vitals, ehr.vital_corrections, ehr.clinical_note_revisions, ehr.medication_administrations,
    ehr.inpatient_switches, auth.account_roles in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0176: the admissions, wards, visits, clinical notes, facilities, patients or staff memberships, '
          || 'audit.events or a table 0176 reads is busy, and this transaction already holds an earlier migration''s '
          || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0176: the admissions, wards, visits, clinical notes, facilities, patients or staff memberships, '
          || 'audit.events or a table 0176 reads stayed busy for 5 seconds; nothing applied; run the release again '
          || 'at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regprocedure('identity.open_ward_stay(uuid)') is null
     or to_regprocedure('ehr.mar_due_doses(uuid, timestamptz, timestamptz)') is null
     or to_regprocedure('ehr.observation_fluid_hours(uuid, timestamptz, timestamptz)') is null then
    raise exception using errcode = '55000', message = '0176: 0173, 0174 and 0175 must be applied first';
  end if;
  select count(*) into v_present
    from (select to_regclass(table_name)::oid as object_id from unnest(v_tables) table_name
          union all select to_regprocedure('ehr.handover_accept(uuid, bigint, text, text)')::oid
          union all select (select trigger_row.oid from pg_trigger trigger_row
                             where trigger_row.tgrelid = 'ehr.admissions'::regclass
                               and trigger_row.tgname = 'admissions_nursing_tasks_close')) present
   where present.object_id is not null;
  if v_present = 11
     and (select md5(prosrc) from pg_proc where oid = 'ehr.admission_notice_recipients(uuid)'::regprocedure)
         <> '38097e2f83954868d0fb2f971e49e9c9' then
    raise exception using errcode = '55000', message = '0176: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'nursing\_task%' or proc.proname like 'fluid\_balance\_%'
                        or proc.proname like 'clinical\_shift%' or proc.proname like 'shift\_%'
                        or proc.proname like 'handover\_%' or proc.proname = 'nursing_fluid_day_start_hour')) then
    raise exception using errcode = '55000',
      message = '0176: the schema is not in the reviewed state (part of 0176 is there); nothing applied';
  end if;
  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('ehr.inpatient_audit(uuid,text,text,text,text,jsonb)', '81c360af02e3cd2ddb8f3a4fb3041dd2'),
      ('ehr.admission_cards(uuid[],boolean)', '15a3e73ce20f39c5c941237c468aeb68'),
      ('ehr.inpatient_member_has_role(uuid,uuid,text[])', '6fe87cf420a6ee48fa20f397191aa866'),
      ('ehr.nursing_caller(text,text[])', 'afe0851769a0403fff7f0df4adbfbf6e'),
      ('ehr.observation_fluid_hours(uuid,timestamp with time zone,timestamp with time zone)',
       'c15ad3a0e447fafd48a7d4b8f1630f0c'),
      ('ehr.admission_notice_recipients(uuid)', '38097e2f83954868d0fb2f971e49e9c9'),
      ('identity.open_ward_stay(uuid)', '8c5a8d1c2440c505753f07f42bc5a81a'),
      ('ehr.admission_discharge(uuid,bigint,text,timestamp with time zone,jsonb,text,timestamp with time zone,text,text,text)',
       '21945aa0791c9c89af7c3944706c1df6')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0176: these bodies are not as 0001-0175 left them: ' || v_mismatch;
  end if;
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  select count(*) into v_audit_rows from audit.events;

  -- T3. Facility nursing settings.
  create table ehr.facility_nursing_settings (
    facility_id uuid primary key references identity.facilities(id) on delete restrict,
    fluid_day_starts_at_hour smallint not null default 7 check (fluid_day_starts_at_hour between 0 and 23),
    updated_at timestamptz not null default clock_timestamp()
  );
  alter table ehr.facility_nursing_settings enable row level security;
  revoke all on ehr.facility_nursing_settings from public;
  comment on table ehr.facility_nursing_settings is
    '0176 (NUR-1, Q-NUR-15 A): the hour (Lagos time) a facility''s fluid day starts; 7 when the facility has no row.';

  -- T4. Clinical shifts.
  create table ehr.clinical_shifts (
    id uuid primary key default gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    name text not null check (name = btrim(name) and length(name) between 1 and 40 and name !~ '[[:cntrl:]]'),
    starts_at time not null,
    ends_at time not null,
    active boolean not null default true,
    created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    unique (id, facility_id),
    constraint clinical_shifts_times_ck check (starts_at <> ends_at
      and date_trunc('minute', starts_at) = starts_at and date_trunc('minute', ends_at) = ends_at)
  );
  create unique index clinical_shifts_active_name_ux on ehr.clinical_shifts (facility_id, lower(name)) where active;
  alter table ehr.clinical_shifts enable row level security;
  revoke all on ehr.clinical_shifts from public;
  comment on table ehr.clinical_shifts is
    '0176 (NUR-1, Q193 A): a facility''s clinical shifts (Lagos times; a shift may cross midnight), defined once and reused by the Duty roster. Never deleted; up to 8 active.';

  -- T5. Assignments, patient allocations and their history.
  create table ehr.shift_assignments (
    id uuid primary key default gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    shift_date date not null,
    shift_id uuid not null,
    ward_id uuid not null,
    membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    duty text not null check (duty in ('nurse', 'nurse_in_charge', 'on_call_doctor')),
    set_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    set_at timestamptz not null default clock_timestamp(),
    constraint shift_assignments_shift_fk foreign key (shift_id, facility_id)
      references ehr.clinical_shifts(id, facility_id) on delete restrict,
    constraint shift_assignments_ward_fk foreign key (ward_id, facility_id)
      references ehr.wards(id, facility_id) on delete restrict,
    unique (shift_date, shift_id, ward_id, membership_id)
  );
  create unique index shift_assignments_in_charge_ux on ehr.shift_assignments (shift_date, shift_id, ward_id)
    where duty = 'nurse_in_charge';
  create unique index shift_assignments_on_call_ux on ehr.shift_assignments (shift_date, shift_id, ward_id)
    where duty = 'on_call_doctor';
  create index shift_assignments_member_idx on ehr.shift_assignments (membership_id, shift_date);
  alter table ehr.shift_assignments enable row level security;
  revoke all on ehr.shift_assignments from public;
  comment on table ehr.shift_assignments is
    '0176 (NUR-1, Q193 A): who works a ward on a clinical shift of a Lagos date, and as what (nurse, nurse in charge, on-call doctor). An assignment opens no chart. Every replacement is kept in ehr.shift_assignment_events.';

  create table ehr.shift_patient_allocations (
    assignment_id uuid not null references ehr.shift_assignments(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    shift_date date not null,
    shift_id uuid not null,
    ward_id uuid not null,
    membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    admission_id uuid not null references ehr.admissions(id) on delete restrict,
    primary key (assignment_id, admission_id),
    unique (shift_date, shift_id, admission_id)
  );
  create index shift_patient_allocations_admission_idx on ehr.shift_patient_allocations (admission_id, shift_date);
  alter table ehr.shift_patient_allocations enable row level security;
  revoke all on ehr.shift_patient_allocations from public;
  comment on table ehr.shift_patient_allocations is
    '0176 (NUR-1): the patients a nurse looks after on a shift (ICU 1:1 or 1:2 is the same list); one nurse per patient per shift.';

  create table ehr.shift_assignment_events (
    id uuid primary key default gen_random_uuid(),
    sequence_no bigint generated always as identity,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    shift_date date not null,
    shift_id uuid not null,
    ward_id uuid not null,
    version integer not null check (version > 0),
    assignments jsonb not null check (jsonb_typeof(assignments) = 'array'),
    by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    at timestamptz not null default clock_timestamp(),
    unique (shift_date, shift_id, ward_id, version)
  );
  alter table ehr.shift_assignment_events enable row level security;
  revoke all on ehr.shift_assignment_events from public;
  comment on table ehr.shift_assignment_events is
    '0176 (NUR-1): every replacement of a ward''s list for a shift (membership ids, duties and admission ids only). Append only.';
  create trigger shift_assignment_events_immutable
    before update or delete on ehr.shift_assignment_events
    for each row execute function ehr.nursing_requests_immutable();

  -- T1. Nursing tasks.
  create table ehr.nursing_tasks (
    id uuid primary key default gen_random_uuid(),
    admission_id uuid not null references ehr.admissions(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    name text not null check (name = btrim(name) and length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
    due_at timestamptz not null,
    assigned_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    repeat_every_hours smallint check (repeat_every_hours is null or repeat_every_hours between 1 and 168),
    status text not null default 'assigned' check (status in ('assigned', 'in_progress', 'completed', 'cancelled')),
    started_at timestamptz,
    started_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    completed_at timestamptz,
    completed_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    completion_record text check (completion_record is null or length(btrim(completion_record)) between 1 and 2000),
    cancelled_at timestamptz,
    cancelled_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    cancel_reason text check (cancel_reason is null or (length(btrim(cancel_reason)) between 8 and 300)),
    previous_task_id uuid references ehr.nursing_tasks(id) on delete restrict,
    created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    constraint nursing_tasks_started_ck check ((started_at is null) = (started_by_membership_id is null)
      and (status <> 'in_progress' or started_at is not null)),
    constraint nursing_tasks_completed_ck check ((status = 'completed') = (completed_at is not null)
      and (completed_at is null) = (completed_by_membership_id is null)
      and (completion_record is null or status = 'completed')),
    constraint nursing_tasks_cancelled_ck check ((status = 'cancelled') = (cancelled_at is not null)
      and (status = 'cancelled') = (cancel_reason is not null))
  );
  create index nursing_tasks_admission_idx on ehr.nursing_tasks (admission_id, status, due_at);
  create index nursing_tasks_open_idx on ehr.nursing_tasks (facility_id, due_at) where status in ('assigned', 'in_progress');
  create index nursing_tasks_assignee_idx on ehr.nursing_tasks (assigned_membership_id, status, due_at);
  create unique index nursing_tasks_repeat_ux on ehr.nursing_tasks (previous_task_id) where previous_task_id is not null;
  alter table ehr.nursing_tasks enable row level security;
  revoke all on ehr.nursing_tasks from public;
  comment on table ehr.nursing_tasks is
    '0176 (NUR-1, Q-NUR-13 A): a nursing task of a stay with its due time, assignee and repeat. The completion record is chart content. Never deleted; open tasks are cancelled "Discharged" when the stay ends.';
  create function ehr.nursing_tasks_no_delete()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    raise exception using errcode = '55000', message = 'NURSING_HISTORY_IMMUTABLE';
  end
  $fn$;
  revoke all on function ehr.nursing_tasks_no_delete() from public;
  create trigger nursing_tasks_no_delete
    before delete on ehr.nursing_tasks
    for each row execute function ehr.nursing_tasks_no_delete();

  -- T2. Fluid balance.
  create table ehr.fluid_balance_entries (
    id uuid primary key default gen_random_uuid(),
    admission_id uuid not null references ehr.admissions(id) on delete restrict,
    encounter_id uuid not null,
    patient_id uuid not null,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    direction text not null check (direction in ('in', 'out')),
    kind text not null,
    volume_ml integer check (volume_ml is null or volume_ml between 1 and 10000),
    not_measured boolean not null default false,
    recorded_at timestamptz not null,
    note text check (note is null or (note = btrim(note) and length(note) between 1 and 200 and note !~ '[[:cntrl:]]')),
    status text not null default 'recorded' check (status in ('recorded', 'entered_in_error')),
    entered_in_error_reason text check (entered_in_error_reason is null
      or (length(btrim(entered_in_error_reason)) between 8 and 500)),
    entered_in_error_at timestamptz,
    entered_in_error_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    recorded_by_account_id uuid not null,
    recorded_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    constraint fluid_balance_entries_encounter_fk foreign key (encounter_id, patient_id, facility_id)
      references ehr.encounters(id, patient_id, facility_id) on delete restrict,
    constraint fluid_balance_entries_kind_ck check (
      (direction = 'in' and kind in ('oral', 'iv', 'enteral_tube', 'blood_product', 'other'))
      or (direction = 'out' and kind in ('urine', 'vomit', 'drain', 'stool', 'tube_aspirate', 'blood_loss', 'other'))),
    constraint fluid_balance_entries_amount_ck check ((volume_ml is not null) <> not_measured),
    constraint fluid_balance_entries_status_ck check (
      (status = 'entered_in_error') = (entered_in_error_at is not null)
      and (status = 'entered_in_error') = (entered_in_error_reason is not null)
      and (status = 'entered_in_error') = (entered_in_error_by_membership_id is not null))
  );
  create index fluid_balance_entries_admission_idx on ehr.fluid_balance_entries (admission_id, recorded_at);
  alter table ehr.fluid_balance_entries enable row level security;
  revoke all on ehr.fluid_balance_entries from public;
  comment on table ehr.fluid_balance_entries is
    '0176 (NUR-1, Q-NUR-6 A): one fluid intake or output of a stay, in mL or not measured (never counted in a total). Never edited or deleted; a mistake is marked entered in error (one way). Part of the record.';
  create function ehr.fluid_balance_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if tg_op = 'DELETE' then
      raise exception using errcode = '55000', message = 'NURSING_HISTORY_IMMUTABLE';
    end if;
    if old.status <> 'recorded' or new.status <> 'entered_in_error' or new.row_version <> old.row_version + 1
       or (new.id, new.admission_id, new.encounter_id, new.patient_id, new.facility_id, new.direction, new.kind,
           new.volume_ml, new.not_measured, new.recorded_at, new.note, new.recorded_by_account_id,
           new.recorded_by_membership_id, new.created_at)
          is distinct from
          (old.id, old.admission_id, old.encounter_id, old.patient_id, old.facility_id, old.direction, old.kind,
           old.volume_ml, old.not_measured, old.recorded_at, old.note, old.recorded_by_account_id,
           old.recorded_by_membership_id, old.created_at) then
      raise exception using errcode = '55000', message = 'NURSING_HISTORY_IMMUTABLE';
    end if;
    return new;
  end
  $fn$;
  revoke all on function ehr.fluid_balance_guard() from public;
  create trigger fluid_balance_guard
    before update or delete on ehr.fluid_balance_entries
    for each row execute function ehr.fluid_balance_guard();

  -- T6. Handover sheets and their patients.
  create table ehr.shift_handovers (
    id uuid primary key default gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    ward_id uuid not null,
    shift_date date not null,
    shift_id uuid not null,
    status text not null default 'draft' check (status in ('draft', 'given', 'accepted')),
    given_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    given_at timestamptz,
    accepted_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    accepted_at timestamptz,
    created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    constraint shift_handovers_ward_fk foreign key (ward_id, facility_id) references ehr.wards(id, facility_id)
      on delete restrict,
    constraint shift_handovers_shift_fk foreign key (shift_id, facility_id)
      references ehr.clinical_shifts(id, facility_id) on delete restrict,
    constraint shift_handovers_given_ck check ((given_at is null) = (given_by_membership_id is null)
      and (status = 'draft') = (given_at is null)),
    constraint shift_handovers_accepted_ck check ((accepted_at is null) = (accepted_by_membership_id is null)
      and (status = 'accepted') = (accepted_at is not null)),
    unique (ward_id, shift_date, shift_id)
  );
  alter table ehr.shift_handovers enable row level security;
  revoke all on ehr.shift_handovers from public;
  comment on table ehr.shift_handovers is
    '0176 (NUR-1, Q193 A): a ward''s handover sheet for a shift: draft, given by the outgoing nurse, accepted by a nurse of the next shift. Never deleted.';

  create table ehr.shift_handover_items (
    handover_id uuid not null references ehr.shift_handovers(id) on delete restrict,
    admission_id uuid not null references ehr.admissions(id) on delete restrict,
    clinical_note_id uuid not null references ehr.clinical_notes(id) on delete restrict,
    watch boolean not null default false,
    written_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    primary key (handover_id, admission_id)
  );
  alter table ehr.shift_handover_items enable row level security;
  revoke all on ehr.shift_handover_items from public;
  comment on table ehr.shift_handover_items is
    '0176 (NUR-1): a patient on a handover sheet: the handover note (a signed clinical note "Nursing handover" of the stay''s visit, revised while the sheet is a draft) and whether to watch them.';

  -- T7. Helpers (no role may execute them; the functions below run them as their owner).

  -- A shift's window on a Lagos date (a shift that crosses midnight ends the next day).
  create function ehr.clinical_shift_window(requested_shift uuid, requested_date date)
  returns table (starts timestamptz, ends timestamptz)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ((requested_date + shift.starts_at) at time zone 'Africa/Lagos'),
           ((requested_date + shift.ends_at + case when shift.ends_at <= shift.starts_at then interval '1 day'
                                                    else interval '0' end) at time zone 'Africa/Lagos')
      from ehr.clinical_shifts shift where shift.id = requested_shift
  $fn$;
  revoke all on function ehr.clinical_shift_window(uuid, date) from public;

  -- The facility's active shifts whose window holds the given time (a time in an overlap is in both).
  create function ehr.clinical_shifts_at(requested_facility uuid, requested_at timestamptz)
  returns table (shift_id uuid, shift_date date, starts timestamptz, ends timestamptz)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select shift.id, day_value, window_row.starts, window_row.ends
      from ehr.clinical_shifts shift
      cross join (values ((requested_at at time zone 'Africa/Lagos')::date - 1),
                         ((requested_at at time zone 'Africa/Lagos')::date)) days(day_value)
      cross join lateral ehr.clinical_shift_window(shift.id, days.day_value) window_row
     where shift.facility_id = requested_facility and shift.active
       and window_row.starts <= requested_at and requested_at < window_row.ends
  $fn$;
  revoke all on function ehr.clinical_shifts_at(uuid, timestamptz) from public;

  -- The next shift after a shift on a date: the active shift whose start comes first after this one's.
  create function ehr.clinical_shift_next(requested_shift uuid, requested_date date)
  returns table (shift_id uuid, shift_date date, starts timestamptz, ends timestamptz)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select candidate.id, days.day_value, window_row.starts, window_row.ends
      from ehr.clinical_shifts this_shift
      cross join lateral ehr.clinical_shift_window(this_shift.id, requested_date) this_window
      join ehr.clinical_shifts candidate on candidate.facility_id = this_shift.facility_id and candidate.active
      cross join (values (requested_date), (requested_date + 1)) days(day_value)
      cross join lateral ehr.clinical_shift_window(candidate.id, days.day_value) window_row
     where this_shift.id = requested_shift and window_row.starts > this_window.starts
     order by window_row.starts, candidate.id
     limit 1
  $fn$;
  revoke all on function ehr.clinical_shift_next(uuid, date) from public;

  create function ehr.nursing_fluid_day_start_hour(requested_facility uuid)
  returns integer
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select coalesce((select settings.fluid_day_starts_at_hour from ehr.facility_nursing_settings settings
                      where settings.facility_id = requested_facility), 7)::integer
  $fn$;
  revoke all on function ehr.nursing_fluid_day_start_hour(uuid) from public;

  -- A task as the routes answer it. The completion record (chart content) only when chart_shown.
  create function ehr.nursing_task_json(requested_task uuid, chart_shown boolean, card jsonb)
  returns jsonb
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select jsonb_build_object('taskId', task.id, 'admissionId', task.admission_id, 'patient', card,
      'bedName', bed.name, 'name', task.name, 'dueAt', task.due_at,
      'overdue', task.status in ('assigned', 'in_progress') and task.due_at < clock_timestamp(),
      'status', task.status, 'assignedMembershipId', task.assigned_membership_id,
      'repeatEveryHours', task.repeat_every_hours, 'startedAt', task.started_at, 'completedAt', task.completed_at,
      'completionRecorded', task.completion_record is not null,
      'completionRecord', case when coalesce(chart_shown, false) then task.completion_record end,
      'cancelledAt', task.cancelled_at, 'previousTaskId', task.previous_task_id, 'rowVersion', task.row_version)
      from ehr.nursing_tasks task
      join ehr.admissions admission on admission.id = task.admission_id
      left join ehr.beds bed on bed.id = admission.bed_id
     where task.id = requested_task
  $fn$;
  revoke all on function ehr.nursing_task_json(uuid, boolean, jsonb) from public;

  -- The stay's open tasks are cancelled "Discharged" when the stay ends (discharge, or a cancelled request).
  create function ehr.nursing_tasks_close_for_discharge()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    closed integer;
  begin
    if new.status in ('discharged', 'cancelled') and old.status is distinct from new.status then
      update ehr.nursing_tasks task
         set status = 'cancelled', cancelled_at = clock_timestamp(),
             cancelled_by_membership_id = new.updated_by_membership_id, cancel_reason = 'Discharged',
             updated_by_membership_id = new.updated_by_membership_id, updated_at = clock_timestamp(),
             row_version = task.row_version + 1
       where task.admission_id = new.id and task.status in ('assigned', 'in_progress');
      get diagnostics closed = row_count;
      if closed > 0 then
        perform ehr.inpatient_audit(new.patient_id, 'ehr.nursing-task.cancel', 'success', 'admission', new.id::text,
          jsonb_build_object('reason', 'discharged', 'count', closed));
      end if;
    end if;
    return null;
  end
  $fn$;
  revoke all on function ehr.nursing_tasks_close_for_discharge() from public;
  create trigger admissions_nursing_tasks_close
    after update of status on ehr.admissions
    for each row execute function ehr.nursing_tasks_close_for_discharge();

  -- T8. 0174's hourly fluid, now with entries: in, out and the running balance since the fluid day's start.
  create or replace function ehr.observation_fluid_hours(requested_admission uuid, requested_from timestamptz,
    requested_to timestamptz)
  returns table (hour_start timestamptz, fluid_in_ml bigint, fluid_out_ml bigint, running_balance_ml bigint)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    with stay as (
      select admission.id, admission.facility_id, ehr.nursing_fluid_day_start_hour(admission.facility_id) as start_hour
        from ehr.admissions admission where admission.id = requested_admission),
    hours as (
      select hour_value as hour_start,
             -- The start of the fluid day the hour belongs to (Lagos time).
             ((((hour_value at time zone 'Africa/Lagos') - make_interval(hours => stay.start_hour))::date
               + make_interval(hours => stay.start_hour)) at time zone 'Africa/Lagos') as day_start
        from stay, generate_series(date_trunc('hour', requested_from), requested_to - interval '1 microsecond',
                                   interval '1 hour') hour_value),
    sums as (
      select hours.hour_start, hours.day_start,
             coalesce(sum(entry.volume_ml) filter (where entry.direction = 'in'), 0)::bigint as fluid_in,
             coalesce(sum(entry.volume_ml) filter (where entry.direction = 'out'), 0)::bigint as fluid_out
        from hours
        left join ehr.fluid_balance_entries entry
          on entry.admission_id = requested_admission and entry.status = 'recorded' and not entry.not_measured
         and entry.recorded_at >= hours.hour_start and entry.recorded_at < hours.hour_start + interval '1 hour'
       group by hours.hour_start, hours.day_start)
    select sums.hour_start, sums.fluid_in, sums.fluid_out,
           coalesce((select sum(case when entry.direction = 'in' then entry.volume_ml else -entry.volume_ml end)
                       from ehr.fluid_balance_entries entry
                      where entry.admission_id = requested_admission and entry.status = 'recorded'
                        and not entry.not_measured and entry.recorded_at >= sums.day_start
                        and entry.recorded_at < sums.hour_start + interval '1 hour'), 0)::bigint
      from sums
     order by sums.hour_start
  $fn$;

  -- Q194 A: who is told of a critical result for an admitted patient: the responsible doctor, the nurses allocated
  -- to the patient on the current shift, the ward's nurse in charge and its on-call doctor.
  create or replace function ehr.admission_notice_recipients(requested_admission uuid)
  returns table (membership_id uuid, why text)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    with stay as (
      select admission.* from ehr.admissions admission
       where admission.id = requested_admission and admission.status in ('requested', 'admitted', 'discharge_ready')),
    now_shifts as (
      select current_shift.shift_id, current_shift.shift_date
        from stay, ehr.clinical_shifts_at(stay.facility_id, clock_timestamp()) current_shift),
    candidates as (
      select stay.responsible_membership_id as membership_id, 'responsible_doctor' as why, 1 as rank from stay
      union all
      select allocation.membership_id, 'allocated_nurse', 2
        from stay
        join ehr.shift_patient_allocations allocation on allocation.admission_id = stay.id
        join now_shifts on now_shifts.shift_id = allocation.shift_id and now_shifts.shift_date = allocation.shift_date
      union all
      select assignment.membership_id, assignment.duty, case assignment.duty when 'nurse_in_charge' then 3 else 4 end
        from stay
        join ehr.shift_assignments assignment on assignment.ward_id = stay.ward_id
        join now_shifts on now_shifts.shift_id = assignment.shift_id and now_shifts.shift_date = assignment.shift_date
       where assignment.duty in ('nurse_in_charge', 'on_call_doctor'))
    select distinct on (candidates.membership_id) candidates.membership_id, candidates.why
      from candidates
      join identity.staff_facility_memberships membership on membership.id = candidates.membership_id
     where membership.active and membership.migration_hold_reason is null
     order by candidates.membership_id, candidates.rank
  $fn$;

  -- Route 8: the task list.
  create function ehr.nursing_task_list(requested_ward uuid, requested_admission uuid, requested_status text,
    requested_mine boolean)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    items jsonb := '[]'::jsonb;
    shown_ids uuid[] := '{}'::uuid[];
    stay record;
    task_row record;
    chart_shown boolean;
  begin
    select * into caller from ehr.nursing_caller('task_read', array['direct-care']);
    if (requested_ward is null) = (requested_admission is null)
       or coalesce(requested_status, 'open') not in ('open', 'done') then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    if requested_ward is not null and not exists (select 1 from ehr.wards ward
         where ward.id = requested_ward and ward.facility_id = caller.actor_facility) then
      perform ehr.inpatient_audit(null, 'ehr.nursing-task.list', 'failure', 'ward', requested_ward::text,
        jsonb_build_object('refusal', 'ward_not_found'));
      return jsonb_build_object('outcome', 'ward_not_found');
    end if;
    if requested_admission is not null and not exists (select 1 from ehr.admissions admission
         where admission.id = requested_admission and admission.facility_id = caller.actor_facility) then
      perform ehr.inpatient_audit(null, 'ehr.nursing-task.list', 'failure', 'admission', requested_admission::text,
        jsonb_build_object('refusal', 'not_found'));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    for stay in
      select admission.id, admission.patient_id, card.card, card.name_shown
        from ehr.admissions admission
        cross join lateral ehr.admission_cards(array[admission.id], false) card
       where admission.facility_id = caller.actor_facility
         and ((requested_admission is not null and admission.id = requested_admission)
              or (requested_ward is not null and admission.ward_id = requested_ward
                  and admission.status in ('admitted', 'discharge_ready')))
       order by admission.id
    loop
      chart_shown := null;
      for task_row in
        select task.id from ehr.nursing_tasks task
         where task.admission_id = stay.id
           and ((coalesce(requested_status, 'open') = 'open' and task.status in ('assigned', 'in_progress'))
                or (requested_status = 'done' and task.status in ('completed', 'cancelled')))
           and (not coalesce(requested_mine, false) or task.assigned_membership_id = caller.actor_membership)
         order by task.due_at, task.id
         limit 200
      loop
        if chart_shown is null then
          chart_shown := coalesce(ehr.context_allows(stay.patient_id, caller.actor_facility, 'read_records'), false);
        end if;
        items := items || jsonb_build_array(ehr.nursing_task_json(task_row.id, chart_shown, stay.card));
      end loop;
      if chart_shown is not null then
        shown_ids := shown_ids || stay.patient_id;
        perform ehr.inpatient_audit(stay.patient_id, 'ehr.nursing-task.list.shown', 'success', 'admission',
          stay.id::text, jsonb_build_object('nameShown', stay.name_shown, 'chartShown', chart_shown));
      end if;
    end loop;
    select coalesce(jsonb_agg(item order by (item->>'status') in ('completed', 'cancelled'), (item->>'dueAt')::timestamptz,
                              item->>'taskId'), '[]'::jsonb)
      into items from jsonb_array_elements(items) item;
    perform ehr.inpatient_audit(null, 'ehr.nursing-task.list', 'success',
      case when requested_ward is not null then 'ward' else 'admission' end,
      coalesce(requested_ward, requested_admission)::text,
      jsonb_build_object('status', coalesce(requested_status, 'open'), 'mine', coalesce(requested_mine, false),
        'count', jsonb_array_length(items), 'patientIds', to_jsonb(shown_ids)));
    return jsonb_build_object('outcome', 'found', 'items', items);
  end
  $fn$;
  comment on function ehr.nursing_task_list(uuid, uuid, text, boolean) is
    '0176 (NUR-1, Q-NUR-13 A): a ward''s (its admitted patients) or one admission''s tasks, open (assigned, in progress) or done, optionally only the member''s own; open first, by due time. Each task''s name, due time, assignee and overdue mark show to ward staff; the patient under ADT-1''s names rule (Q190); the completion record only where the member can read the chart. Needs ehr.nursing-task.read. Outcomes found, ward_not_found, not_found. Audited (ehr.nursing-task.list with the patient ids, and one .shown row per patient).';
  revoke all on function ehr.nursing_task_list(uuid, uuid, text, boolean) from public;

  -- Route 9: a new task.
  create function ehr.nursing_task_create(requested_admission uuid, requested_name text, requested_due_at timestamptz,
    requested_assignee uuid, requested_repeat_every_hours integer, requested_idempotency_key text,
    requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    admission_row ehr.admissions%rowtype;
    name_value text := btrim(coalesce(requested_name, ''));
    refusal text;
    new_id uuid;
  begin
    select * into caller from ehr.nursing_caller('task_write', array['direct-care']);
    if requested_admission is null or length(name_value) not between 1 and 120 or name_value ~ '[[:cntrl:]]'
       or requested_due_at is null or requested_due_at < clock_timestamp() - interval '1 day'
       or requested_due_at > clock_timestamp() + interval '90 days'
       or (requested_repeat_every_hours is not null and requested_repeat_every_hours not between 1 and 168) then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'task_create' then
      return jsonb_build_object('outcome', 'created', 'replayed', true,
        'task', ehr.nursing_task_json(key_state.resource_id, false,
          (select card.card from ehr.nursing_tasks task, ehr.admission_cards(array[task.admission_id], false) card
            where task.id = key_state.resource_id)));
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for share;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif admission_row.status not in ('requested', 'admitted', 'discharge_ready') then
      refusal := 'admission_not_open';
    elsif requested_assignee is not null
          and not ehr.inpatient_member_has_role(requested_assignee, caller.actor_facility,
                                                array['nurse', 'clinician', 'doctor']) then
      refusal := 'assignee_invalid';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.nursing-task.create',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    insert into ehr.nursing_tasks (admission_id, facility_id, patient_id, name, due_at, assigned_membership_id,
      repeat_every_hours, created_by_membership_id, updated_by_membership_id)
    values (admission_row.id, admission_row.facility_id, admission_row.patient_id, name_value, requested_due_at,
      requested_assignee, requested_repeat_every_hours, caller.actor_membership, caller.actor_membership)
    returning id into new_id;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, 'task_create', new_id);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.nursing-task.create', 'success', 'nursing-task',
      new_id::text, jsonb_build_object('admissionId', admission_row.id, 'assigned', requested_assignee is not null,
        'repeatEveryHours', requested_repeat_every_hours));
    return jsonb_build_object('outcome', 'created', 'replayed', false,
      'task', ehr.nursing_task_json(new_id, false,
        (select card.card from ehr.admission_cards(array[admission_row.id], false) card)));
  end
  $fn$;
  comment on function ehr.nursing_task_create(uuid, text, timestamptz, uuid, integer, text, text) is
    '0176 (NUR-1): a nursing task of an open stay (requested, admitted or discharge ready): a name of 1-120 characters, a due time, an assignee (an active nurse, clinician or doctor here) and a repeat every 1-168 hours, both optional. Needs ehr.nursing-task.write. Outcomes created (replayed), not_found, admission_not_open, assignee_invalid, key_reused. Audited (ehr.nursing-task.create; never the name).';
  revoke all on function ehr.nursing_task_create(uuid, text, timestamptz, uuid, integer, text, text) from public;

  -- Route 10: start, complete, cancel and change a task. One body, four routes.
  create function ehr.nursing_task_step(requested_task uuid, requested_row_version bigint, requested_step text,
    requested_text text, requested_assignee uuid, requested_due_at timestamptz, requested_idempotency_key text,
    requested_request_sha256 text)
  returns jsonb
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    task_row ehr.nursing_tasks%rowtype;
    admission_row ehr.admissions%rowtype;
    text_value text := nullif(btrim(coalesce(requested_text, '')), '');
    refusal text;
    next_id uuid;
    chart_shown boolean := false;
    action_name text := 'ehr.nursing-task.' || case requested_step when 'update' then 'update' else requested_step end;
  begin
    select * into caller from ehr.nursing_caller('task_write', array['direct-care']);
    if requested_task is null or requested_row_version is null
       or (requested_step = 'complete' and text_value is not null and length(text_value) > 2000)
       or (requested_step = 'cancel' and (text_value is null or length(text_value) not between 8 and 300))
       or (requested_step = 'update' and requested_assignee is null and requested_due_at is null)
       or (requested_due_at is not null and (requested_due_at < clock_timestamp() - interval '1 day'
                                             or requested_due_at > clock_timestamp() + interval '90 days')) then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'task_' || requested_step
       and key_state.resource_id = requested_task then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'task', ehr.nursing_task_json(requested_task, false,
          (select card.card from ehr.nursing_tasks task, ehr.admission_cards(array[task.admission_id], false) card
            where task.id = requested_task)));
    end if;
    select task.* into task_row from ehr.nursing_tasks task
     where task.id = requested_task and task.facility_id = caller.actor_facility for update;
    if found then
      select admission.* into admission_row from ehr.admissions admission where admission.id = task_row.admission_id;
    end if;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif task_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif (requested_step = 'start' and task_row.status <> 'assigned')
          or (requested_step = 'complete' and task_row.status <> 'in_progress')
          or (requested_step in ('cancel', 'update') and task_row.status not in ('assigned', 'in_progress')) then
      refusal := 'state_invalid';
    elsif requested_assignee is not null
          and not ehr.inpatient_member_has_role(requested_assignee, caller.actor_facility,
                                                array['nurse', 'clinician', 'doctor']) then
      refusal := 'assignee_invalid';
    elsif requested_step = 'complete' and text_value is not null
          and not coalesce(ehr.context_allows(task_row.patient_id, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(task_row.patient_id, action_name,
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'nursing-task', requested_task::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    if requested_step = 'start' then
      update ehr.nursing_tasks task
         set status = 'in_progress', started_at = clock_timestamp(), started_by_membership_id = caller.actor_membership,
             updated_by_membership_id = caller.actor_membership, updated_at = clock_timestamp(),
             row_version = task.row_version + 1
       where task.id = task_row.id;
    elsif requested_step = 'complete' then
      update ehr.nursing_tasks task
         set status = 'completed', completed_at = clock_timestamp(),
             completed_by_membership_id = caller.actor_membership, completion_record = text_value,
             updated_by_membership_id = caller.actor_membership, updated_at = clock_timestamp(),
             row_version = task.row_version + 1
       where task.id = task_row.id;
      chart_shown := text_value is not null;
      -- A repeating task makes its next one while the stay is open.
      if task_row.repeat_every_hours is not null
         and admission_row.status in ('requested', 'admitted', 'discharge_ready') then
        insert into ehr.nursing_tasks (admission_id, facility_id, patient_id, name, due_at, assigned_membership_id,
          repeat_every_hours, previous_task_id, created_by_membership_id, updated_by_membership_id)
        values (task_row.admission_id, task_row.facility_id, task_row.patient_id, task_row.name,
          task_row.due_at + make_interval(hours => task_row.repeat_every_hours), task_row.assigned_membership_id,
          task_row.repeat_every_hours, task_row.id, caller.actor_membership, caller.actor_membership)
        returning id into next_id;
      end if;
    elsif requested_step = 'cancel' then
      update ehr.nursing_tasks task
         set status = 'cancelled', cancelled_at = clock_timestamp(),
             cancelled_by_membership_id = caller.actor_membership, cancel_reason = text_value,
             updated_by_membership_id = caller.actor_membership, updated_at = clock_timestamp(),
             row_version = task.row_version + 1
       where task.id = task_row.id;
    else
      update ehr.nursing_tasks task
         set assigned_membership_id = coalesce(requested_assignee, task.assigned_membership_id),
             due_at = coalesce(requested_due_at, task.due_at),
             updated_by_membership_id = caller.actor_membership, updated_at = clock_timestamp(),
             row_version = task.row_version + 1
       where task.id = task_row.id;
    end if;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, 'task_' || requested_step, task_row.id);
    perform ehr.inpatient_audit(task_row.patient_id, action_name, 'success', 'nursing-task', task_row.id::text,
      jsonb_build_object('admissionId', task_row.admission_id, 'completionRecorded',
        requested_step = 'complete' and text_value is not null, 'nextTaskId', next_id,
        'assigneeChanged', requested_assignee is not null, 'dueChanged', requested_due_at is not null));
    return jsonb_build_object('outcome', 'updated', 'replayed', false,
      'task', ehr.nursing_task_json(task_row.id, chart_shown,
        (select card.card from ehr.admission_cards(array[task_row.admission_id], false) card)),
      'nextTaskId', next_id);
  end
  $fn$;
  revoke all on function ehr.nursing_task_step(uuid, bigint, text, text, uuid, timestamptz, text, text) from public;

  create function ehr.nursing_task_start(requested_task uuid, requested_row_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.nursing_task_step(requested_task, requested_row_version, 'start', null, null, null,
      requested_idempotency_key, requested_request_sha256)
  $fn$;
  comment on function ehr.nursing_task_start(uuid, bigint, text, text) is
    '0176 (NUR-1): "Start task": assigned -> in_progress. Needs ehr.nursing-task.write. Outcomes updated (replayed), not_found, changed, state_invalid, key_reused. Audited (ehr.nursing-task.start).';
  create function ehr.nursing_task_complete(requested_task uuid, requested_row_version bigint,
    requested_completion_record text, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.nursing_task_step(requested_task, requested_row_version, 'complete', requested_completion_record, null,
      null, requested_idempotency_key, requested_request_sha256)
  $fn$;
  comment on function ehr.nursing_task_complete(uuid, bigint, text, text, text) is
    '0176 (NUR-1, Q-NUR-13 A): "Complete task": in_progress -> completed, with an optional completion record of 1-2000 characters (chart content: needs chart write access). A repeating task makes its next one, due its repeat after this one was due, while the stay is open. Needs ehr.nursing-task.write. Outcomes updated (replayed, nextTaskId), not_found, changed, state_invalid, chart_access_required, key_reused. Audited (ehr.nursing-task.complete; never the record).';
  create function ehr.nursing_task_cancel(requested_task uuid, requested_row_version bigint, requested_reason text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.nursing_task_step(requested_task, requested_row_version, 'cancel', requested_reason, null, null,
      requested_idempotency_key, requested_request_sha256)
  $fn$;
  comment on function ehr.nursing_task_cancel(uuid, bigint, text, text, text) is
    '0176 (NUR-1): "Cancel task" from assigned or in_progress, with a reason of 8-300 characters. Needs ehr.nursing-task.write. Outcomes updated (replayed), not_found, changed, state_invalid, key_reused. Audited (ehr.nursing-task.cancel; never the reason).';
  create function ehr.nursing_task_update(requested_task uuid, requested_row_version bigint, requested_assignee uuid,
    requested_due_at timestamptz, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.nursing_task_step(requested_task, requested_row_version, 'update', null, requested_assignee,
      requested_due_at, requested_idempotency_key, requested_request_sha256)
  $fn$;
  comment on function ehr.nursing_task_update(uuid, bigint, uuid, timestamptz, text, text) is
    '0176 (NUR-1): an open task''s assignee or due time. Needs ehr.nursing-task.write. Outcomes updated (replayed), not_found, changed, state_invalid, assignee_invalid, key_reused. Audited (ehr.nursing-task.update).';

  revoke all on function ehr.nursing_task_start(uuid, bigint, text, text), ehr.nursing_task_complete(uuid, bigint, text, text, text),
    ehr.nursing_task_cancel(uuid, bigint, text, text, text), ehr.nursing_task_update(uuid, bigint, uuid, timestamptz, text, text)
    from public;

  -- Route 11: one fluid day (Q-NUR-15 A).
  create function ehr.fluid_balance_read(requested_admission uuid, requested_day date)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
    start_hour integer;
    day_value date;
    day_start timestamptz;
    day_end timestamptz;
    entries jsonb;
    by_hour jsonb;
    by_shift jsonb;
    totals record;
  begin
    select * into caller from ehr.nursing_caller('fluid_read', array['direct-care']);
    if requested_admission is null then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility;
    if not found then
      perform ehr.inpatient_audit(null, 'ehr.fluid-balance.read', 'failure', 'admission', requested_admission::text,
        jsonb_build_object('refusal', 'not_found'));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    if not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'read_records'), false) then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.fluid-balance.read', 'denied', 'admission',
        admission_row.id::text, jsonb_build_object('refusal', 'chart_access_required'));
      return jsonb_build_object('outcome', 'chart_access_required');
    end if;
    start_hour := ehr.nursing_fluid_day_start_hour(caller.actor_facility);
    day_value := coalesce(requested_day,
      ((clock_timestamp() at time zone 'Africa/Lagos') - make_interval(hours => start_hour))::date);
    day_start := (day_value + make_interval(hours => start_hour)) at time zone 'Africa/Lagos';
    day_end := day_start + interval '24 hours';
    select coalesce(jsonb_agg(jsonb_build_object('entryId', entry.id, 'direction', entry.direction, 'kind', entry.kind,
             'volumeMl', entry.volume_ml, 'notMeasured', entry.not_measured, 'recordedAt', entry.recorded_at,
             'note', entry.note, 'status', entry.status, 'enteredInErrorReason', entry.entered_in_error_reason,
             'enteredInErrorAt', entry.entered_in_error_at,
             'recordedByMembershipId', entry.recorded_by_membership_id, 'rowVersion', entry.row_version)
             order by entry.recorded_at, entry.id), '[]'::jsonb)
      into entries
      from ehr.fluid_balance_entries entry
     where entry.admission_id = admission_row.id and entry.recorded_at >= day_start and entry.recorded_at < day_end;
    select coalesce(sum(entry.volume_ml) filter (where entry.direction = 'in'), 0) as intake,
           coalesce(sum(entry.volume_ml) filter (where entry.direction = 'out'), 0) as output,
           count(*) filter (where entry.not_measured and entry.direction = 'in') as unmeasured_in,
           count(*) filter (where entry.not_measured and entry.direction = 'out') as unmeasured_out
      into totals
      from ehr.fluid_balance_entries entry
     where entry.admission_id = admission_row.id and entry.status = 'recorded'
       and entry.recorded_at >= day_start and entry.recorded_at < day_end;
    select coalesce(jsonb_agg(jsonb_build_object('hourStart', hour_row.hour_start, 'inMl', hour_row.fluid_in_ml,
             'outMl', hour_row.fluid_out_ml, 'runningBalanceMl', hour_row.running_balance_ml)
             order by hour_row.hour_start), '[]'::jsonb)
      into by_hour
      from ehr.observation_fluid_hours(admission_row.id, day_start, day_end) hour_row;
    select coalesce(jsonb_agg(jsonb_build_object('shiftId', windows.id, 'name', windows.name,
             'shiftDate', windows.day_value, 'from', greatest(windows.starts, day_start),
             'to', least(windows.ends, day_end),
             'inMl', coalesce((select sum(entry.volume_ml) from ehr.fluid_balance_entries entry
                                where entry.admission_id = admission_row.id and entry.status = 'recorded'
                                  and entry.direction = 'in' and not entry.not_measured
                                  and entry.recorded_at >= greatest(windows.starts, day_start)
                                  and entry.recorded_at < least(windows.ends, day_end)), 0),
             'outMl', coalesce((select sum(entry.volume_ml) from ehr.fluid_balance_entries entry
                                 where entry.admission_id = admission_row.id and entry.status = 'recorded'
                                   and entry.direction = 'out' and not entry.not_measured
                                   and entry.recorded_at >= greatest(windows.starts, day_start)
                                   and entry.recorded_at < least(windows.ends, day_end)), 0))
             order by windows.starts, windows.id), '[]'::jsonb)
      into by_shift
      from (select shift.id, shift.name, days.day_value, window_row.starts, window_row.ends
              from ehr.clinical_shifts shift
              cross join (values (day_value - 1), (day_value), (day_value + 1)) days(day_value)
              cross join lateral ehr.clinical_shift_window(shift.id, days.day_value) window_row
             where shift.facility_id = caller.actor_facility and shift.active
               and window_row.starts < day_end and window_row.ends > day_start) windows;
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.fluid-balance.read', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('day', day_value, 'entryCount', jsonb_array_length(entries)));
    return jsonb_build_object('outcome', 'found', 'admissionId', admission_row.id, 'day', day_value,
      'dayStartsAtHour', start_hour, 'from', day_start, 'to', day_end, 'entries', entries,
      'totals', jsonb_build_object('intakeMl', totals.intake, 'outputMl', totals.output,
        'balanceMl', totals.intake - totals.output, 'unmeasuredIntakeCount', totals.unmeasured_in,
        'unmeasuredOutputCount', totals.unmeasured_out),
      'byHour', by_hour, 'byShift', by_shift);
  end
  $fn$;
  comment on function ehr.fluid_balance_read(uuid, date) is
    '0176 (NUR-1, Q-NUR-6 A, Q-NUR-15 A): one fluid day of the stay (from the facility''s start hour, 07:00 Lagos time unless set, to the same hour next day; today''s when no day is given): the entries (entered in error included, marked), intake, output and balance (measured entries only; unmeasured ones counted apart), and the totals per hour (with the running balance) and per clinical shift. Needs ehr.vital.read and chart read access. Outcomes found, not_found, chart_access_required. Audited (ehr.fluid-balance.read; never a volume).';
  revoke all on function ehr.fluid_balance_read(uuid, date) from public;

  -- Route 12: a fluid entry.
  create function ehr.fluid_balance_record(requested_admission uuid, requested_direction text, requested_kind text,
    requested_volume_ml integer, requested_not_measured boolean, requested_recorded_at timestamptz,
    requested_note text, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    admission_row ehr.admissions%rowtype;
    note_value text := nullif(btrim(coalesce(requested_note, '')), '');
    refusal text;
    new_id uuid;
  begin
    select * into caller from ehr.nursing_caller('fluid_write', array['direct-care']);
    if requested_admission is null or requested_direction is null or requested_direction not in ('in', 'out')
       or requested_kind is null
       or not ((requested_direction = 'in' and requested_kind in ('oral', 'iv', 'enteral_tube', 'blood_product', 'other'))
            or (requested_direction = 'out' and requested_kind in ('urine', 'vomit', 'drain', 'stool', 'tube_aspirate',
                                                                    'blood_loss', 'other')))
       or (note_value is not null and (length(note_value) > 200 or note_value ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    if (requested_volume_ml is null) = not coalesce(requested_not_measured, false)
       or (requested_volume_ml is not null and requested_volume_ml not between 1 and 10000) then
      raise exception using errcode = '22023', message = 'FLUID_ENTRY_INVALID';
    end if;
    if requested_recorded_at is null or requested_recorded_at > clock_timestamp() + interval '2 minutes'
       or requested_recorded_at < clock_timestamp() - interval '24 hours' then
      raise exception using errcode = '22023', message = 'FLUID_TIME_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'fluid_record' then
      return jsonb_build_object('outcome', 'created', 'replayed', true, 'entryId', key_state.resource_id);
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for share;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif admission_row.status not in ('admitted', 'discharge_ready') then
      refusal := 'admission_not_open';
    elsif not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.fluid-balance.record',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    insert into ehr.fluid_balance_entries (admission_id, encounter_id, patient_id, facility_id, direction, kind,
      volume_ml, not_measured, recorded_at, note, recorded_by_account_id, recorded_by_membership_id)
    values (admission_row.id, admission_row.encounter_id, admission_row.patient_id, admission_row.facility_id,
      requested_direction, requested_kind, requested_volume_ml, coalesce(requested_not_measured, false),
      least(requested_recorded_at, clock_timestamp()), note_value, caller.actor_account, caller.actor_membership)
    returning id into new_id;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, 'fluid_record', new_id);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.fluid-balance.record', 'success', 'fluid-entry',
      new_id::text, jsonb_build_object('admissionId', admission_row.id, 'direction', requested_direction,
        'kind', requested_kind, 'notMeasured', coalesce(requested_not_measured, false)));
    return jsonb_build_object('outcome', 'created', 'replayed', false, 'entryId', new_id);
  end
  $fn$;
  comment on function ehr.fluid_balance_record(uuid, text, text, integer, boolean, timestamptz, text, text, text) is
    '0176 (NUR-1, Q-NUR-6 A): one intake or output of an admitted stay: its kind, the amount (1-10000 mL) or "not measured" (never counted in a total), the time (not in the future, at most 24 hours ago) and a note of up to 200 characters. Needs ehr.vital.write and chart write access. Outcomes created (replayed), not_found, admission_not_open, chart_access_required, key_reused. Audited (ehr.fluid-balance.record; never the amount or note).';
  revoke all on function ehr.fluid_balance_record(uuid, text, text, integer, boolean, timestamptz, text, text, text)
    from public;

  -- Route 13: a fluid entry marked entered in error (one way).
  create function ehr.fluid_balance_entered_in_error(requested_entry uuid, requested_row_version bigint,
    requested_reason text, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    entry_row ehr.fluid_balance_entries%rowtype;
    reason_value text := nullif(btrim(coalesce(requested_reason, '')), '');
    refusal text;
  begin
    select * into caller from ehr.nursing_caller('fluid_write', array['direct-care']);
    if requested_entry is null or requested_row_version is null or reason_value is null
       or length(reason_value) not between 8 and 500 or reason_value ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'fluid_entered_in_error'
       and key_state.resource_id = requested_entry then
      return jsonb_build_object('outcome', 'updated', 'replayed', true, 'entryId', requested_entry);
    end if;
    select entry.* into entry_row from ehr.fluid_balance_entries entry
     where entry.id = requested_entry and entry.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif entry_row.status = 'entered_in_error' then
      refusal := 'already_entered_in_error';
    elsif entry_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif not coalesce(ehr.context_allows(entry_row.patient_id, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(entry_row.patient_id, 'ehr.fluid-balance.entered-in-error',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'fluid-entry', requested_entry::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    update ehr.fluid_balance_entries entry
       set status = 'entered_in_error', entered_in_error_reason = reason_value, entered_in_error_at = clock_timestamp(),
           entered_in_error_by_membership_id = caller.actor_membership, row_version = entry.row_version + 1
     where entry.id = entry_row.id;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, 'fluid_entered_in_error', entry_row.id);
    perform ehr.inpatient_audit(entry_row.patient_id, 'ehr.fluid-balance.entered-in-error', 'success', 'fluid-entry',
      entry_row.id::text, jsonb_build_object('admissionId', entry_row.admission_id));
    return jsonb_build_object('outcome', 'updated', 'replayed', false, 'entryId', entry_row.id);
  end
  $fn$;
  comment on function ehr.fluid_balance_entered_in_error(uuid, bigint, text, text, text) is
    '0176 (NUR-1): marks a fluid entry entered in error, for good, with a reason of 8-500 characters; it stays (struck through) and leaves every total. Needs ehr.vital.write and chart write access. Outcomes updated (replayed), not_found, already_entered_in_error, changed, chart_access_required, key_reused. Audited (ehr.fluid-balance.entered-in-error; never the reason).';
  revoke all on function ehr.fluid_balance_entered_in_error(uuid, bigint, text, text, text) from public;

  -- Route 14: the facility's clinical shifts (Q193 A).
  create function ehr.clinical_shift_list()
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
  begin
    select * into caller from ehr.nursing_caller('shift_list', array['direct-care', 'healthcare-operations']);
    return jsonb_build_object('outcome', 'found',
      'fluidDayStartsAtHour', ehr.nursing_fluid_day_start_hour(caller.actor_facility),
      'items', coalesce((select jsonb_agg(jsonb_build_object('shiftId', shift.id, 'name', shift.name,
          'startsAt', to_char(shift.starts_at, 'HH24:MI'), 'endsAt', to_char(shift.ends_at, 'HH24:MI'),
          'crossesMidnight', shift.ends_at <= shift.starts_at, 'active', shift.active, 'rowVersion', shift.row_version)
          order by shift.active desc, shift.starts_at, lower(shift.name), shift.id)
        from ehr.clinical_shifts shift where shift.facility_id = caller.actor_facility), '[]'::jsonb));
  end
  $fn$;
  comment on function ehr.clinical_shift_list() is
    '0176 (NUR-1, Q193 A): this facility''s clinical shifts (Lagos times), active first, and the fluid day''s start hour. Needs ehr.nursing-task.read, ehr.shift-assignment.manage or ehr.clinical-shift.manage. No patient.';
  revoke all on function ehr.clinical_shift_list() from public;

  create function ehr.clinical_shift_write(requested_shift uuid, requested_row_version bigint, requested_name text,
    requested_starts_at text, requested_ends_at text, requested_active boolean, requested_idempotency_key text,
    requested_request_sha256 text)
  returns jsonb
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    shift_row ehr.clinical_shifts%rowtype;
    name_value text := nullif(btrim(coalesce(requested_name, '')), '');
    refusal text;
    new_id uuid;
    creating boolean := requested_shift is null;
    action_name text := case when requested_shift is null then 'ehr.clinical-shift.create' else 'ehr.clinical-shift.update' end;
  begin
    select * into caller from ehr.nursing_caller('shift_setup', array['healthcare-operations']);
    if (name_value is not null and (length(name_value) > 40 or name_value ~ '[[:cntrl:]]'))
       or (creating and name_value is null)
       or (not creating and (requested_row_version is null or (name_value is null and requested_active is null))) then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    if creating and (requested_starts_at is null or requested_ends_at is null
       or requested_starts_at !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or requested_ends_at !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or requested_starts_at = requested_ends_at) then
      raise exception using errcode = '22023', message = 'SHIFT_TIMES_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = (case when creating then 'shift_create' else 'shift_update' end)
       and (creating or key_state.resource_id = requested_shift) then
      return jsonb_build_object('outcome', case when creating then 'created' else 'updated' end, 'replayed', true,
        'shiftId', key_state.resource_id);
    end if;
    -- One writer of the facility's shifts at a time, so the limit and the names hold under any race.
    perform pg_advisory_xact_lock(hashtextextended('clinical-shifts:' || caller.actor_facility::text, 0));
    if not creating then
      select shift.* into shift_row from ehr.clinical_shifts shift
       where shift.id = requested_shift and shift.facility_id = caller.actor_facility for update;
      if not found then
        refusal := 'not_found';
      elsif shift_row.row_version <> requested_row_version then
        refusal := 'changed';
      end if;
    end if;
    if refusal is null and key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;
    if refusal is null and exists (select 1 from ehr.clinical_shifts other
         where other.facility_id = caller.actor_facility and other.active
           and lower(other.name) = lower(coalesce(name_value, shift_row.name))
           and (creating or other.id <> shift_row.id))
       and (creating or coalesce(requested_active, shift_row.active)) then
      refusal := 'name_taken';
    end if;
    if refusal is null and (creating or (requested_active and not shift_row.active))
       and (select count(*) from ehr.clinical_shifts other
             where other.facility_id = caller.actor_facility and other.active) >= 8 then
      refusal := 'limit_reached';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(null, action_name, case when refusal = 'not_found' then 'failure' else 'denied' end,
        'clinical-shift', requested_shift::text, jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    if creating then
      insert into ehr.clinical_shifts (facility_id, name, starts_at, ends_at, created_by_membership_id,
        updated_by_membership_id)
      values (caller.actor_facility, name_value, requested_starts_at::time, requested_ends_at::time,
        caller.actor_membership, caller.actor_membership)
      returning id into new_id;
    else
      new_id := shift_row.id;
      update ehr.clinical_shifts shift
         set name = coalesce(name_value, shift.name), active = coalesce(requested_active, shift.active),
             updated_by_membership_id = caller.actor_membership, updated_at = clock_timestamp(),
             row_version = shift.row_version + 1
       where shift.id = shift_row.id;
    end if;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, case when creating then 'shift_create' else 'shift_update' end, new_id);
    perform ehr.inpatient_audit(null, action_name, 'success', 'clinical-shift', new_id::text,
      jsonb_build_object('active', (select shift.active from ehr.clinical_shifts shift where shift.id = new_id)));
    return jsonb_build_object('outcome', case when creating then 'created' else 'updated' end, 'replayed', false,
      'shiftId', new_id);
  end
  $fn$;
  revoke all on function ehr.clinical_shift_write(uuid, bigint, text, text, text, boolean, text, text) from public;

  create function ehr.clinical_shift_create(requested_name text, requested_starts_at text, requested_ends_at text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.clinical_shift_write(null, null, requested_name, requested_starts_at, requested_ends_at, null,
      requested_idempotency_key, requested_request_sha256)
  $fn$;
  comment on function ehr.clinical_shift_create(text, text, text, text, text) is
    '0176 (NUR-1, Q193 A, Q-NUR-16 A): a clinical shift: a name of 1-40 characters unique among the active ones, and start and end times "HH:MM" in Lagos time (it may cross midnight). Up to 8 active. Needs ehr.clinical-shift.manage, for healthcare operations. Outcomes created (replayed), name_taken, limit_reached, key_reused. Audited (ehr.clinical-shift.create).';
  create function ehr.clinical_shift_update(requested_shift uuid, requested_row_version bigint, requested_name text,
    requested_active boolean, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.clinical_shift_write(requested_shift, requested_row_version, requested_name, null, null, requested_active,
      requested_idempotency_key, requested_request_sha256)
  $fn$;
  comment on function ehr.clinical_shift_update(uuid, bigint, text, boolean, text, text) is
    '0176 (NUR-1, Q193 A): a clinical shift''s name or whether it is active (a shift is never deleted). Needs ehr.clinical-shift.manage, for healthcare operations. Outcomes updated (replayed), not_found, changed, name_taken, limit_reached, key_reused. Audited (ehr.clinical-shift.update).';

  revoke all on function ehr.clinical_shift_create(text, text, text, text, text),
    ehr.clinical_shift_update(uuid, bigint, text, boolean, text, text) from public;

  -- Route 15: a ward's list for a shift.
  create function ehr.shift_assignments_read(requested_date date, requested_shift uuid, requested_ward uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    window_row record;
  begin
    select * into caller from ehr.nursing_caller('assign_read', array['direct-care', 'healthcare-operations']);
    if requested_date is null or requested_shift is null or requested_ward is null then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    if not exists (select 1 from ehr.clinical_shifts shift
                    where shift.id = requested_shift and shift.facility_id = caller.actor_facility) then
      return jsonb_build_object('outcome', 'shift_not_found');
    end if;
    if not exists (select 1 from ehr.wards ward where ward.id = requested_ward and ward.facility_id = caller.actor_facility) then
      return jsonb_build_object('outcome', 'ward_not_found');
    end if;
    select * into window_row from ehr.clinical_shift_window(requested_shift, requested_date);
    return jsonb_build_object('outcome', 'found', 'date', requested_date, 'shiftId', requested_shift,
      'wardId', requested_ward, 'from', window_row.starts, 'to', window_row.ends,
      'version', coalesce((select max(event.version) from ehr.shift_assignment_events event
                            where event.shift_date = requested_date and event.shift_id = requested_shift
                              and event.ward_id = requested_ward), 0),
      'assignments', coalesce((select jsonb_agg(jsonb_build_object('membershipId', assignment.membership_id,
          'duty', assignment.duty,
          'admissionIds', coalesce((select jsonb_agg(allocation.admission_id order by allocation.admission_id)
                                      from ehr.shift_patient_allocations allocation
                                     where allocation.assignment_id = assignment.id), '[]'::jsonb))
          order by assignment.duty, assignment.membership_id)
        from ehr.shift_assignments assignment
       where assignment.shift_date = requested_date and assignment.shift_id = requested_shift
         and assignment.ward_id = requested_ward), '[]'::jsonb));
  end
  $fn$;
  comment on function ehr.shift_assignments_read(date, uuid, uuid) is
    '0176 (NUR-1, Q193 A): a ward''s list for a shift of a Lagos date: who works it, as what, and which admissions each nurse looks after (ids only), with the list''s version. Needs ehr.nursing-task.read or ehr.shift-assignment.manage. Outcomes found, shift_not_found, ward_not_found.';
  revoke all on function ehr.shift_assignments_read(date, uuid, uuid) from public;

  create function ehr.shift_assignments_set(requested_date date, requested_shift uuid, requested_ward uuid,
    requested_expected_version integer, requested_assignments jsonb, requested_idempotency_key text,
    requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    ward_row ehr.wards%rowtype;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    current_version integer;
    item jsonb;
    member_value uuid;
    duty_value text;
    admission_value uuid;
    assignment_id uuid;
    refusal text;
    event_id uuid;
    members uuid[] := '{}'::uuid[];
    admissions uuid[] := '{}'::uuid[];
    warnings text[] := '{}'::text[];
  begin
    select * into caller from ehr.nursing_caller('assign', array['direct-care', 'healthcare-operations']);
    if requested_date is null or requested_shift is null or requested_ward is null
       or requested_expected_version is null or requested_expected_version < 0
       or requested_date < today - 1 or requested_date > today + 14
       or requested_assignments is null or jsonb_typeof(requested_assignments) <> 'array'
       or jsonb_array_length(requested_assignments) > 60 then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    -- The shape of each row (ids, the duty, at most 20 admissions) and one row per member.
    for item in select value from jsonb_array_elements(requested_assignments) loop
      if jsonb_typeof(item) <> 'object' or (item - array['membershipId', 'duty', 'admissionIds']) <> '{}'::jsonb
         or coalesce(item->>'membershipId', '') !~ '^[0-9a-fA-F-]{36}$'
         or coalesce(item->>'duty', '') not in ('nurse', 'nurse_in_charge', 'on_call_doctor')
         or (item ? 'admissionIds' and (jsonb_typeof(item->'admissionIds') <> 'array'
             or jsonb_array_length(item->'admissionIds') > 20
             or exists (select 1 from jsonb_array_elements_text(item->'admissionIds') admission_text
                         where admission_text !~ '^[0-9a-fA-F-]{36}$')))
         or (item->>'duty' = 'on_call_doctor' and coalesce(jsonb_array_length(item->'admissionIds'), 0) > 0)
         or (item->>'membershipId')::uuid = any (members) then
        raise exception using errcode = '22023', message = 'NURSING_INVALID';
      end if;
      members := members || (item->>'membershipId')::uuid;
    end loop;
    if (select count(*) from jsonb_array_elements(requested_assignments) row_item
         where row_item->>'duty' = 'nurse_in_charge') > 1
       or (select count(*) from jsonb_array_elements(requested_assignments) row_item
            where row_item->>'duty' = 'on_call_doctor') > 1 then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'assignments_set' then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'list', ehr.shift_assignments_read(requested_date, requested_shift, requested_ward), 'warnings', '[]'::jsonb);
    end if;
    perform pg_advisory_xact_lock(hashtextextended('shift-assignments:' || requested_date::text || ':'
      || requested_shift::text || ':' || requested_ward::text, 0));
    select ward.* into ward_row from ehr.wards ward
     where ward.id = requested_ward and ward.facility_id = caller.actor_facility;
    if not found then
      refusal := 'ward_not_found';
    elsif not exists (select 1 from ehr.clinical_shifts shift
                       where shift.id = requested_shift and shift.facility_id = caller.actor_facility and shift.active) then
      refusal := 'shift_not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;
    current_version := coalesce((select max(event.version) from ehr.shift_assignment_events event
                                  where event.shift_date = requested_date and event.shift_id = requested_shift
                                    and event.ward_id = requested_ward), 0);
    if refusal is null and current_version <> requested_expected_version then
      refusal := 'changed';
    end if;
    if refusal is null then
      for item in select value from jsonb_array_elements(requested_assignments) loop
        member_value := (item->>'membershipId')::uuid;
        duty_value := item->>'duty';
        if not ehr.inpatient_member_has_role(member_value, caller.actor_facility,
             case when duty_value = 'on_call_doctor' then array['doctor', 'clinician']
                  else array['nurse', 'clinician'] end) then
          refusal := 'assignee_invalid';
          exit;
        end if;
        for admission_value in select admission_text::uuid from jsonb_array_elements_text(coalesce(item->'admissionIds',
                                 '[]'::jsonb)) admission_text loop
          if admission_value = any (admissions)
             or not exists (select 1 from ehr.admissions admission
                             where admission.id = admission_value and admission.facility_id = caller.actor_facility
                               and admission.ward_id = requested_ward
                               and admission.status in ('admitted', 'discharge_ready'))
             or exists (select 1 from ehr.shift_patient_allocations allocation
                         where allocation.shift_date = requested_date and allocation.shift_id = requested_shift
                           and allocation.admission_id = admission_value and allocation.ward_id <> requested_ward) then
            refusal := 'admission_invalid';
            exit;
          end if;
          admissions := admissions || admission_value;
        end loop;
        exit when refusal is not null;
        if ward_row.ward_type = 'icu' and coalesce(jsonb_array_length(item->'admissionIds'), 0) > 2
           and not 'icu_nurse_over_two' = any (warnings) then
          warnings := array_append(warnings, 'icu_nurse_over_two');
        end if;
      end loop;
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(null, 'ehr.shift-assignment.set',
        case when refusal in ('ward_not_found', 'shift_not_found') then 'failure' else 'denied' end, 'ward',
        requested_ward::text, jsonb_build_object('refusal', refusal, 'date', requested_date, 'shiftId', requested_shift));
      return jsonb_build_object('outcome', refusal);
    end if;
    -- The whole list for the ward and shift is replaced; the history keeps every version.
    delete from ehr.shift_patient_allocations allocation
     where allocation.shift_date = requested_date and allocation.shift_id = requested_shift
       and allocation.ward_id = requested_ward;
    delete from ehr.shift_assignments assignment
     where assignment.shift_date = requested_date and assignment.shift_id = requested_shift
       and assignment.ward_id = requested_ward;
    for item in select value from jsonb_array_elements(requested_assignments) loop
      insert into ehr.shift_assignments (facility_id, shift_date, shift_id, ward_id, membership_id, duty,
        set_by_membership_id)
      values (caller.actor_facility, requested_date, requested_shift, requested_ward, (item->>'membershipId')::uuid,
        item->>'duty', caller.actor_membership)
      returning id into assignment_id;
      insert into ehr.shift_patient_allocations (assignment_id, facility_id, shift_date, shift_id, ward_id,
        membership_id, admission_id)
      select assignment_id, caller.actor_facility, requested_date, requested_shift, requested_ward,
             (item->>'membershipId')::uuid, admission_text::uuid
        from jsonb_array_elements_text(coalesce(item->'admissionIds', '[]'::jsonb)) admission_text;
    end loop;
    insert into ehr.shift_assignment_events (facility_id, shift_date, shift_id, ward_id, version, assignments,
      by_membership_id)
    values (caller.actor_facility, requested_date, requested_shift, requested_ward, current_version + 1,
      requested_assignments, caller.actor_membership)
    returning id into event_id;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, 'assignments_set', event_id);
    perform ehr.inpatient_audit(null, 'ehr.shift-assignment.set', 'success', 'ward', requested_ward::text,
      jsonb_build_object('date', requested_date, 'shiftId', requested_shift, 'version', current_version + 1,
        'assignmentCount', jsonb_array_length(requested_assignments),
        'allocationCount', coalesce(cardinality(admissions), 0)));
    return jsonb_build_object('outcome', 'updated', 'replayed', false,
      'list', ehr.shift_assignments_read(requested_date, requested_shift, requested_ward),
      'warnings', to_jsonb(warnings));
  end
  $fn$;
  comment on function ehr.shift_assignments_set(date, uuid, uuid, integer, jsonb, text, text) is
    '0176 (NUR-1, Q193 A, Q194 A): replaces a ward''s whole list for a shift of a Lagos date (yesterday to 14 days ahead), at the version read: nurses and the nurse in charge (active nurses or clinicians here) with the admissions each looks after (open admissions on that ward; one nurse per patient per shift), and the on-call doctor (an active doctor or clinician). At most one nurse in charge and one on-call doctor. Every version is kept. An ICU nurse with more than two patients is a warning, never a refusal. An assignment opens no chart. Needs ehr.shift-assignment.manage. Outcomes updated (replayed; list, warnings), ward_not_found, shift_not_found, changed, assignee_invalid, admission_invalid, key_reused. Audited (ehr.shift-assignment.set; counts only).';
  revoke all on function ehr.shift_assignments_set(date, uuid, uuid, integer, jsonb, text, text) from public;

  -- Route 16: the handover sheet.
  create function ehr.handover_read(requested_ward uuid, requested_date date, requested_shift uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    ward_row ehr.wards%rowtype;
    sheet ehr.shift_handovers%rowtype;
    this_window record;
    next_window record;
    now_value timestamptz := clock_timestamp();
    stay record;
    chart_shown boolean;
    patients jsonb := '[]'::jsonb;
    shown_ids uuid[] := '{}'::uuid[];
    item_row ehr.shift_handover_items%rowtype;
    note_text text;
    fluid_day_start timestamptz;
    start_hour integer;
    counts record;
  begin
    select * into caller from ehr.nursing_caller('task_read', array['direct-care']);
    if requested_ward is null or requested_date is null or requested_shift is null then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select ward.* into ward_row from ehr.wards ward
     where ward.id = requested_ward and ward.facility_id = caller.actor_facility;
    if not found or not exists (select 1 from ehr.clinical_shifts shift
                                 where shift.id = requested_shift and shift.facility_id = caller.actor_facility) then
      perform ehr.inpatient_audit(null, 'ehr.handover.read', 'failure', 'ward', requested_ward::text,
        jsonb_build_object('refusal', 'not_found'));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    select handover.* into sheet from ehr.shift_handovers handover
     where handover.ward_id = requested_ward and handover.shift_date = requested_date
       and handover.shift_id = requested_shift;
    select * into this_window from ehr.clinical_shift_window(requested_shift, requested_date);
    select * into next_window from ehr.clinical_shift_next(requested_shift, requested_date);
    start_hour := ehr.nursing_fluid_day_start_hour(caller.actor_facility);
    fluid_day_start := ((((now_value at time zone 'Africa/Lagos') - make_interval(hours => start_hour))::date
                         + make_interval(hours => start_hour)) at time zone 'Africa/Lagos');
    for stay in
      select admission.id, admission.patient_id, admission.encounter_id, card.card, card.name_shown, bed.name as bed_name
        from ehr.admissions admission
        left join ehr.beds bed on bed.id = admission.bed_id
        cross join lateral ehr.admission_cards(array[admission.id], false) card
       where admission.facility_id = caller.actor_facility
         and ((admission.ward_id = requested_ward and admission.status in ('admitted', 'discharge_ready'))
              or exists (select 1 from ehr.shift_handover_items handover_item
                          where handover_item.handover_id = sheet.id and handover_item.admission_id = admission.id))
       order by lower(coalesce(bed.name, '~')), admission.id
    loop
      chart_shown := coalesce(ehr.context_allows(stay.patient_id, caller.actor_facility, 'read_records'), false);
      select count(*) filter (where due.scheduled_for >= this_window.starts
                                and due.scheduled_for < least(this_window.ends, now_value)
                                and due.state not in ('given', 'upcoming', 'due')) as missed,
             count(*) filter (where next_window.starts is not null and due.scheduled_for >= next_window.starts
                                and due.scheduled_for < next_window.ends) as due_next
        into counts
        from ehr.mar_due_doses(stay.id, this_window.starts,
                               greatest(coalesce(next_window.ends, this_window.ends), this_window.ends)) due;
      select handover_item.* into item_row from ehr.shift_handover_items handover_item
       where handover_item.handover_id = sheet.id and handover_item.admission_id = stay.id;
      if not found then
        item_row := null;
      end if;
      note_text := null;
      if chart_shown and item_row.clinical_note_id is not null then
        select revision.content into note_text
          from ehr.clinical_notes note
          join ehr.clinical_note_revisions revision
            on revision.clinical_note_id = note.id and revision.revision_no = note.current_revision_no
         where note.id = item_row.clinical_note_id;
      end if;
      patients := patients || jsonb_build_array(jsonb_build_object(
        'admissionId', stay.id, 'patient', stay.card, 'bedName', stay.bed_name, 'chartShown', chart_shown,
        'lastObservationAt', case when chart_shown then (select max(vital.recorded_at) from ehr.vitals vital
                                    where vital.encounter_id = stay.encounter_id and vital.status = 'recorded') end,
        -- The readings of this shift so far (chart only), for ehr-api to count VIT-1's soft flags; never stored.
        'shiftReadings', case when chart_shown then coalesce((select jsonb_agg(to_jsonb(vital)
                                 || coalesce(correction.replacement_values, '{}'::jsonb) order by vital.recorded_at)
                               from ehr.vitals vital
                               left join ehr.vital_corrections correction
                                 on correction.vital_id = vital.id
                                and correction.correction_no = vital.current_correction_no
                              where vital.encounter_id = stay.encounter_id and vital.status = 'recorded'
                                and vital.recorded_at >= this_window.starts
                                and vital.recorded_at < this_window.ends), '[]'::jsonb) end,
        'dosesMissedThisShift', counts.missed, 'dosesDueNextShift', counts.due_next,
        'openTasks', (select count(*) from ehr.nursing_tasks task
                       where task.admission_id = stay.id and task.status in ('assigned', 'in_progress')),
        'overdueTasks', (select count(*) from ehr.nursing_tasks task
                          where task.admission_id = stay.id and task.status in ('assigned', 'in_progress')
                            and task.due_at < now_value),
        'fluidBalanceMl', case when chart_shown then coalesce((select sum(case when entry.direction = 'in'
                                    then entry.volume_ml else -entry.volume_ml end)
                                  from ehr.fluid_balance_entries entry
                                 where entry.admission_id = stay.id and entry.status = 'recorded'
                                   and not entry.not_measured and entry.recorded_at >= fluid_day_start), 0) end,
        'watch', coalesce(item_row.watch, false), 'handoverNoteId', item_row.clinical_note_id,
        'handoverNote', note_text, 'noteHidden', not chart_shown,
        'itemRowVersion', item_row.row_version));
      shown_ids := shown_ids || stay.patient_id;
      perform ehr.inpatient_audit(stay.patient_id, 'ehr.handover.read.shown', 'success', 'admission', stay.id::text,
        jsonb_build_object('wardId', requested_ward, 'nameShown', stay.name_shown, 'chartShown', chart_shown));
    end loop;
    perform ehr.inpatient_audit(null, 'ehr.handover.read', 'success', 'ward', requested_ward::text,
      jsonb_build_object('date', requested_date, 'shiftId', requested_shift, 'handoverId', sheet.id,
        'count', jsonb_array_length(patients), 'patientIds', to_jsonb(shown_ids)));
    return jsonb_build_object('outcome', 'found', 'handoverId', sheet.id, 'status', coalesce(sheet.status, 'draft'),
      'wardId', requested_ward, 'wardType', ward_row.ward_type, 'date', requested_date, 'shiftId', requested_shift,
      'from', this_window.starts, 'to', this_window.ends,
      'nextShift', case when next_window.shift_id is null then null else jsonb_build_object(
        'shiftId', next_window.shift_id, 'date', next_window.shift_date, 'from', next_window.starts,
        'to', next_window.ends) end,
      'fromMembershipIds', coalesce((select jsonb_agg(assignment.membership_id order by assignment.membership_id)
          from ehr.shift_assignments assignment
         where assignment.shift_date = requested_date and assignment.shift_id = requested_shift
           and assignment.ward_id = requested_ward and assignment.duty in ('nurse', 'nurse_in_charge')), '[]'::jsonb),
      'toMembershipIds', coalesce((select jsonb_agg(assignment.membership_id order by assignment.membership_id)
          from ehr.shift_assignments assignment
         where assignment.shift_date = next_window.shift_date and assignment.shift_id = next_window.shift_id
           and assignment.ward_id = requested_ward and assignment.duty in ('nurse', 'nurse_in_charge')), '[]'::jsonb),
      'givenByMembershipId', sheet.given_by_membership_id, 'givenAt', sheet.given_at,
      'acceptedByMembershipId', sheet.accepted_by_membership_id, 'acceptedAt', sheet.accepted_at,
      'rowVersion', sheet.row_version, 'patients', patients);
  end
  $fn$;
  comment on function ehr.handover_read(uuid, date, uuid) is
    '0176 (NUR-1, Q193 A): a ward''s handover sheet for a shift of a Lagos date (a draft with no notes when none exists yet): the ward''s patients (and any on the sheet who moved), each with the doses missed this shift and due next shift, open and overdue tasks (for everyone), and, only where the member can read the chart, the last observation time, this shift''s readings (for ehr-api to count the soft flags; never stored), the fluid day''s balance and the handover note. Names under ADT-1''s rule (Q190). The outgoing and incoming nurses from the shift assignments. Needs ehr.nursing-task.read. Outcomes found, not_found. Audited (ehr.handover.read with the patient ids, and one .shown row per patient).';
  revoke all on function ehr.handover_read(uuid, date, uuid) from public;

  -- Route 17: a patient's handover note on a draft sheet (made on the first note).
  create function ehr.handover_note_put(requested_handover uuid, requested_admission uuid, requested_ward uuid,
    requested_date date, requested_shift uuid, requested_row_version bigint, requested_note text,
    requested_watch boolean, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    sheet ehr.shift_handovers%rowtype;
    admission_row ehr.admissions%rowtype;
    item_row ehr.shift_handover_items%rowtype;
    note_value text := nullif(btrim(coalesce(requested_note, '')), '');
    refusal text;
    note_id uuid;
    revision integer;
    previous_reason text := current_setting('app.change_reason', true);
    shift_name text;
    ward_name text;
  begin
    select * into caller from ehr.nursing_caller('handover', array['direct-care']);
    if requested_admission is null or note_value is null or length(note_value) > 2000
       or (requested_handover is null and (requested_ward is null or requested_date is null or requested_shift is null)) then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'handover_note' then
      return jsonb_build_object('outcome', 'updated', 'replayed', true, 'handoverId', key_state.resource_id,
        'item', (select jsonb_build_object('admissionId', handover_item.admission_id,
                   'handoverNoteId', handover_item.clinical_note_id, 'watch', handover_item.watch,
                   'rowVersion', handover_item.row_version)
                   from ehr.shift_handover_items handover_item
                  where handover_item.handover_id = key_state.resource_id
                    and handover_item.admission_id = requested_admission));
    end if;
    if requested_handover is not null then
      select handover.* into sheet from ehr.shift_handovers handover
       where handover.id = requested_handover and handover.facility_id = caller.actor_facility for update;
      if not found then
        refusal := 'not_found';
      end if;
    else
      if not exists (select 1 from ehr.wards ward where ward.id = requested_ward and ward.facility_id = caller.actor_facility)
         or not exists (select 1 from ehr.clinical_shifts shift
                         where shift.id = requested_shift and shift.facility_id = caller.actor_facility) then
        refusal := 'not_found';
      else
        perform pg_advisory_xact_lock(hashtextextended('handover:' || requested_ward::text || ':'
          || requested_date::text || ':' || requested_shift::text, 0));
        select handover.* into sheet from ehr.shift_handovers handover
         where handover.ward_id = requested_ward and handover.shift_date = requested_date
           and handover.shift_id = requested_shift for update;
        if not found then
          insert into ehr.shift_handovers (facility_id, ward_id, shift_date, shift_id, created_by_membership_id)
          values (caller.actor_facility, requested_ward, requested_date, requested_shift, caller.actor_membership)
          returning * into sheet;
        end if;
      end if;
    end if;
    if refusal is null then
      select admission.* into admission_row from ehr.admissions admission
       where admission.id = requested_admission and admission.facility_id = caller.actor_facility for share;
      select handover_item.* into item_row from ehr.shift_handover_items handover_item
       where handover_item.handover_id = sheet.id and handover_item.admission_id = requested_admission for update;
      if admission_row.id is null then
        refusal := 'admission_not_found';
      elsif key_state.state <> 'new' then
        refusal := 'key_reused';
      elsif sheet.status <> 'draft' then
        refusal := 'not_draft';
      elsif admission_row.status not in ('admitted', 'discharge_ready')
            or (admission_row.ward_id is distinct from sheet.ward_id and item_row.handover_id is null) then
        refusal := 'admission_not_open';
      elsif item_row.handover_id is not null and requested_row_version is not null
            and item_row.row_version <> requested_row_version then
        refusal := 'changed';
      elsif not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'write_records'), false) then
        refusal := 'chart_access_required';
      end if;
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.handover.note',
        case when refusal in ('not_found', 'admission_not_found') then 'failure' else 'denied' end, 'handover',
        coalesce(sheet.id, requested_handover)::text, jsonb_build_object('refusal', refusal,
          'admissionId', requested_admission));
      return jsonb_build_object('outcome', refusal);
    end if;
    if item_row.handover_id is null then
      -- The note is a signed clinical note of the stay's visit, written by the member who writes it.
      select shift.name into shift_name from ehr.clinical_shifts shift where shift.id = sheet.shift_id;
      select ward.name into ward_name from ehr.wards ward where ward.id = sheet.ward_id;
      insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
        note_type, title, status, signed_at, signed_by)
      values (admission_row.encounter_id, admission_row.patient_id, admission_row.facility_id, caller.actor_account,
        caller.actor_membership, 'Nursing handover',
        left('Nursing handover: ' || ward_name || ', ' || shift_name || ', ' || to_char(sheet.shift_date, 'DD Mon YYYY'), 240),
        'signed', clock_timestamp(), caller.actor_account)
      returning id into note_id;
      insert into ehr.clinical_note_revisions (clinical_note_id, patient_id, facility_id, revision_no, content,
        change_reason, supersedes_revision_no, created_by, created_by_membership_id)
      values (note_id, admission_row.patient_id, admission_row.facility_id, 1, note_value, 'initial clinical note', null,
        caller.actor_account, caller.actor_membership);
      insert into ehr.shift_handover_items (handover_id, admission_id, clinical_note_id, watch, written_by_membership_id)
      values (sheet.id, admission_row.id, note_id, coalesce(requested_watch, false), caller.actor_membership);
      revision := 1;
    else
      note_id := item_row.clinical_note_id;
      select note.current_revision_no + 1 into revision from ehr.clinical_notes note where note.id = note_id for update;
      if revision is null then
        perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.handover.note', 'denied', 'handover',
          sheet.id::text, jsonb_build_object('refusal', 'chart_access_required', 'admissionId', admission_row.id));
        return jsonb_build_object('outcome', 'chart_access_required');
      end if;
      insert into ehr.clinical_note_revisions (clinical_note_id, patient_id, facility_id, revision_no, content,
        change_reason, supersedes_revision_no, created_by, created_by_membership_id)
      values (note_id, admission_row.patient_id, admission_row.facility_id, revision, note_value,
        'Handover note revised on the draft sheet', revision - 1, caller.actor_account, caller.actor_membership);
      perform set_config('app.change_reason', 'Handover note revised on the draft sheet', true);
      update ehr.clinical_notes note
         set current_revision_no = revision, status = 'amended'
       where note.id = note_id;
      perform set_config('app.change_reason', coalesce(previous_reason, ''), true);
      update ehr.shift_handover_items handover_item
         set watch = coalesce(requested_watch, handover_item.watch), written_by_membership_id = caller.actor_membership,
             updated_at = clock_timestamp(), row_version = handover_item.row_version + 1
       where handover_item.handover_id = sheet.id and handover_item.admission_id = admission_row.id;
    end if;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, 'handover_note', sheet.id);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.handover.note', 'success', 'handover', sheet.id::text,
      jsonb_build_object('admissionId', admission_row.id, 'clinicalNoteId', note_id, 'revision', revision,
        'watch', coalesce(requested_watch, false)));
    return jsonb_build_object('outcome', 'updated', 'replayed', false, 'handoverId', sheet.id,
      'item', (select jsonb_build_object('admissionId', handover_item.admission_id,
                 'handoverNoteId', handover_item.clinical_note_id, 'watch', handover_item.watch,
                 'rowVersion', handover_item.row_version)
                 from ehr.shift_handover_items handover_item
                where handover_item.handover_id = sheet.id and handover_item.admission_id = admission_row.id));
  end
  $fn$;
  comment on function ehr.handover_note_put(uuid, uuid, uuid, date, uuid, bigint, text, boolean, text, text) is
    '0176 (NUR-1, Q193 A): a patient''s handover note (1-2000 characters) and watch mark on a draft sheet, making the sheet on its first note. The note is a clinical note "Nursing handover" of the stay''s visit, signed by the member who writes it; a later write on the draft sheet is a new revision of the same note. A given sheet''s notes are final. Needs ehr.handover.write and chart write access. Outcomes updated (replayed), not_found, admission_not_found, not_draft, admission_not_open, changed, chart_access_required, key_reused. Audited (ehr.handover.note; never the text).';
  revoke all on function ehr.handover_note_put(uuid, uuid, uuid, date, uuid, bigint, text, boolean, text, text) from public;

  -- Route 18: give and accept the sheet.
  create function ehr.handover_step(requested_handover uuid, requested_row_version bigint, requested_step text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    sheet ehr.shift_handovers%rowtype;
    next_window record;
    refusal text;
    action_name text := 'ehr.handover.' || requested_step;
  begin
    select * into caller from ehr.nursing_caller('handover', array['direct-care']);
    if requested_handover is null or requested_row_version is null or requested_step not in ('give', 'accept') then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'handover_' || requested_step
       and key_state.resource_id = requested_handover then
      return jsonb_build_object('outcome', 'updated', 'replayed', true, 'handover',
        (select jsonb_build_object('handoverId', handover.id, 'status', handover.status,
           'givenByMembershipId', handover.given_by_membership_id, 'givenAt', handover.given_at,
           'acceptedByMembershipId', handover.accepted_by_membership_id, 'acceptedAt', handover.accepted_at,
           'rowVersion', handover.row_version) from ehr.shift_handovers handover where handover.id = requested_handover));
    end if;
    select handover.* into sheet from ehr.shift_handovers handover
     where handover.id = requested_handover and handover.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif sheet.row_version <> requested_row_version then
      refusal := 'changed';
    elsif requested_step = 'give' and sheet.status <> 'draft' then
      refusal := 'not_draft';
    elsif requested_step = 'accept' and sheet.status = 'draft' then
      refusal := 'not_given';
    elsif requested_step = 'accept' and sheet.status = 'accepted' then
      refusal := 'already_accepted';
    end if;
    if refusal is null and requested_step = 'accept' then
      select * into next_window from ehr.clinical_shift_next(sheet.shift_id, sheet.shift_date);
      if next_window.shift_id is null
         or not exists (select 1 from ehr.shift_assignments assignment
                         where assignment.shift_date = next_window.shift_date
                           and assignment.shift_id = next_window.shift_id and assignment.ward_id = sheet.ward_id
                           and assignment.membership_id = caller.actor_membership
                           and assignment.duty in ('nurse', 'nurse_in_charge')) then
        refusal := 'not_yours';
      end if;
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(null, action_name, case when refusal = 'not_found' then 'failure' else 'denied' end,
        'handover', requested_handover::text, jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    if requested_step = 'give' then
      update ehr.shift_handovers handover
         set status = 'given', given_by_membership_id = caller.actor_membership, given_at = clock_timestamp(),
             row_version = handover.row_version + 1
       where handover.id = sheet.id;
    else
      update ehr.shift_handovers handover
         set status = 'accepted', accepted_by_membership_id = caller.actor_membership, accepted_at = clock_timestamp(),
             row_version = handover.row_version + 1
       where handover.id = sheet.id;
    end if;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, 'handover_' || requested_step, sheet.id);
    perform ehr.inpatient_audit(null, action_name, 'success', 'handover', sheet.id::text,
      jsonb_build_object('wardId', sheet.ward_id, 'date', sheet.shift_date, 'shiftId', sheet.shift_id,
        'patientCount', (select count(*) from ehr.shift_handover_items handover_item
                          where handover_item.handover_id = sheet.id)));
    return jsonb_build_object('outcome', 'updated', 'replayed', false, 'handover',
      (select jsonb_build_object('handoverId', handover.id, 'status', handover.status,
         'givenByMembershipId', handover.given_by_membership_id, 'givenAt', handover.given_at,
         'acceptedByMembershipId', handover.accepted_by_membership_id, 'acceptedAt', handover.accepted_at,
         'rowVersion', handover.row_version) from ehr.shift_handovers handover where handover.id = sheet.id));
  end
  $fn$;
  revoke all on function ehr.handover_step(uuid, bigint, text, text, text) from public;

  create function ehr.handover_give(requested_handover uuid, requested_row_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.handover_step(requested_handover, requested_row_version, 'give', requested_idempotency_key,
      requested_request_sha256)
  $fn$;
  comment on function ehr.handover_give(uuid, bigint, text, text) is
    '0176 (NUR-1, Q193 A): the outgoing nurse gives the draft sheet (given, with who and when); its notes are final. Needs ehr.handover.write. Outcomes updated (replayed), not_found, changed, not_draft, key_reused. Audited (ehr.handover.give).';
  create function ehr.handover_accept(requested_handover uuid, requested_row_version bigint,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.handover_step(requested_handover, requested_row_version, 'accept', requested_idempotency_key,
      requested_request_sha256)
  $fn$;
  comment on function ehr.handover_accept(uuid, bigint, text, text) is
    '0176 (NUR-1, Q193 A): a nurse (or nurse in charge) assigned to the next shift on this ward accepts the given sheet. Needs ehr.handover.write. Outcomes updated (replayed), not_found, changed, not_given, already_accepted, not_yours, key_reused. Audited (ehr.handover.accept).';

  revoke all on function ehr.handover_give(uuid, bigint, text, text), ehr.handover_accept(uuid, bigint, text, text)
    from public;

  -- T8. 0173's ward-team access (still switched off): a nurse allocated to the patient on the current shift.
  v_definition := pg_get_functiondef('identity.open_ward_stay(uuid)'::regprocedure);
  if position(v_old_team in v_definition) = 0 then
    raise exception using errcode = '55000', message = '0176: identity.open_ward_stay is not as 0173 wrote it';
  end if;
  execute replace(v_definition, v_old_team, v_new_team);
  comment on function identity.open_ward_stay(uuid) is
    '0173 (ADT-1, Q156 A, Q-ADT-15 A) and 0176 (NUR-1, Q193 A): "Open chart for this stay". Switched off: refuses with WARD_STAY_ACCESS_NOT_AVAILABLE while ehr.inpatient_switches.ward_stay_access is false. A nurse, clinician or doctor of this facility on the ward team (the staff list of the ward the patient is in, the responsible doctor, or a nurse allocated to the patient on the current clinical shift) gets a write grant for direct care tied to the admitted or discharge-ready admission (authorization_method ward_stay), reused while active; it ends at discharge, or 2 hours after the patient leaves the member''s ward, and the patient can end it. refused for not on the ward team, the state, or a deny directive. Every call is audited (identity.ward-stay.open).';

  -- Owners and EXECUTE (as 0135: the owner of identity.has_active_consent_grant).
  if v_owner <> current_user then
    execute (select string_agg(format('alter table %s owner to %I', table_name, v_owner), '; ')
               from unnest(v_tables) table_name);
    execute (select string_agg(format('alter function %s owner to %I', proc.oid::regprocedure, v_owner), '; ')
               from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'ehr'
                and (proc.proname like 'nursing\_task%' or proc.proname like 'fluid\_balance\_%'
                     or proc.proname like 'clinical\_shift%' or proc.proname like 'shift\_%'
                     or proc.proname like 'handover\_%' or proc.proname = 'nursing_fluid_day_start_hour'));
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function
      ehr.nursing_task_list(uuid, uuid, text, boolean),
      ehr.nursing_task_create(uuid, text, timestamptz, uuid, integer, text, text),
      ehr.nursing_task_start(uuid, bigint, text, text),
      ehr.nursing_task_complete(uuid, bigint, text, text, text),
      ehr.nursing_task_cancel(uuid, bigint, text, text, text),
      ehr.nursing_task_update(uuid, bigint, uuid, timestamptz, text, text),
      ehr.fluid_balance_read(uuid, date),
      ehr.fluid_balance_record(uuid, text, text, integer, boolean, timestamptz, text, text, text),
      ehr.fluid_balance_entered_in_error(uuid, bigint, text, text, text),
      ehr.clinical_shift_list(),
      ehr.clinical_shift_create(text, text, text, text, text),
      ehr.clinical_shift_update(uuid, bigint, text, boolean, text, text),
      ehr.shift_assignments_read(date, uuid, uuid),
      ehr.shift_assignments_set(date, uuid, uuid, integer, jsonb, text, text),
      ehr.handover_read(uuid, date, uuid),
      ehr.handover_note_put(uuid, uuid, uuid, date, uuid, bigint, text, boolean, text, text),
      ehr.handover_give(uuid, bigint, text, text),
      ehr.handover_accept(uuid, bigint, text, text)
      to hid_ehr_runtime;
  end if;

  -- 3. Post-checks.
  if exists (select 1 from pg_class class_row,
                    lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid = any (select to_regclass(table_name) from unnest(v_tables) table_name)
                and acl.grantee <> class_row.relowner)
     or (select count(*) from pg_class
          where oid = any (select to_regclass(table_name) from unnest(v_tables) table_name) and relrowsecurity) <> 9
     or exists (select 1 from pg_policy
                 where polrelid = any (select to_regclass(table_name) from unnest(v_tables) table_name)) then
    raise exception using errcode = '55000',
      message = '0176: post-check failed (a table is granted to a role, has a policy or lacks row-level security)';
  end if;
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgenabled = 'O'
         and (trigger_row.tgrelid, trigger_row.tgname) in
               (('ehr.admissions'::regclass, 'admissions_nursing_tasks_close'),
                ('ehr.nursing_tasks'::regclass, 'nursing_tasks_no_delete'),
                ('ehr.fluid_balance_entries'::regclass, 'fluid_balance_guard'),
                ('ehr.shift_assignment_events'::regclass, 'shift_assignment_events_immutable'))) <> 4 then
    raise exception using errcode = '55000', message = '0176: post-check failed (the triggers)';
  end if;
  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('ehr.admission_discharge(uuid,bigint,text,timestamp with time zone,jsonb,text,timestamp with time zone,text,text,text)',
       '21945aa0791c9c89af7c3944706c1df6'),
      ('ehr.admission_notice_recipients(uuid)', 'ef7cd7cb428e7e2e13f4c3f9efe5ed52'),
      ('ehr.observation_fluid_hours(uuid,timestamp with time zone,timestamp with time zone)',
       '877e4805842ad94be6632d5fa4f12796'),
      ('identity.open_ward_stay(uuid)', '48b6a9190fb77fd090ccee4bb5040cf0')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0176: post-check failed (a replaced or kept body): ' || v_mismatch;
  end if;
  if exists (select 1 from pg_proc proc
               join pg_namespace namespace on namespace.oid = proc.pronamespace,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where namespace.nspname = 'ehr'
                and (proc.proname like 'nursing\_task%' or proc.proname like 'fluid\_balance\_%'
                     or proc.proname like 'clinical\_shift%' or proc.proname like 'shift\_%'
                     or proc.proname like 'handover\_%' or proc.proname = 'nursing_fluid_day_start_hour'
                     or proc.proname in ('observation_fluid_hours', 'admission_notice_recipients'))
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or not proc.proname = any (v_runtime)))
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr' and proc.prosecdef and proc.proname = any (v_runtime)) <> 18
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'nursing\_task%' or proc.proname like 'fluid\_balance\_%'
                 or proc.proname like 'clinical\_shift%' or proc.proname like 'shift\_%'
                 or proc.proname like 'handover\_%' or proc.proname = 'nursing_fluid_day_start_hour')) <> 29
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'nursing\_task%' or proc.proname like 'fluid\_balance\_%'
                        or proc.proname like 'clinical\_shift%' or proc.proname like 'shift\_%'
                        or proc.proname like 'handover\_%' or proc.proname = 'nursing_fluid_day_start_hour')
                   and proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp'])
     or exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid = 'identity.open_ward_stay(uuid)'::regprocedure and acl.grantee <> proc.proowner
                   and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime'))
     or coalesce((select switch_row.enabled from ehr.inpatient_switches switch_row
                   where switch_row.key = 'ward_stay_access'), true) then
    raise exception using errcode = '55000', message = '0176: post-check failed (the functions'' security or grants)';
  end if;
  if (select count(*) from audit.events) <> v_audit_rows then
    raise exception using errcode = '55000', message = '0176: post-check failed (an audit row was written)';
  end if;

  raise notice '0176: nursing tasks, fluid balance, clinical shifts and assignments, and shift handover are installed (9 tables, 29 functions; 3 bodies replaced: the ICU grid''s fluid, who is told of a critical result on a ward, and ward-team access, still off). Nobody can use them until 0177 gives the codes.';
end
$nur0176$;
