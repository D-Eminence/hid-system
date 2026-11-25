-- 0175 NUR-1 Nursing on the ward: inpatient medicine orders and the medicine
-- round (Release D, the department sprint the owner approved on 25 November
-- 2026, verbatim: "I approve Q147–Q290 at the recommended options"). Written on
-- claude/sprint-inpatient-backend at e224bc62 (staging at 0cfddcc9: 0001-0153
-- applied) after 0174 in the same pull request. The number is provisional
-- (given at merge). Ola reviews this file (the medicine rules), countersigned
-- by the clinical lead (owner decision Q158 A). The declaration in
-- config/production-schema-compatibility.json stays unsigned until the owner
-- signs this file.
--
-- Owner decisions (25 November 2026, each at its recommended option): Q196 A
-- (doses against an order only: no verbal or ward-stock dose without an order),
-- Q197 A (set times, "as needed", STAT, once only and infusion rates, before the
-- medicine round), Q198 A (a dose before the pharmacy dispenses is allowed, with
-- the pharmacy state shown beside it), and the section's smaller choices
-- Q-NUR-9 A (a set-time dose is due from 60 minutes before to 60 minutes after
-- its time, then late; recorded up to 12 hours after, "recorded late" when more
-- than 60 minutes after), Q-NUR-10 A (an "as needed" dose inside the minimum gap
-- or past the most doses in 24 hours is allowed with a reason, never blocked),
-- Q-NUR-11 A (before dispensing the nurse says where the medicine came from) and
-- Q-NUR-12 A (a dose different from the order is allowed with a reason).
--
-- What it changes (nothing else):
-- M1 ehr.prescriptions gains nine nullable columns, set at creation only:
--    schedule_kind (regular, as_needed, stat, once), scheduled_times (text[] of
--    "HH:MM" Lagos, 1-12, distinct and sorted), first_due_at, as_needed_reason
--    (1-200), as_needed_min_interval_minutes (15-1440),
--    as_needed_max_doses_per_24h (1-24), infusion_rate_ml_per_hour
--    numeric(6,1) (0.1-2000), infusion_volume_ml (1-5000), infusion_fluid
--    (0-120). prescriptions_inpatient_schedule_ck holds each kind's shape.
-- M2 The trigger prescriptions_inpatient_schedule_guard (BEFORE INSERT OR
--    UPDATE; SECURITY DEFINER, so it reads ehr.admissions as its owner): a
--    schedule only on a visit that is an open admission's inpatient visit
--    (INPATIENT_SCHEDULE_NOT_ALLOWED), its times distinct and sorted
--    (INPATIENT_SCHEDULE_INVALID), first_due_at "now" when left out, a STAT
--    order's priority "stat"; the schedule columns never change after creation
--    (INPATIENT_SCHEDULE_IMMUTABLE). A BEFORE trigger: 0148's
--    prescriptions_pharmacy_change_after_dispensing stays the last AFTER UPDATE
--    trigger (the post-check confirms it).
-- M3 The owner-only policy prescriptions_mar_owner_read (as 0171's): the
--    function owner reads the active scheduled orders of the one inpatient
--    visit the transaction-local marker hid.mar_encounter names, so the ward
--    round and the handover can count due doses for a patient whose chart the
--    member cannot read. Only counts leave the functions for such a patient,
--    never a medicine name or dose. No runtime role is a member of the owner.
-- M4 ehr.medication_administrations: one row per dose recorded against an
--    order (admission, visit, patient, facility, prescription; scheduled_for;
--    outcome given, held, refused, omitted or not_available; given_at;
--    recorded_at; dose, route; the reasons; supply_source; the pharmacy state
--    at the time; the "as needed" override reason; the infusion action; late
--    and recorded-late marks and the warnings; status recorded or
--    entered_in_error with its reason, time and member; who recorded it; the
--    Idempotency-Key with the request's SHA-256; row_version). CHECKs: dose and
--    route exactly for given; a reason code from the outcome's list for every
--    other outcome; supply_source only for given. Unique (prescription,
--    scheduled_for) while recorded: one record per scheduled dose under any
--    race. A trigger refuses any change but the one-way move to
--    entered_in_error, and any delete.
-- M5 ehr.nursing_requests: the Idempotency-Key of every NUR-1 write (0176's
--    too) with the request's SHA-256, what it wrote and the resource. Append
--    only.
-- M6 Functions (SECURITY DEFINER, search_path pg_catalog, pg_temp, owned like
--    0135's, EXECUTE for hid_ehr_runtime only): ehr.mar_read (route 4),
--    ehr.mar_ward_round (route 5), ehr.mar_record (route 6),
--    ehr.mar_entered_in_error (route 7). Helpers no role may execute:
--    ehr.mar_due_doses (the due doses in Lagos time, worked out on each read,
--    never stored), ehr.mar_pharmacy_state (ORD-4's and Q132 A's state, read
--    through 0133, 0144 and 0148's tables as the owner under their policies),
--    ehr.mar_administration_json, ehr.mar_order_json, ehr.nursing_key,
--    ehr.nursing_key_record and the two triggers' functions.
--    ehr.mar_record locks the admission and then the prescription FOR SHARE, so
--    an order stopped at the same moment either wins (the dose is refused as
--    not active) or sees the dose.
-- M7 Audit, in the request's transaction: ehr.mar.read, ehr.mar.ward-round
--    (one collection row with the patient ids shown, and one
--    ehr.mar.ward-round.shown row per patient), ehr.mar.record (outcome, reason
--    code, pharmacy state, supply source, and whether late, recorded late, dose
--    differs or an override was given), ehr.mar.entered-in-error. Never a
--    medicine name, dose, value or reason text. This file writes no audit row:
--    it changes no existing row.
--
-- Locks (measured with pg_locks before commit and compared by the migrations
-- suite), taken first, NOWAIT: ACCESS EXCLUSIVE on ehr.prescriptions (the
-- column adds, the CHECK, the trigger and the policy; one validating scan);
-- SHARE ROW EXCLUSIVE on ehr.admissions, ehr.encounters, identity.facilities
-- and identity.staff_facility_memberships (the foreign keys of the new, empty
-- tables); ROW EXCLUSIVE on audit.events; ACCESS SHARE on ehr.wards,
-- ehr.order_routes, pharmacy.work_items, pharmacy.work_item_acceptances,
-- pharmacy.dispensings, pharmacy.dispensing_reversals,
-- pharmacy.own_prescription_sends and pharmacy.prescription_item_claims
-- (named by the bodies). A busy table fails the attempt at once, and its
-- subtransaction releases what it took. The attempt is made 50 times, 100 ms
-- apart (about 5 seconds); then 55P03 (nothing applied). When this transaction
-- already holds an earlier migration's locks that stop other sessions' reads
-- or writes, one attempt and no sleep: 55P03 at once, nothing applied. Both
-- refusals begin "0175: " and end "run the release again at a quieter time"
-- (#306).
--
-- Old images on this schema: today's ehr-api and pharmacy-api never set the
-- schedule columns, so the prescriptions they write are outpatient ones as
-- today; the guard lets every such write through unchanged.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- functions, the policy, the trigger and the two tables, then the CHECK and
-- the nine columns once no prescription has a schedule.
--
-- The whole file is one statement (do $nur0175$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0125, 0144, 0148 and 0174
--    applied; "0175: already applied" when every object of this file is there;
--    "0175: the schema is not in the reviewed state" for any half state; the
--    bodies it calls md5-pinned; the AFTER UPDATE triggers as 0148 left them.
-- 2. M1-M6.
-- 3. Post-checks: the columns and CHECK (validated), the trigger, 0148's
--    trigger last, the policies (the old ones unchanged, one new), the tables'
--    row-level security and privileges, the functions' security and grants, no
--    audit row written.

do $nur0175$
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
  v_policies text;
  v_after_triggers text;
begin
  -- Before the locks (catalog reads only): the files whose tables step 0 locks.
  if to_regclass('ehr.admissions') is null or to_regclass('pharmacy.work_item_acceptances') is null
     or to_regclass('pharmacy.prescription_changes_after_dispensing') is null then
    raise exception using errcode = '55000', message = '0175: 0144, 0148 and 0171 must be applied first';
  end if;

  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table ehr.prescriptions in access exclusive mode nowait;
  lock table ehr.admissions, ehr.encounters, identity.facilities, identity.staff_facility_memberships
    in share row exclusive mode nowait;
  lock table audit.events in row exclusive mode nowait;
  lock table ehr.wards, ehr.order_routes, pharmacy.work_items, pharmacy.work_item_acceptances, pharmacy.dispensings,
    pharmacy.dispensing_reversals, pharmacy.own_prescription_sends, pharmacy.prescription_item_claims
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0175: ehr.prescriptions, the admissions, visits, facilities or staff memberships, audit.events '
          || 'or a pharmacy table 0175 reads is busy, and this transaction already holds an earlier migration''s '
          || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0175: ehr.prescriptions, the admissions, visits, facilities or staff memberships, audit.events '
          || 'or a pharmacy table 0175 reads stayed busy for 5 seconds; nothing applied; run the release again at a '
          || 'quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if not exists (select 1 from pg_attribute where attrelid = 'ehr.prescriptions'::regclass
                  and attname = 'quantity_to_dispense' and not attisdropped)
     or to_regprocedure('ehr.observation_chart(uuid, timestamptz, timestamptz, boolean)') is null
     or to_regprocedure('ehr.nursing_caller(text, text[])') is null then
    raise exception using errcode = '55000', message = '0175: 0125 and 0174 must be applied first';
  end if;
  select count(*) into v_present
    from (values
      ((select attribute_row.attrelid::oid from pg_attribute attribute_row
         where attribute_row.attrelid = 'ehr.prescriptions'::regclass and attribute_row.attname = 'schedule_kind'
           and not attribute_row.attisdropped)),
      (to_regclass('ehr.medication_administrations')::oid), (to_regclass('ehr.nursing_requests')::oid),
      ((select trigger_row.oid from pg_trigger trigger_row
         where trigger_row.tgrelid = 'ehr.prescriptions'::regclass
           and trigger_row.tgname = 'prescriptions_inpatient_schedule_guard')),
      ((select policy_row.oid from pg_policy policy_row
         where policy_row.polrelid = 'ehr.prescriptions'::regclass
           and policy_row.polname = 'prescriptions_mar_owner_read')),
      (to_regprocedure('ehr.mar_record(uuid, uuid, timestamptz, text, timestamptz, numeric, text, text, text, text, text, text, text, text, text, text)')::oid))
         present(object_id)
   where present.object_id is not null;
  if v_present = 6 then
    raise exception using errcode = '55000', message = '0175: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_attribute attribute_row
                 where attribute_row.attrelid = 'ehr.prescriptions'::regclass and not attribute_row.attisdropped
                   and attribute_row.attname in ('schedule_kind', 'scheduled_times', 'first_due_at',
                     'as_needed_reason', 'as_needed_min_interval_minutes', 'as_needed_max_doses_per_24h',
                     'infusion_rate_ml_per_hour', 'infusion_volume_ml', 'infusion_fluid'))
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'mar\_%' or proc.proname like 'nursing\_key%'
                        or proc.proname in ('prescriptions_inpatient_schedule_guard',
                                            'medication_administrations_guard', 'nursing_requests_immutable'))) then
    raise exception using errcode = '55000',
      message = '0175: the schema is not in the reviewed state (part of 0175 is there); nothing applied';
  end if;
  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('ehr.inpatient_audit(uuid,text,text,text,text,jsonb)', '81c360af02e3cd2ddb8f3a4fb3041dd2'),
      ('ehr.admission_cards(uuid[],boolean)', '15a3e73ce20f39c5c941237c468aeb68'),
      ('ehr.nursing_caller(text,text[])', 'afe0851769a0403fff7f0df4adbfbf6e'),
      ('pharmacy.prescription_change_after_dispensing()', null)
    ) expected(signature, body_md5)
   where expected.body_md5 is not null
     and (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0175: these bodies are not as 0001-0174 left them: ' || v_mismatch;
  end if;
  -- The AFTER UPDATE triggers in firing order (C collation), 0148's last.
  select string_agg(trigger_row.tgname, ',' order by trigger_row.tgname collate "C") into v_after_triggers
    from pg_trigger trigger_row
   where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and not trigger_row.tgisinternal
     and trigger_row.tgtype & 1 <> 0 and trigger_row.tgtype & 16 <> 0 and trigger_row.tgtype & 2 = 0
     and trigger_row.tgtype & 64 = 0;
  if v_after_triggers is distinct from
       'prescriptions_order_routes_sync,prescriptions_own_pharmacy_send_withdrawn,prescriptions_pharmacy_change_after_dispensing' then
    raise exception using errcode = '55000',
      message = '0175: ehr.prescriptions'' AFTER UPDATE triggers are not as 0148 left them; nothing applied';
  end if;
  select string_agg(policy_row.polname || ':' || policy_row.polcmd::text || ':' || policy_row.polpermissive::text
                    || ':' || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '') || ':'
                    || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), ''),
                    ' | ' order by policy_row.polname)
    into v_policies
    from pg_policy policy_row where policy_row.polrelid = 'ehr.prescriptions'::regclass;
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  select count(*) into v_audit_rows from audit.events;

  -- M1. The schedule columns (nullable, no default: no row is touched) and their shape.
  alter table ehr.prescriptions
    add column schedule_kind text check (schedule_kind is null or schedule_kind in ('regular', 'as_needed', 'stat', 'once')),
    add column scheduled_times text[],
    add column first_due_at timestamptz,
    add column as_needed_reason text,
    add column as_needed_min_interval_minutes integer,
    add column as_needed_max_doses_per_24h integer,
    add column infusion_rate_ml_per_hour numeric(6,1),
    add column infusion_volume_ml integer,
    add column infusion_fluid text;
  alter table ehr.prescriptions add constraint prescriptions_inpatient_schedule_ck check (
    (schedule_kind is not null
     or (scheduled_times is null and first_due_at is null and as_needed_reason is null
         and as_needed_min_interval_minutes is null and as_needed_max_doses_per_24h is null
         and infusion_rate_ml_per_hour is null and infusion_volume_ml is null and infusion_fluid is null))
    and (schedule_kind is null or first_due_at is not null)
    and ((schedule_kind = 'regular') = (scheduled_times is not null))
    and (scheduled_times is null
         or (array_length(scheduled_times, 1) between 1 and 12 and array_ndims(scheduled_times) = 1
             and array_to_string(scheduled_times, ',')
                 ~ '^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$'))
    and ((schedule_kind = 'as_needed') = (as_needed_reason is not null))
    and ((schedule_kind = 'as_needed') = (as_needed_min_interval_minutes is not null))
    and ((schedule_kind = 'as_needed') = (as_needed_max_doses_per_24h is not null))
    and (as_needed_reason is null or (as_needed_reason = btrim(as_needed_reason)
         and length(as_needed_reason) between 1 and 200 and as_needed_reason !~ '[[:cntrl:]]'))
    and (as_needed_min_interval_minutes is null or as_needed_min_interval_minutes between 15 and 1440)
    and (as_needed_max_doses_per_24h is null or as_needed_max_doses_per_24h between 1 and 24)
    and ((infusion_rate_ml_per_hour is null) = (infusion_volume_ml is null))
    and (infusion_fluid is null or infusion_rate_ml_per_hour is not null)
    and (infusion_rate_ml_per_hour is null or (schedule_kind in ('regular', 'stat', 'once')
         and infusion_rate_ml_per_hour between 0.1 and 2000))
    and (infusion_volume_ml is null or infusion_volume_ml between 1 and 5000)
    and (infusion_fluid is null or (length(infusion_fluid) <= 120 and infusion_fluid !~ '[[:cntrl:]]'))) not valid;
  alter table ehr.prescriptions validate constraint prescriptions_inpatient_schedule_ck;
  comment on column ehr.prescriptions.schedule_kind is
    '0175 (NUR-1, Q197 A): an inpatient order''s schedule (regular set times, as_needed, stat, once), set at creation only and only on an open admission''s inpatient visit; null for an outpatient prescription.';

  -- M2. The guard.
  create function ehr.prescriptions_inpatient_schedule_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if tg_op = 'UPDATE' then
      if (new.schedule_kind, new.scheduled_times, new.first_due_at, new.as_needed_reason,
          new.as_needed_min_interval_minutes, new.as_needed_max_doses_per_24h, new.infusion_rate_ml_per_hour,
          new.infusion_volume_ml, new.infusion_fluid)
         is distinct from
         (old.schedule_kind, old.scheduled_times, old.first_due_at, old.as_needed_reason,
          old.as_needed_min_interval_minutes, old.as_needed_max_doses_per_24h, old.infusion_rate_ml_per_hour,
          old.infusion_volume_ml, old.infusion_fluid) then
        raise exception using errcode = '55000', message = 'INPATIENT_SCHEDULE_IMMUTABLE';
      end if;
      return new;
    end if;
    if new.schedule_kind is null then
      return new;
    end if;
    if not exists (select 1 from ehr.admissions admission
                    where admission.encounter_id = new.encounter_id and admission.patient_id = new.patient_id
                      and admission.facility_id = new.facility_id
                      and admission.status in ('requested', 'admitted', 'discharge_ready')) then
      raise exception using errcode = '22023', message = 'INPATIENT_SCHEDULE_NOT_ALLOWED';
    end if;
    if new.scheduled_times is not null
       and (select array_agg(distinct scheduled_time order by scheduled_time) from unnest(new.scheduled_times) scheduled_time)
           is distinct from new.scheduled_times then
      raise exception using errcode = '22023', message = 'INPATIENT_SCHEDULE_INVALID';
    end if;
    new.first_due_at := coalesce(new.first_due_at, clock_timestamp());
    if new.schedule_kind = 'stat' then
      new.priority := 'stat';
    end if;
    return new;
  end
  $fn$;
  revoke all on function ehr.prescriptions_inpatient_schedule_guard() from public;
  create trigger prescriptions_inpatient_schedule_guard
    before insert or update on ehr.prescriptions
    for each row execute function ehr.prescriptions_inpatient_schedule_guard();

  -- M3. The owner-only policy for due-dose counts.
  create policy prescriptions_mar_owner_read on ehr.prescriptions
    for select
    using (pg_has_role((select relation.relowner from pg_class relation
                         where relation.oid = 'ehr.prescriptions'::regclass), 'USAGE')
           and schedule_kind in ('regular', 'stat', 'once') and status = 'active'
           and encounter_id::text = current_setting('hid.mar_encounter', true));

  -- M5. The keys of NUR-1's writes.
  create table ehr.nursing_requests (
    by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    kind text not null check (kind in ('mar_record', 'mar_entered_in_error', 'task_create', 'task_start',
      'task_complete', 'task_cancel', 'task_update', 'fluid_record', 'fluid_entered_in_error', 'shift_create',
      'shift_update', 'assignments_set', 'handover_note', 'handover_give', 'handover_accept')),
    resource_id uuid not null,
    at timestamptz not null default clock_timestamp(),
    primary key (by_membership_id, idempotency_key)
  );
  alter table ehr.nursing_requests enable row level security;
  revoke all on ehr.nursing_requests from public;
  comment on table ehr.nursing_requests is
    '0175 (NUR-1): the Idempotency-Key of every nursing write with the request''s SHA-256, its kind and resource. Append only.';
  create function ehr.nursing_requests_immutable()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    raise exception using errcode = '55000', message = 'NURSING_HISTORY_IMMUTABLE';
  end
  $fn$;
  revoke all on function ehr.nursing_requests_immutable() from public;
  create trigger nursing_requests_immutable
    before update or delete on ehr.nursing_requests
    for each row execute function ehr.nursing_requests_immutable();

  -- M4. The medicine administration record.
  create table ehr.medication_administrations (
    id uuid primary key default gen_random_uuid(),
    admission_id uuid not null references ehr.admissions(id) on delete restrict,
    encounter_id uuid not null,
    patient_id uuid not null,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    prescription_id uuid not null,
    scheduled_for timestamptz,
    outcome text not null check (outcome in ('given', 'held', 'refused', 'omitted', 'not_available')),
    given_at timestamptz not null,
    recorded_at timestamptz not null default clock_timestamp(),
    dose_quantity numeric(12,4) check (dose_quantity is null or dose_quantity > 0),
    dose_unit text check (dose_unit is null or (length(btrim(dose_unit)) between 1 and 80)),
    route text check (route is null or (length(btrim(route)) between 1 and 100)),
    dose_differs_reason text check (dose_differs_reason is null
      or (dose_differs_reason = btrim(dose_differs_reason) and length(dose_differs_reason) between 8 and 300)),
    reason_code text,
    reason_text text check (reason_text is null or (reason_text = btrim(reason_text) and length(reason_text) between 1 and 300)),
    supply_source text check (supply_source is null or supply_source in ('ward_stock', 'patient_own', 'bought_outside')),
    pharmacy_state_at_record text not null check (pharmacy_state_at_record in ('not_sent', 'sent', 'accepted',
      'dispensed', 'part_dispensed', 'not_dispensable', 'reversed')),
    override_reason text check (override_reason is null
      or (override_reason = btrim(override_reason) and length(override_reason) between 8 and 300)),
    infusion_action text check (infusion_action is null or infusion_action in ('started', 'stopped')),
    late boolean not null default false,
    recorded_late boolean not null default false,
    warnings text[] not null default '{}'::text[],
    status text not null default 'recorded' check (status in ('recorded', 'entered_in_error')),
    entered_in_error_reason text check (entered_in_error_reason is null
      or (length(btrim(entered_in_error_reason)) between 8 and 500)),
    entered_in_error_at timestamptz,
    entered_in_error_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    recorded_by_account_id uuid not null,
    recorded_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    row_version bigint not null default 1 check (row_version > 0),
    constraint medication_administrations_encounter_fk foreign key (encounter_id, patient_id, facility_id)
      references ehr.encounters(id, patient_id, facility_id) on delete restrict,
    constraint medication_administrations_prescription_fk foreign key (prescription_id, patient_id, facility_id)
      references ehr.prescriptions(id, patient_id, facility_id) on delete restrict,
    -- Dose and route exactly for given; supply source only for given.
    constraint medication_administrations_given_ck check (
      (outcome = 'given') = (dose_quantity is not null)
      and (dose_quantity is null) = (dose_unit is null)
      and (outcome = 'given') = (route is not null)
      and (outcome = 'given' or (supply_source is null and dose_differs_reason is null and override_reason is null
                                 and infusion_action is null))),
    -- A reason code from the outcome's list for every other outcome.
    constraint medication_administrations_reason_ck check (
      (outcome = 'given' and reason_code is null)
      or (outcome = 'held' and reason_code in ('clinical_decision', 'awaiting_result', 'nil_by_mouth'))
      or (outcome = 'omitted' and reason_code in ('patient_away', 'no_access', 'nil_by_mouth', 'other'))
      or (outcome = 'not_available' and reason_code in ('not_in_stock', 'awaiting_pharmacy', 'patient_to_buy'))
      or (outcome = 'refused' and reason_code = 'patient_refused')),
    constraint medication_administrations_reason_text_ck check (
      reason_code is null or reason_code not in ('clinical_decision', 'other')
      or (reason_text is not null and length(reason_text) >= 8)),
    constraint medication_administrations_status_ck check (
      (status = 'entered_in_error') = (entered_in_error_at is not null)
      and (status = 'entered_in_error') = (entered_in_error_reason is not null)
      and (status = 'entered_in_error') = (entered_in_error_by_membership_id is not null)),
    constraint medication_administrations_key_ux unique (recorded_by_membership_id, idempotency_key)
  );
  create unique index medication_administrations_dose_ux on ehr.medication_administrations (prescription_id, scheduled_for)
    where status = 'recorded' and scheduled_for is not null;
  create index medication_administrations_admission_idx on ehr.medication_administrations (admission_id, given_at);
  create index medication_administrations_prescription_idx on ehr.medication_administrations (prescription_id, given_at);
  alter table ehr.medication_administrations enable row level security;
  revoke all on ehr.medication_administrations from public;
  comment on table ehr.medication_administrations is
    '0175 (NUR-1, Q196 A, Q198 A): one dose recorded against an order of a stay. Never edited or deleted; a mistake is marked entered in error (one way) and the scheduled dose is due again. Part of the record. Only the medicine round functions read and write it, as its owner.';

  create function ehr.medication_administrations_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    if tg_op = 'DELETE' then
      raise exception using errcode = '55000', message = 'NURSING_HISTORY_IMMUTABLE';
    end if;
    if old.status <> 'recorded' or new.status <> 'entered_in_error'
       or new.row_version <> old.row_version + 1
       or (new.id, new.admission_id, new.encounter_id, new.patient_id, new.facility_id, new.prescription_id,
           new.scheduled_for, new.outcome, new.given_at, new.recorded_at, new.dose_quantity, new.dose_unit, new.route,
           new.dose_differs_reason, new.reason_code, new.reason_text, new.supply_source, new.pharmacy_state_at_record,
           new.override_reason, new.infusion_action, new.late, new.recorded_late, new.warnings,
           new.recorded_by_account_id, new.recorded_by_membership_id, new.idempotency_key, new.request_sha256)
          is distinct from
          (old.id, old.admission_id, old.encounter_id, old.patient_id, old.facility_id, old.prescription_id,
           old.scheduled_for, old.outcome, old.given_at, old.recorded_at, old.dose_quantity, old.dose_unit, old.route,
           old.dose_differs_reason, old.reason_code, old.reason_text, old.supply_source, old.pharmacy_state_at_record,
           old.override_reason, old.infusion_action, old.late, old.recorded_late, old.warnings,
           old.recorded_by_account_id, old.recorded_by_membership_id, old.idempotency_key, old.request_sha256) then
      raise exception using errcode = '55000', message = 'NURSING_HISTORY_IMMUTABLE';
    end if;
    return new;
  end
  $fn$;
  revoke all on function ehr.medication_administrations_guard() from public;
  create trigger medication_administrations_guard
    before update or delete on ehr.medication_administrations
    for each row execute function ehr.medication_administrations_guard();

  -- M6. Helpers (no role may execute them; the functions below run them as their owner).

  -- The Idempotency-Key of a nursing write: 'new', 'replay' (the same key and body: the kind and resource) or
  -- 'reused'. Under the same advisory lock as ADT-1's keys, and a key used for a ward or admission write is reused.
  create function ehr.nursing_key(a_membership uuid, a_key text, a_sha text)
  returns table (state text, kind text, resource_id uuid)
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    found_request ehr.nursing_requests%rowtype;
  begin
    if a_key is null or a_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or a_sha is null or a_sha !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'NURSING_IDEMPOTENCY_KEY_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('inpatient-key:' || a_membership::text || ':' || a_key, 0));
    select request_row.* into found_request from ehr.nursing_requests request_row
     where request_row.by_membership_id = a_membership and request_row.idempotency_key = a_key;
    if not found then
      if exists (select 1 from ehr.ward_events event
                  where event.by_membership_id = a_membership and event.idempotency_key = a_key)
         or exists (select 1 from ehr.admission_movements movement
                     where movement.by_membership_id = a_membership and movement.idempotency_key = a_key) then
        state := 'reused';
      else
        state := 'new';
      end if;
    elsif found_request.request_sha256 = a_sha then
      state := 'replay';
      kind := found_request.kind;
      resource_id := found_request.resource_id;
    else
      state := 'reused';
    end if;
    return next;
  end
  $fn$;
  revoke all on function ehr.nursing_key(uuid, text, text) from public;

  create function ehr.nursing_key_record(a_membership uuid, a_facility uuid, a_key text, a_sha text, a_kind text,
    a_resource uuid)
  returns void
  language sql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
    insert into ehr.nursing_requests (by_membership_id, idempotency_key, request_sha256, facility_id, kind, resource_id)
    values (a_membership, a_key, a_sha, a_facility, a_kind, a_resource)
  $fn$;
  revoke all on function ehr.nursing_key_record(uuid, uuid, text, text, text, uuid) from public;

  -- The pharmacy state of a prescription (ORD-4, Q132 A), read as the owner under the pharmacy tables' policies:
  -- the caller's chart access decides what is found, so it is called only for a chart the member can read.
  create function ehr.mar_pharmacy_state(requested_prescription uuid)
  returns text
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    item_id uuid;
    dispensing_row pharmacy.dispensings%rowtype;
    ordered_quantity numeric;
    ordered_unit text;
  begin
    select item.id into item_id from pharmacy.work_items item
     where item.source_ehr_prescription_id = requested_prescription and item.order_route_id is null;
    if item_id is null then
      if exists (select 1 from ehr.order_routes route
                  where route.source_prescription_id = requested_prescription and route.declined_at is null
                    and route.ended_at is null) then
        return 'sent';
      end if;
      return 'not_sent';
    end if;
    select dispensing.* into dispensing_row from pharmacy.dispensings dispensing where dispensing.work_item_id = item_id;
    if found then
      if exists (select 1 from pharmacy.dispensing_reversals reversal where reversal.dispensing_id = dispensing_row.id) then
        return 'reversed';
      end if;
      select prescription.quantity_to_dispense, prescription.quantity_unit into ordered_quantity, ordered_unit
        from ehr.prescriptions prescription where prescription.id = requested_prescription;
      if ordered_quantity is not null and lower(btrim(ordered_unit)) = lower(btrim(dispensing_row.quantity_unit))
         and dispensing_row.quantity_dispensed < ordered_quantity then
        return 'part_dispensed';
      end if;
      return 'dispensed';
    end if;
    if exists (select 1 from pharmacy.prescription_item_claims claim
                where claim.work_item_id = item_id and claim.released_at is not null)
       or exists (select 1 from pharmacy.own_prescription_sends send
                   where send.work_item_id = item_id and send.withdrawn_at is not null) then
      return 'not_dispensable';
    end if;
    if exists (select 1 from pharmacy.work_item_acceptances acceptance where acceptance.work_item_id = item_id) then
      return 'accepted';
    end if;
    return 'sent';
  end
  $fn$;
  revoke all on function ehr.mar_pharmacy_state(uuid) from public;

  -- The due doses of a stay's active scheduled orders in [from, to), in Lagos time (Q-NUR-9 A): upcoming until 60
  -- minutes before the time, due until 60 minutes after, then late; a recorded dose has its outcome. The orders are
  -- read through prescriptions_mar_owner_read (the marker names this one visit), so the counts work whatever the
  -- member's chart access; callers show names and doses only where the member can read the chart.
  create function ehr.mar_due_doses(requested_admission uuid, requested_from timestamptz, requested_to timestamptz)
  returns table (prescription_id uuid, scheduled_for timestamptz, state text, administration_id uuid)
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    admission_row ehr.admissions%rowtype;
    now_value timestamptz := clock_timestamp();
    previous_marker text := current_setting('hid.mar_encounter', true);
  begin
    select admission.* into admission_row from ehr.admissions admission where admission.id = requested_admission;
    if not found or requested_from is null or requested_to is null or requested_to <= requested_from then
      return;
    end if;
    perform set_config('hid.mar_encounter', admission_row.encounter_id::text, true);
    return query
      with orders as materialized (
        select prescription.id, prescription.schedule_kind, prescription.scheduled_times, prescription.first_due_at,
               prescription.starts_on, prescription.ends_on
          from ehr.prescriptions prescription
         where prescription.encounter_id = admission_row.encounter_id
           and prescription.patient_id = admission_row.patient_id
           and prescription.facility_id = admission_row.facility_id
           and prescription.status = 'active' and prescription.schedule_kind in ('regular', 'stat', 'once')),
      doses as (
        select orders.id as prescription_id, slot.at as scheduled_for
          from orders
          cross join lateral (
            select ((day_value::date + scheduled_time::time) at time zone 'Africa/Lagos') as at
              from generate_series(((greatest(requested_from, orders.first_due_at) at time zone 'Africa/Lagos')::date - 1),
                                   ((requested_to at time zone 'Africa/Lagos')::date + 1), interval '1 day') day_series(day_value),
                   unnest(orders.scheduled_times) scheduled_time
             where orders.schedule_kind = 'regular'
            union all
            select orders.first_due_at where orders.schedule_kind in ('stat', 'once')) slot
         where slot.at >= orders.first_due_at and slot.at >= requested_from and slot.at < requested_to
           and (orders.starts_on is null or (slot.at at time zone 'Africa/Lagos')::date >= orders.starts_on)
           and (orders.ends_on is null or (slot.at at time zone 'Africa/Lagos')::date <= orders.ends_on))
      select doses.prescription_id, doses.scheduled_for,
             case when administration.id is not null then administration.outcome
                  when now_value < doses.scheduled_for - interval '60 minutes' then 'upcoming'
                  when now_value <= doses.scheduled_for + interval '60 minutes' then 'due'
                  else 'late' end,
             administration.id
        from doses
        left join ehr.medication_administrations administration
          on administration.prescription_id = doses.prescription_id
         and administration.scheduled_for = doses.scheduled_for and administration.status = 'recorded'
       order by doses.scheduled_for, doses.prescription_id;
    perform set_config('hid.mar_encounter', coalesce(previous_marker, ''), true);
  end
  $fn$;
  revoke all on function ehr.mar_due_doses(uuid, timestamptz, timestamptz) from public;

  -- One recorded dose as the routes answer it (chart content: only for a chart the member can read).
  create function ehr.mar_administration_json(requested_administration uuid)
  returns jsonb
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select jsonb_build_object('administrationId', administration.id, 'admissionId', administration.admission_id,
      'prescriptionId', administration.prescription_id, 'scheduledFor', administration.scheduled_for,
      'outcome', administration.outcome, 'givenAt', administration.given_at, 'recordedAt', administration.recorded_at,
      'recordedLate', administration.recorded_late, 'late', administration.late,
      'dose', case when administration.dose_quantity is null then null
                   else jsonb_build_object('quantity', administration.dose_quantity, 'unit', administration.dose_unit) end,
      'doseDiffersReason', administration.dose_differs_reason, 'route', administration.route,
      'reasonCode', administration.reason_code, 'reasonText', administration.reason_text,
      'supplySource', administration.supply_source, 'pharmacyStateAtRecord', administration.pharmacy_state_at_record,
      'overrideReason', administration.override_reason, 'infusionAction', administration.infusion_action,
      'warnings', to_jsonb(administration.warnings),
      'recordedByMembershipId', administration.recorded_by_membership_id, 'status', administration.status,
      'enteredInErrorReason', administration.entered_in_error_reason,
      'enteredInErrorAt', administration.entered_in_error_at,
      'enteredInErrorByMembershipId', administration.entered_in_error_by_membership_id,
      'rowVersion', administration.row_version)
      from ehr.medication_administrations administration where administration.id = requested_administration
  $fn$;
  revoke all on function ehr.mar_administration_json(uuid) from public;

  -- One order of the stay on the medicine round (chart content: only for a chart the member can read).
  create function ehr.mar_order_json(requested_admission uuid, requested_prescription uuid, requested_from timestamptz,
    requested_to timestamptz)
  returns jsonb
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    prescription_row ehr.prescriptions%rowtype;
    last_given timestamptz;
    given_24h integer;
  begin
    select prescription.* into prescription_row from ehr.prescriptions prescription
     where prescription.id = requested_prescription;
    if not found then
      return null;
    end if;
    select max(administration.given_at),
           count(*) filter (where administration.given_at > clock_timestamp() - interval '24 hours')
      into last_given, given_24h
      from ehr.medication_administrations administration
     where administration.prescription_id = prescription_row.id and administration.status = 'recorded'
       and administration.outcome = 'given';
    return jsonb_build_object('prescriptionId', prescription_row.id,
      'medicationDisplay', prescription_row.medication_display, 'strength', prescription_row.medication_strength,
      'doseForm', prescription_row.medication_dose_form,
      'dose', case when prescription_row.dose_quantity is null then null
                   else jsonb_build_object('quantity', prescription_row.dose_quantity, 'unit', prescription_row.dose_unit) end,
      'route', prescription_row.route_code, 'frequency', prescription_row.frequency, 'status', prescription_row.status,
      'schedule', case when prescription_row.schedule_kind is null then null else jsonb_build_object(
        'kind', prescription_row.schedule_kind, 'times', to_jsonb(prescription_row.scheduled_times),
        'firstDueAt', prescription_row.first_due_at,
        'infusion', case when prescription_row.infusion_rate_ml_per_hour is null then null else jsonb_build_object(
          'rateMlPerHour', prescription_row.infusion_rate_ml_per_hour, 'volumeMl', prescription_row.infusion_volume_ml,
          'fluid', prescription_row.infusion_fluid) end) end,
      'pharmacyState', ehr.mar_pharmacy_state(prescription_row.id),
      'doses', coalesce((select jsonb_agg(jsonb_build_object('scheduledFor', due.scheduled_for, 'state', due.state,
                           'administrationId', due.administration_id) order by due.scheduled_for)
                           from ehr.mar_due_doses(requested_admission, requested_from, requested_to) due
                          where due.prescription_id = prescription_row.id), '[]'::jsonb),
      'asNeeded', case when prescription_row.schedule_kind <> 'as_needed' then null else jsonb_build_object(
        'reason', prescription_row.as_needed_reason,
        'minIntervalMinutes', prescription_row.as_needed_min_interval_minutes,
        'maxDosesPer24h', prescription_row.as_needed_max_doses_per_24h, 'givenLast24h', given_24h) end,
      'lastGivenAt', last_given,
      'nextAllowedAt', case when prescription_row.schedule_kind = 'as_needed' and last_given is not null
                            then last_given + make_interval(mins => prescription_row.as_needed_min_interval_minutes) end);
  end
  $fn$;
  revoke all on function ehr.mar_order_json(uuid, uuid, timestamptz, timestamptz) from public;

  -- Route 4: the stay's medicine administration record.
  create function ehr.mar_read(requested_admission uuid, requested_from timestamptz, requested_to timestamptz)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
    orders jsonb;
    administrations jsonb;
  begin
    select * into caller from ehr.nursing_caller('mar_read', array['direct-care']);
    if requested_admission is null or requested_from is null or requested_to is null
       or requested_to <= requested_from or requested_to - requested_from > interval '7 days' then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility;
    if not found then
      perform ehr.inpatient_audit(null, 'ehr.mar.read', 'failure', 'admission', requested_admission::text,
        jsonb_build_object('refusal', 'not_found'));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    if not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'read_records'), false) then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.mar.read', 'denied', 'admission',
        admission_row.id::text, jsonb_build_object('refusal', 'chart_access_required'));
      return jsonb_build_object('outcome', 'chart_access_required');
    end if;
    -- Every order of the stay's visit but drafts (read under the chart's own access).
    select coalesce(jsonb_agg(ehr.mar_order_json(admission_row.id, prescription.id, requested_from, requested_to)
                              order by (prescription.schedule_kind is null), prescription.created_at, prescription.id),
                    '[]'::jsonb)
      into orders
      from ehr.prescriptions prescription
     where prescription.encounter_id = admission_row.encounter_id
       and prescription.patient_id = admission_row.patient_id and prescription.facility_id = admission_row.facility_id
       and prescription.status <> 'draft';
    select coalesce(jsonb_agg(ehr.mar_administration_json(administration.id)
                              order by administration.given_at, administration.id), '[]'::jsonb)
      into administrations
      from ehr.medication_administrations administration
     where administration.admission_id = admission_row.id
       and ((administration.given_at >= requested_from and administration.given_at < requested_to)
            or (administration.scheduled_for >= requested_from and administration.scheduled_for < requested_to));
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.mar.read', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('from', requested_from, 'to', requested_to,
        'orderCount', jsonb_array_length(orders), 'administrationCount', jsonb_array_length(administrations)));
    return jsonb_build_object('outcome', 'found', 'admissionId', admission_row.id, 'from', requested_from,
      'to', requested_to, 'orders', orders, 'administrations', administrations);
  end
  $fn$;
  comment on function ehr.mar_read(uuid, timestamptz, timestamptz) is
    '0175 (NUR-1, Q196 A, Q198 A): the stay''s medicine administration record in the window (up to 7 days): every order of the stay''s visit but drafts (orders with no schedule last, under "No schedule"), each with its pharmacy state, its due doses worked out in Lagos time (upcoming, due, late, or the recorded outcome) and, for "as needed", the last dose and when the next is allowed; and the doses recorded. Needs ehr.mar.read and chart read access. Outcomes found, not_found, chart_access_required. Audited (ehr.mar.read; counts only).';
  revoke all on function ehr.mar_read(uuid, timestamptz, timestamptz) from public;

  -- Route 5: the ward's round.
  create function ehr.mar_ward_round(requested_ward uuid, requested_window text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    ward_row ehr.wards%rowtype;
    now_value timestamptz := clock_timestamp();
    window_end timestamptz;
    items jsonb := '[]'::jsonb;
    stay record;
    chart_shown boolean;
    doses jsonb;
    counts record;
    shown_ids uuid[] := '{}'::uuid[];
  begin
    select * into caller from ehr.nursing_caller('mar_read', array['direct-care']);
    if requested_ward is null or requested_window is null or requested_window not in ('now', 'next_4h') then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select ward.* into ward_row from ehr.wards ward
     where ward.id = requested_ward and ward.facility_id = caller.actor_facility;
    if not found then
      perform ehr.inpatient_audit(null, 'ehr.mar.ward-round', 'failure', 'ward', requested_ward::text,
        jsonb_build_object('refusal', 'ward_not_found'));
      return jsonb_build_object('outcome', 'ward_not_found');
    end if;
    window_end := now_value + case when requested_window = 'now' then interval '60 minutes' else interval '4 hours' end;
    for stay in
      select admission.id, admission.patient_id, card.card, card.name_shown, bed.name as bed_name
        from ehr.admissions admission
        join ehr.beds bed on bed.id = admission.bed_id
        cross join lateral ehr.admission_cards(array[admission.id], false) card
       where admission.ward_id = ward_row.id and admission.facility_id = caller.actor_facility
         and admission.status in ('admitted', 'discharge_ready')
       order by lower(bed.name), admission.id
    loop
      select count(*) filter (where due.state = 'due') as due_count,
             count(*) filter (where due.state = 'late') as late_count,
             count(*) filter (where due.state = 'upcoming') as upcoming_count
        into counts
        from ehr.mar_due_doses(stay.id, now_value - interval '24 hours', window_end) due
       where due.state in ('due', 'late') or (requested_window = 'next_4h' and due.state = 'upcoming');
      if counts.due_count + counts.late_count + counts.upcoming_count = 0 then
        continue;
      end if;
      chart_shown := coalesce(ehr.context_allows(stay.patient_id, caller.actor_facility, 'read_records'), false);
      doses := '[]'::jsonb;
      if chart_shown then
        select coalesce(jsonb_agg(jsonb_build_object('prescriptionId', due.prescription_id,
                 'medicationDisplay', prescription.medication_display, 'strength', prescription.medication_strength,
                 'scheduledFor', due.scheduled_for, 'state', due.state) order by due.scheduled_for, due.prescription_id),
               '[]'::jsonb)
          into doses
          from ehr.mar_due_doses(stay.id, now_value - interval '24 hours', window_end) due
          join ehr.prescriptions prescription on prescription.id = due.prescription_id
         where due.state in ('due', 'late') or (requested_window = 'next_4h' and due.state = 'upcoming');
      end if;
      items := items || jsonb_build_array(jsonb_build_object('admissionId', stay.id, 'patient', stay.card,
        'bedName', stay.bed_name, 'chartShown', chart_shown, 'medicinesHidden', not chart_shown,
        'counts', jsonb_build_object('due', counts.due_count, 'late', counts.late_count,
          'upcoming', counts.upcoming_count),
        'doses', doses));
      shown_ids := shown_ids || stay.patient_id;
      perform ehr.inpatient_audit(stay.patient_id, 'ehr.mar.ward-round.shown', 'success', 'admission', stay.id::text,
        jsonb_build_object('wardId', ward_row.id, 'nameShown', stay.name_shown, 'chartShown', chart_shown));
    end loop;
    perform ehr.inpatient_audit(null, 'ehr.mar.ward-round', 'success', 'ward', ward_row.id::text,
      jsonb_build_object('window', requested_window, 'count', jsonb_array_length(items),
        'patientIds', to_jsonb(shown_ids)));
    return jsonb_build_object('outcome', 'found', 'wardId', ward_row.id, 'wardName', ward_row.name,
      'wardType', ward_row.ward_type, 'window', requested_window, 'at', now_value, 'items', items);
  end
  $fn$;
  comment on function ehr.mar_ward_round(uuid, text) is
    '0175 (NUR-1): the ward''s medicine round: every admitted patient of the ward with doses due or late (and, for next_4h, due in the next 4 hours): the patient card (names under ADT-1''s rule, Q190), the bed, the counts, and the medicine name, time and state of each dose only where the member can read the chart now (otherwise counts only). Needs ehr.mar.read. Outcomes found, ward_not_found. Audited (ehr.mar.ward-round with the patient ids shown, and one .shown row per patient).';
  revoke all on function ehr.mar_ward_round(uuid, text) from public;

  -- Route 6: record a dose (Q196 A, Q198 A, Q-NUR-9 to Q-NUR-12).
  create function ehr.mar_record(requested_admission uuid, requested_prescription uuid,
    requested_scheduled_for timestamptz, requested_outcome text, requested_given_at timestamptz,
    requested_dose_quantity numeric, requested_dose_unit text, requested_route text,
    requested_dose_differs_reason text, requested_reason_code text, requested_reason_text text,
    requested_supply_source text, requested_override_reason text, requested_infusion_action text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    admission_row ehr.admissions%rowtype;
    prescription_row ehr.prescriptions%rowtype;
    now_value timestamptz := clock_timestamp();
    differs_reason text := nullif(btrim(coalesce(requested_dose_differs_reason, '')), '');
    reason_text_value text := nullif(btrim(coalesce(requested_reason_text, '')), '');
    override_value text := nullif(btrim(coalesce(requested_override_reason, '')), '');
    unit_value text := nullif(btrim(coalesce(requested_dose_unit, '')), '');
    route_value text := nullif(btrim(coalesce(requested_route, '')), '');
    pharmacy_state text;
    refusal text;
    existing_id uuid;
    inside_gap boolean := false;
    over_max boolean := false;
    dose_differs boolean := false;
    late_value boolean := false;
    warnings_value text[] := '{}'::text[];
    new_id uuid;
  begin
    select * into caller from ehr.nursing_caller('mar_record', array['direct-care']);
    if requested_admission is null or requested_prescription is null or requested_outcome is null
       or requested_outcome not in ('given', 'held', 'refused', 'omitted', 'not_available')
       or (requested_supply_source is not null
           and requested_supply_source not in ('ward_stock', 'patient_own', 'bought_outside'))
       or (requested_infusion_action is not null and requested_infusion_action not in ('started', 'stopped'))
       or (reason_text_value is not null and (length(reason_text_value) > 300 or reason_text_value ~ '[[:cntrl:]]'))
       or (requested_outcome = 'given' and (requested_dose_quantity is null or requested_dose_quantity <= 0
           or unit_value is null or length(unit_value) > 80 or route_value is null or length(route_value) > 100))
       or (requested_outcome <> 'given' and (requested_dose_quantity is not null or unit_value is not null
           or route_value is not null or requested_supply_source is not null or differs_reason is not null
           or override_value is not null or requested_infusion_action is not null)) then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    if requested_outcome = 'given' and requested_reason_code is not null then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    if requested_outcome <> 'given' and (requested_reason_code is null
       or not ((requested_outcome = 'held' and requested_reason_code in ('clinical_decision', 'awaiting_result', 'nil_by_mouth'))
            or (requested_outcome = 'omitted' and requested_reason_code in ('patient_away', 'no_access', 'nil_by_mouth', 'other'))
            or (requested_outcome = 'not_available' and requested_reason_code in ('not_in_stock', 'awaiting_pharmacy', 'patient_to_buy'))
            or (requested_outcome = 'refused' and requested_reason_code = 'patient_refused'))
       or (requested_reason_code in ('clinical_decision', 'other') and coalesce(length(reason_text_value), 0) < 8)) then
      raise exception using errcode = '22023', message = 'DOSE_REASON_REQUIRED';
    end if;
    if (differs_reason is not null and length(differs_reason) not between 8 and 300)
       or (override_value is not null and length(override_value) not between 8 and 300) then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    if requested_given_at is null or requested_given_at > now_value + interval '2 minutes'
       or requested_given_at < now_value - interval '12 hours' then
      raise exception using errcode = '22023', message = 'DOSE_TIME_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'mar_record' then
      return jsonb_build_object('outcome', 'created', 'replayed', true,
        'administration', ehr.mar_administration_json(key_state.resource_id),
        'warnings', (select to_jsonb(administration.warnings) from ehr.medication_administrations administration
                      where administration.id = key_state.resource_id));
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
    if refusal is null then
      select prescription.* into prescription_row from ehr.prescriptions prescription
       where prescription.id = requested_prescription and prescription.encounter_id = admission_row.encounter_id
         and prescription.patient_id = admission_row.patient_id and prescription.facility_id = admission_row.facility_id
         for share;
      if not found or prescription_row.status <> 'active' then
        refusal := 'order_not_active';
      elsif prescription_row.schedule_kind in ('regular', 'stat', 'once') then
        if requested_scheduled_for is null
           or requested_scheduled_for > now_value + interval '24 hours'
           or not exists (select 1 from ehr.mar_due_doses(admission_row.id, requested_scheduled_for - interval '1 minute',
                                                          requested_scheduled_for + interval '1 minute') due
                           where due.prescription_id = prescription_row.id
                             and due.scheduled_for = requested_scheduled_for) then
          refusal := 'scheduled_for_invalid';
        end if;
      elsif requested_scheduled_for is not null then
        refusal := 'scheduled_for_invalid';
      end if;
    end if;
    if refusal is null and requested_scheduled_for is not null then
      select administration.id into existing_id from ehr.medication_administrations administration
       where administration.prescription_id = prescription_row.id
         and administration.scheduled_for = requested_scheduled_for and administration.status = 'recorded';
      if existing_id is not null then
        refusal := 'already_recorded';
      end if;
    end if;
    if refusal is null and requested_infusion_action is not null and prescription_row.infusion_rate_ml_per_hour is null then
      refusal := 'infusion_invalid';
    end if;
    if refusal is null then
      pharmacy_state := ehr.mar_pharmacy_state(prescription_row.id);
      if requested_outcome = 'given' then
        dose_differs := prescription_row.dose_quantity is not null
          and (requested_dose_quantity <> prescription_row.dose_quantity
               or lower(unit_value) <> lower(btrim(prescription_row.dose_unit)));
        if dose_differs and differs_reason is null then
          refusal := 'dose_differs_reason_required';
        elsif pharmacy_state not in ('dispensed', 'part_dispensed') and requested_supply_source is null then
          refusal := 'supply_source_required';
        elsif prescription_row.schedule_kind = 'as_needed' then
          inside_gap := exists (select 1 from ehr.medication_administrations administration
                                 where administration.prescription_id = prescription_row.id
                                   and administration.status = 'recorded' and administration.outcome = 'given'
                                   and administration.given_at > requested_given_at
                                     - make_interval(mins => prescription_row.as_needed_min_interval_minutes)
                                   and administration.given_at <= requested_given_at
                                     + make_interval(mins => prescription_row.as_needed_min_interval_minutes));
          over_max := (select count(*) from ehr.medication_administrations administration
                        where administration.prescription_id = prescription_row.id
                          and administration.status = 'recorded' and administration.outcome = 'given'
                          and administration.given_at > requested_given_at - interval '24 hours'
                          and administration.given_at <= requested_given_at)
                      >= prescription_row.as_needed_max_doses_per_24h;
          if (inside_gap or over_max) and override_value is null then
            refusal := 'override_reason_required';
          end if;
        end if;
        if refusal is null and not (inside_gap or over_max) and override_value is not null then
          raise exception using errcode = '22023', message = 'NURSING_INVALID';
        end if;
      end if;
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.mar.record',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal, 'outcome', requested_outcome, 'prescriptionId', requested_prescription));
      return jsonb_build_object('outcome', refusal, 'administrationId', existing_id);
    end if;
    late_value := requested_scheduled_for is not null and requested_given_at > requested_scheduled_for + interval '60 minutes';
    warnings_value := array_remove(array[
      case when late_value then 'late' end,
      case when dose_differs then 'dose_differs' end,
      case when inside_gap then 'as_needed_inside_gap' end,
      case when over_max then 'as_needed_over_max' end,
      case when requested_outcome = 'given' and pharmacy_state not in ('dispensed', 'part_dispensed')
           then 'before_dispensing' end], null);
    begin
      insert into ehr.medication_administrations (admission_id, encounter_id, patient_id, facility_id, prescription_id,
        scheduled_for, outcome, given_at, recorded_at, dose_quantity, dose_unit, route, dose_differs_reason, reason_code,
        reason_text, supply_source, pharmacy_state_at_record, override_reason, infusion_action, late, recorded_late,
        warnings, recorded_by_account_id, recorded_by_membership_id, idempotency_key, request_sha256)
      values (admission_row.id, admission_row.encounter_id, admission_row.patient_id, admission_row.facility_id,
        prescription_row.id, requested_scheduled_for, requested_outcome, least(requested_given_at, now_value), now_value,
        case when requested_outcome = 'given' then requested_dose_quantity end, unit_value, route_value,
        case when dose_differs then differs_reason end, requested_reason_code, reason_text_value,
        requested_supply_source, pharmacy_state, override_value, requested_infusion_action, late_value,
        now_value - requested_given_at > interval '60 minutes', warnings_value, caller.actor_account,
        caller.actor_membership, requested_idempotency_key, requested_request_sha256)
      returning id into new_id;
    exception when unique_violation then
      -- Two sessions recorded the same scheduled dose at once: the first wins.
      select administration.id into existing_id from ehr.medication_administrations administration
       where administration.prescription_id = prescription_row.id
         and administration.scheduled_for = requested_scheduled_for and administration.status = 'recorded';
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.mar.record', 'denied', 'admission',
        admission_row.id::text, jsonb_build_object('refusal', 'already_recorded', 'outcome', requested_outcome,
          'prescriptionId', prescription_row.id));
      return jsonb_build_object('outcome', 'already_recorded', 'administrationId', existing_id);
    end;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, 'mar_record', new_id);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.mar.record', 'success', 'medication-administration',
      new_id::text, jsonb_build_object('admissionId', admission_row.id, 'prescriptionId', prescription_row.id,
        'scheduledFor', requested_scheduled_for, 'outcome', requested_outcome, 'reasonCode', requested_reason_code,
        'pharmacyState', pharmacy_state, 'supplySource', requested_supply_source, 'late', late_value,
        'recordedLate', now_value - requested_given_at > interval '60 minutes', 'doseDiffers', dose_differs,
        'overrideGiven', override_value is not null, 'infusionAction', requested_infusion_action));
    return jsonb_build_object('outcome', 'created', 'replayed', false,
      'administration', ehr.mar_administration_json(new_id), 'warnings', to_jsonb(warnings_value));
  end
  $fn$;
  comment on function ehr.mar_record(uuid, uuid, timestamptz, text, timestamptz, numeric, text, text, text, text, text, text, text, text, text, text) is
    '0175 (NUR-1, Q196 A, Q198 A, Q-NUR-9 A to Q-NUR-12 A): records one dose against an active order of the stay: given (dose and route; a different dose with a reason; before dispensing, where the medicine came from; an "as needed" dose inside the gap or past the most in 24 hours with a reason), held, refused, omitted or not available (a reason code from the outcome''s list, and text for clinical_decision and other). The time up to 12 hours ago; late after 60 minutes past the due time; recorded late when entered more than 60 minutes after. One record per scheduled dose. Warnings never block. Locks the admission and the prescription FOR SHARE. Needs ehr.mar.record and chart write access. Outcomes created (replayed), not_found, admission_not_open, chart_access_required, order_not_active, scheduled_for_invalid, already_recorded, infusion_invalid, dose_differs_reason_required, supply_source_required, override_reason_required, key_reused. Audited (ehr.mar.record; never a medicine name, dose or reason text).';
  revoke all on function ehr.mar_record(uuid, uuid, timestamptz, text, timestamptz, numeric, text, text, text, text, text, text, text, text, text, text) from public;

  -- Route 7: a dose marked entered in error (one way; the scheduled dose is due again).
  create function ehr.mar_entered_in_error(requested_administration uuid, requested_row_version bigint,
    requested_reason text, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    administration_row ehr.medication_administrations%rowtype;
    reason_value text := nullif(btrim(coalesce(requested_reason, '')), '');
    refusal text;
  begin
    select * into caller from ehr.nursing_caller('mar_record', array['direct-care']);
    if requested_administration is null or requested_row_version is null or reason_value is null
       or length(reason_value) not between 8 and 500 or reason_value ~ '[[:cntrl:]]' then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select * into key_state from ehr.nursing_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'mar_entered_in_error'
       and key_state.resource_id = requested_administration then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'administration', ehr.mar_administration_json(requested_administration));
    end if;
    select administration.* into administration_row from ehr.medication_administrations administration
     where administration.id = requested_administration and administration.facility_id = caller.actor_facility
       for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif administration_row.status = 'entered_in_error' then
      refusal := 'already_entered_in_error';
    elsif administration_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif not coalesce(ehr.context_allows(administration_row.patient_id, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(administration_row.patient_id, 'ehr.mar.entered-in-error',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'medication-administration',
        requested_administration::text, jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    update ehr.medication_administrations administration
       set status = 'entered_in_error', entered_in_error_reason = reason_value,
           entered_in_error_at = clock_timestamp(), entered_in_error_by_membership_id = caller.actor_membership,
           row_version = administration.row_version + 1
     where administration.id = administration_row.id;
    perform ehr.nursing_key_record(caller.actor_membership, caller.actor_facility, requested_idempotency_key,
      requested_request_sha256, 'mar_entered_in_error', administration_row.id);
    perform ehr.inpatient_audit(administration_row.patient_id, 'ehr.mar.entered-in-error', 'success',
      'medication-administration', administration_row.id::text,
      jsonb_build_object('admissionId', administration_row.admission_id, 'outcome', administration_row.outcome));
    return jsonb_build_object('outcome', 'updated', 'replayed', false,
      'administration', ehr.mar_administration_json(administration_row.id));
  end
  $fn$;
  comment on function ehr.mar_entered_in_error(uuid, bigint, text, text, text) is
    '0175 (NUR-1): marks a recorded dose entered in error, for good, with a reason of 8-500 characters; the record stays (struck through on screen) and the scheduled dose is due again. Needs ehr.mar.record and chart write access. Outcomes updated (replayed), not_found, already_entered_in_error, changed, chart_access_required, key_reused. Audited (ehr.mar.entered-in-error; never the reason).';
  revoke all on function ehr.mar_entered_in_error(uuid, bigint, text, text, text) from public;

  -- Owners and EXECUTE (as 0135: the owner of identity.has_active_consent_grant).
  if v_owner <> current_user then
    execute format('alter table ehr.medication_administrations owner to %I', v_owner);
    execute format('alter table ehr.nursing_requests owner to %I', v_owner);
    execute (select string_agg(format('alter function %s owner to %I', proc.oid::regprocedure, v_owner), '; ')
               from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'ehr'
                and (proc.proname like 'mar\_%' or proc.proname like 'nursing\_key%'
                     or proc.proname in ('prescriptions_inpatient_schedule_guard', 'medication_administrations_guard',
                                         'nursing_requests_immutable')));
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function
      ehr.mar_read(uuid, timestamptz, timestamptz),
      ehr.mar_ward_round(uuid, text),
      ehr.mar_record(uuid, uuid, timestamptz, text, timestamptz, numeric, text, text, text, text, text, text, text, text, text, text),
      ehr.mar_entered_in_error(uuid, bigint, text, text, text)
      to hid_ehr_runtime;
  end if;

  -- 3. Post-checks.
  if (select count(*) from pg_attribute attribute_row
       where attribute_row.attrelid = 'ehr.prescriptions'::regclass and not attribute_row.attisdropped
         and attribute_row.attname in ('schedule_kind', 'scheduled_times', 'first_due_at', 'as_needed_reason',
           'as_needed_min_interval_minutes', 'as_needed_max_doses_per_24h', 'infusion_rate_ml_per_hour',
           'infusion_volume_ml', 'infusion_fluid')
         and not attribute_row.attnotnull and not attribute_row.atthasdef) <> 9
     or not exists (select 1 from pg_constraint where conrelid = 'ehr.prescriptions'::regclass
                     and conname = 'prescriptions_inpatient_schedule_ck' and convalidated)
     or exists (select 1 from ehr.prescriptions where schedule_kind is not null) then
    raise exception using errcode = '55000', message = '0175: post-check failed (the schedule columns or CHECK)';
  end if;
  if (select count(*) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and trigger_row.tgenabled = 'O'
         and trigger_row.tgname = 'prescriptions_inpatient_schedule_guard'
         and pg_get_triggerdef(trigger_row.oid) = 'CREATE TRIGGER prescriptions_inpatient_schedule_guard BEFORE INSERT '
           || 'OR UPDATE ON ehr.prescriptions FOR EACH ROW EXECUTE FUNCTION ehr.prescriptions_inpatient_schedule_guard()')
       <> 1
     or (select string_agg(trigger_row.tgname, ',' order by trigger_row.tgname collate "C")
           from pg_trigger trigger_row
          where trigger_row.tgrelid = 'ehr.prescriptions'::regclass and not trigger_row.tgisinternal
            and trigger_row.tgtype & 1 <> 0 and trigger_row.tgtype & 16 <> 0 and trigger_row.tgtype & 2 = 0
            and trigger_row.tgtype & 64 = 0) is distinct from v_after_triggers then
    raise exception using errcode = '55000',
      message = '0175: post-check failed (the guard, or 0148''s trigger is no longer the last AFTER UPDATE trigger)';
  end if;
  if (select string_agg(policy_row.polname || ':' || policy_row.polcmd::text || ':' || policy_row.polpermissive::text
                        || ':' || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '') || ':'
                        || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), ''),
                        ' | ' order by policy_row.polname)
        from pg_policy policy_row
       where policy_row.polrelid = 'ehr.prescriptions'::regclass and policy_row.polname <> 'prescriptions_mar_owner_read')
     is distinct from v_policies
     or (select count(*) from pg_policy policy_row
          where policy_row.polrelid = 'ehr.prescriptions'::regclass
            and policy_row.polname = 'prescriptions_mar_owner_read' and policy_row.polcmd = 'r'
            and policy_row.polpermissive and policy_row.polroles = array[0::oid]) <> 1 then
    raise exception using errcode = '55000', message = '0175: post-check failed (the prescriptions policies)';
  end if;
  if exists (select 1 from pg_class class_row,
                    lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid in ('ehr.medication_administrations'::regclass, 'ehr.nursing_requests'::regclass)
                and acl.grantee <> class_row.relowner)
     or (select count(*) from pg_class
          where oid in ('ehr.medication_administrations'::regclass, 'ehr.nursing_requests'::regclass)
            and relrowsecurity) <> 2
     or exists (select 1 from pg_policy where polrelid in ('ehr.medication_administrations'::regclass,
                  'ehr.nursing_requests'::regclass))
     or (select count(*) from pg_trigger trigger_row
          where (trigger_row.tgrelid, trigger_row.tgname) in
                  (('ehr.medication_administrations'::regclass, 'medication_administrations_guard'),
                   ('ehr.nursing_requests'::regclass, 'nursing_requests_immutable'))
            and trigger_row.tgenabled = 'O') <> 2 then
    raise exception using errcode = '55000',
      message = '0175: post-check failed (a new table is granted to a role, has a policy, lacks row-level security or its guard)';
  end if;
  if exists (select 1 from pg_proc proc
               join pg_namespace namespace on namespace.oid = proc.pronamespace,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where namespace.nspname = 'ehr'
                and (proc.proname like 'mar\_%' or proc.proname like 'nursing\_key%'
                     or proc.proname in ('prescriptions_inpatient_schedule_guard', 'medication_administrations_guard',
                                         'nursing_requests_immutable'))
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or proc.proname not in ('mar_read', 'mar_ward_round', 'mar_record', 'mar_entered_in_error')))
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr' and proc.prosecdef
            and proc.proname in ('mar_read', 'mar_ward_round', 'mar_record', 'mar_entered_in_error',
                                 'prescriptions_inpatient_schedule_guard')) <> 5
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'mar\_%' or proc.proname like 'nursing\_key%'
                 or proc.proname in ('prescriptions_inpatient_schedule_guard', 'medication_administrations_guard',
                                     'nursing_requests_immutable'))) <> 13
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'mar\_%' or proc.proname like 'nursing\_key%'
                        or proc.proname in ('prescriptions_inpatient_schedule_guard', 'medication_administrations_guard',
                                            'nursing_requests_immutable'))
                   and proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0175: post-check failed (the functions'' security or grants)';
  end if;
  if (select count(*) from audit.events) <> v_audit_rows then
    raise exception using errcode = '55000', message = '0175: post-check failed (an audit row was written)';
  end if;

  raise notice '0175: inpatient medicine orders and the medicine round are installed (9 prescription columns set at creation only, 2 tables, 13 functions, one owner-only policy). Nobody can use the round until 0177 gives the codes.';
end
$nur0175$;
