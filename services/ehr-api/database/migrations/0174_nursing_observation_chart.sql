-- 0174 NUR-1 Nursing on the ward: the observation chart fields on vitals
-- (Release D, the department sprint the owner approved on 25 November 2026,
-- verbatim: "I approve Q147–Q290 at the recommended options"). Written on
-- claude/sprint-inpatient-backend at e224bc62 (staging-novu-ci-20261005 at
-- 0cfddcc9: 0001-0153 applied), stacked on ADT-1's 0170-0173 in the same pull
-- request. The number is provisional: numbers are given at merge. The
-- declaration in config/production-schema-compatibility.json stays unsigned
-- until the owner signs this file. 0175 (inpatient medicine orders and the
-- medicine round), 0176 (tasks, fluid balance, shifts and handover) and 0177
-- (who uses them) are their own files.
--
-- Owner decisions (25 November 2026, each at its recommended option; the
-- contract is docs/EHR_PLANNED_CONTRACT.md, NUR-1): Q195 A (extend today's
-- vitals: one vitals history), Q199 A (no early-warning or severity score:
-- values and soft flags only), Q201 A and Q202 A (ICU is a ward type; its first
-- chart is hourly vitals, GCS, oxygen and FiO2, glucose and fluid balance),
-- and the section's smaller choices Q-NUR-7 A (the new fields wherever vitals
-- are entered) and Q-NUR-8 A (AVPU).
--
-- What it changes (nothing else):
-- O1 ehr.vitals gains ten nullable columns with no default, so adding them
--    touches no row: pain_score (0-10), avpu (alert, voice, pain, unresponsive),
--    blood_glucose_mmol_l numeric(3,1) (0.5-50.0), oxygen_device (room_air,
--    nasal_cannula, simple_mask, venturi_mask, non_rebreather_mask,
--    high_flow_nasal, cpap_or_niv, tracheostomy_mask, ventilator, other),
--    oxygen_flow_l_per_min numeric(4,1) (0.5-70.0), fio2_percent (21-100),
--    gcs_eye (1-4), gcs_verbal (1-5), gcs_verbal_not_testable, gcs_motor (1-6).
--    "ventilator" records only that the patient is ventilated; no ventilator
--    settings (Q202 A).
-- O2 New CHECKs on ehr.vitals: vitals_oxygen_ck (a flow or FiO2 only with a
--    device; on room air no flow, and FiO2 null or 21) and vitals_gcs_ck (the
--    three GCS parts or none; gcs_verbal null exactly when the verbal part is
--    not testable).
-- O3 0004's "at least one value" CHECK (vitals_check) is replaced by
--    vitals_one_value_ck, which counts the old and the new fields; 0004's
--    corrections CHECK on the replacement keys
--    (vital_corrections_replacement_values_check3) is replaced by
--    vital_corrections_keys_ck with the ten new keys added. Both are added NOT
--    VALID and then validated here (one scan each). The preconditions pin both
--    old definitions exactly.
--    Nothing else of 0004, 0005 or 0142 changes: the policies, the status
--    guard, vitals_versioned and vitals_no_delete stay (their bodies md5-pinned
--    before and after).
-- O4 Functions (SECURITY DEFINER, search_path pg_catalog, pg_temp, owned like
--    0135's, EXECUTE for hid_ehr_runtime only): ehr.observation_chart
--    (route 2: the stay's readings with each correction applied, entered in
--    error included and marked, and with view=hourly the ICU grid's hours with
--    the hourly fluid in, out and running balance). It returns no score: the
--    answer's score is always null (Q199 A); the soft flags are VIT-1's,
--    worked out by ehr-api on each read and never stored. Helpers no role may
--    execute: ehr.nursing_caller (the caller, the nursing codes it holds, the
--    purpose; 0175 and 0176 use it) and ehr.observation_fluid_hours (no rows
--    here; 0176 replaces it once fluid balance exists).
-- O5 Audit, in the request's transaction: ehr.observation-chart.read (the
--    admission, the window, the count). Never a value. This file itself writes
--    no audit row: it changes no existing row.
--
-- Locks (measured with pg_locks before commit and compared by the migrations
-- suite), taken first, NOWAIT: ACCESS EXCLUSIVE on ehr.vitals and
-- ehr.vital_corrections (the column adds and the CHECK swaps; one validating
-- scan each); ROW EXCLUSIVE on audit.events (the audit helper's body names it);
-- ACCESS SHARE on ehr.admissions, ehr.encounters and ehr.wards (read by the
-- preconditions or named by the bodies). A busy table fails the attempt at
-- once, and its subtransaction releases what it took. The attempt is made 50
-- times, 100 ms apart (about 5 seconds); then 55P03 (nothing applied). When
-- this transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run applies every pending file
-- in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied. Both refusals begin "0174: " and end "run the release again at a
-- quieter time" (#306).
--
-- Old images on this schema: today's ehr-api inserts the old columns only,
-- which the new CHECKs allow, and its vitals routes select a fixed column list
-- (VITAL_COLUMNS). Two reads take the whole row with to_jsonb(v): the latest
-- vitals (which keeps only its named measures) and the staff records evidence
-- (the same staff member's same patient, under the same access: the new fields
-- show as extra keys once a reading has them, nothing leaks). The patient's
-- evidence uses an explicit list, so patients see the new fields only when the
-- new image adds them.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- two functions, the helpers and the two new CHECKs, put 0004's two CHECKs
-- back, and drop the ten columns once no reading has them.
--
-- The whole file is one statement (do $nur0174$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0142 and 0171 applied; "0174:
--    already applied" when every object of this file is there; "0174: the
--    schema is not in the reviewed state" for any half state; 0004's two
--    CHECKs exactly; the bodies this file calls or keeps md5-pinned; the
--    policies on the two tables as they are.
-- 2. O1-O4.
-- 3. Post-checks: the columns, the CHECKs (validated), the old CHECKs gone,
--    the policies and kept bodies unchanged; the three functions in 0168's
--    form (body md5, SECURITY DEFINER setting, volatility, search_path, owner,
--    EXECUTE); no row of audit.events, ehr.vitals or ehr.vital_corrections
--    written (this transaction's own row counters; no count of a table).

do $nur0174$
declare
  v_writes_before text;
  v_post_mismatch text;
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
  v_policies text;
  v_one_value_0004 constant text := 'CHECK ((num_nonnulls(height_cm, weight_kg, temperature_c, pulse_bpm, '
    || 'respiratory_rate, systolic_mmhg, diastolic_mmhg, oxygen_saturation_percent) > 0))';
  v_keys_0004 constant text := 'CHECK (((replacement_values - ARRAY[''height_cm''::text, ''weight_kg''::text, '
    || '''temperature_c''::text, ''pulse_bpm''::text, ''respiratory_rate''::text, ''systolic_mmhg''::text, '
    || '''diastolic_mmhg''::text, ''oxygen_saturation_percent''::text]) = ''{}''::jsonb))';
begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table ehr.vitals, ehr.vital_corrections in access exclusive mode nowait;
  lock table audit.events in row exclusive mode nowait;
  lock table ehr.admissions, ehr.encounters, ehr.wards in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0174: ehr.vitals, ehr.vital_corrections, audit.events or a table 0174 reads (admissions, visits, '
          || 'wards) is busy, and this transaction already holds an earlier migration''s locks, so it does not '
          || 'wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0174: ehr.vitals, ehr.vital_corrections, audit.events or a table 0174 reads (admissions, visits, '
          || 'wards) stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- Markers of 0142 (a reading's status) and 0171 (admissions and their cards).
  if not exists (select 1 from pg_attribute where attrelid = 'ehr.vitals'::regclass and attname = 'status'
                  and not attisdropped)
     or to_regclass('ehr.admissions') is null
     or to_regprocedure('ehr.admission_cards(uuid[], boolean)') is null
     or to_regprocedure('ehr.inpatient_audit(uuid, text, text, text, text, jsonb)') is null then
    raise exception using errcode = '55000', message = '0174: 0142 and 0170-0171 must be applied first';
  end if;

  select count(*) into v_present
    from (values
      ((select attribute_row.attrelid::oid from pg_attribute attribute_row
         where attribute_row.attrelid = 'ehr.vitals'::regclass and attribute_row.attname = 'gcs_motor'
           and not attribute_row.attisdropped)),
      ((select constraint_row.oid from pg_constraint constraint_row
         where constraint_row.conrelid = 'ehr.vitals'::regclass and constraint_row.conname = 'vitals_one_value_ck')),
      ((select constraint_row.oid from pg_constraint constraint_row
         where constraint_row.conrelid = 'ehr.vital_corrections'::regclass
           and constraint_row.conname = 'vital_corrections_keys_ck')),
      (to_regprocedure('ehr.observation_chart(uuid, timestamptz, timestamptz, boolean)')::oid),
      (to_regprocedure('ehr.nursing_caller(text, text[])')::oid))
         present(object_id)
   where present.object_id is not null;
  if v_present = 5 then
    raise exception using errcode = '55000', message = '0174: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_attribute attribute_row
                 where attribute_row.attrelid = 'ehr.vitals'::regclass and not attribute_row.attisdropped
                   and attribute_row.attname in ('pain_score', 'avpu', 'blood_glucose_mmol_l', 'oxygen_device',
                     'oxygen_flow_l_per_min', 'fio2_percent', 'gcs_eye', 'gcs_verbal', 'gcs_verbal_not_testable',
                     'gcs_motor'))
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'observation\_%' or proc.proname like 'nursing\_%')) then
    raise exception using errcode = '55000',
      message = '0174: the schema is not in the reviewed state (part of 0174 is there); nothing applied';
  end if;
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'ehr.vitals'::regclass and constraint_row.conname = 'vitals_check')
       is distinct from v_one_value_0004
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'ehr.vital_corrections'::regclass
            and constraint_row.conname = 'vital_corrections_replacement_values_check3')
       is distinct from v_keys_0004 then
    raise exception using errcode = '55000',
      message = '0174: the vitals "at least one value" or corrections keys CHECK is not as 0004 left it; nothing applied';
  end if;
  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('ehr.inpatient_audit(uuid,text,text,text,text,jsonb)', '81c360af02e3cd2ddb8f3a4fb3041dd2'),
      ('ehr.capture_record_version()', 'cae99883d00e70ab1d20ed6fbc97ad7b'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('ehr.guard_vital_status()', '62fb8e13f61422c2296731daede3b160'),
      ('ehr.validate_append_only_clinical_actor()', '288e99e3a96ceeb16a8d66a882008b94')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0174: these bodies are not as 0001-0173 left them: ' || v_mismatch;
  end if;
  if to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_purpose_of_use()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null then
    raise exception using errcode = '55000', message = '0174: a function this file calls is missing';
  end if;
  select string_agg(policy_row.polname || ':' || policy_row.polcmd::text || ':' || policy_row.polpermissive::text || ':'
                    || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '') || ':'
                    || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), ''),
                    ' | ' order by policy_row.polrelid, policy_row.polname)
    into v_policies
    from pg_policy policy_row
   where policy_row.polrelid in ('ehr.vitals'::regclass, 'ehr.vital_corrections'::regclass);
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  -- The rows of audit.events, ehr.vitals, ehr.vital_corrections this file must not write: this transaction's own row
  -- counters for each (inserted/updated/deleted), taken here and compared in the post-checks. They cost nothing; a
  -- count or a snapshot of the rows would read whole tables under this file's locks.
  select string_agg(format('%s %s/%s/%s', watched.relation, pg_stat_get_xact_tuples_inserted(watched.relation),
           pg_stat_get_xact_tuples_updated(watched.relation), pg_stat_get_xact_tuples_deleted(watched.relation)),
           ', ' order by watched.ord)
    into v_writes_before
    from unnest(array['audit.events', 'ehr.vitals', 'ehr.vital_corrections']::regclass[])
         with ordinality watched(relation, ord);

  -- O1. The new columns (nullable, no default: no row is touched).
  alter table ehr.vitals
    add column pain_score smallint check (pain_score is null or pain_score between 0 and 10),
    add column avpu text check (avpu is null or avpu in ('alert', 'voice', 'pain', 'unresponsive')),
    add column blood_glucose_mmol_l numeric(3,1)
      check (blood_glucose_mmol_l is null or blood_glucose_mmol_l between 0.5 and 50.0),
    add column oxygen_device text check (oxygen_device is null or oxygen_device in ('room_air', 'nasal_cannula',
      'simple_mask', 'venturi_mask', 'non_rebreather_mask', 'high_flow_nasal', 'cpap_or_niv', 'tracheostomy_mask',
      'ventilator', 'other')),
    add column oxygen_flow_l_per_min numeric(4,1)
      check (oxygen_flow_l_per_min is null or oxygen_flow_l_per_min between 0.5 and 70.0),
    add column fio2_percent smallint check (fio2_percent is null or fio2_percent between 21 and 100),
    add column gcs_eye smallint check (gcs_eye is null or gcs_eye between 1 and 4),
    add column gcs_verbal smallint check (gcs_verbal is null or gcs_verbal between 1 and 5),
    add column gcs_verbal_not_testable boolean,
    add column gcs_motor smallint check (gcs_motor is null or gcs_motor between 1 and 6);

  -- O2. The oxygen and GCS rules.
  alter table ehr.vitals add constraint vitals_oxygen_ck check (
    (oxygen_device is not null or (oxygen_flow_l_per_min is null and fio2_percent is null))
    and (oxygen_device is distinct from 'room_air'
         or (oxygen_flow_l_per_min is null and (fio2_percent is null or fio2_percent = 21)))) not valid;
  alter table ehr.vitals add constraint vitals_gcs_ck check (
    (gcs_eye is null) = (gcs_motor is null)
    and (gcs_eye is null) = (gcs_verbal_not_testable is null)
    and (gcs_verbal is null) = coalesce(gcs_verbal_not_testable, true)) not valid;

  -- O3. The two CHECK swaps (NOT VALID, then validated: one scan each).
  alter table ehr.vitals add constraint vitals_one_value_ck check (
    num_nonnulls(height_cm, weight_kg, temperature_c, pulse_bpm, respiratory_rate, systolic_mmhg, diastolic_mmhg,
      oxygen_saturation_percent, pain_score, avpu, blood_glucose_mmol_l, oxygen_device, oxygen_flow_l_per_min,
      fio2_percent, gcs_eye) > 0) not valid;
  alter table ehr.vitals drop constraint vitals_check;
  alter table ehr.vital_corrections add constraint vital_corrections_keys_ck check (
    (replacement_values - array['height_cm', 'weight_kg', 'temperature_c', 'pulse_bpm', 'respiratory_rate',
      'systolic_mmhg', 'diastolic_mmhg', 'oxygen_saturation_percent', 'pain_score', 'avpu', 'blood_glucose_mmol_l',
      'oxygen_device', 'oxygen_flow_l_per_min', 'fio2_percent', 'gcs_eye', 'gcs_verbal', 'gcs_verbal_not_testable',
      'gcs_motor']) = '{}'::jsonb) not valid;
  alter table ehr.vital_corrections drop constraint vital_corrections_replacement_values_check3;
  alter table ehr.vitals validate constraint vitals_oxygen_ck;
  alter table ehr.vitals validate constraint vitals_gcs_ck;
  alter table ehr.vitals validate constraint vitals_one_value_ck;
  alter table ehr.vital_corrections validate constraint vital_corrections_keys_ck;
  comment on column ehr.vitals.oxygen_device is
    '0174 (NUR-1, Q195 A, Q202 A): the oxygen device. "ventilator" records only that the patient is ventilated; ventilator settings are not recorded in this release.';
  comment on column ehr.vitals.gcs_verbal_not_testable is
    '0174 (NUR-1): with a GCS, true when the verbal part cannot be tested (for example a tracheostomy; shown "VT"), false otherwise; null without a GCS.';

  -- O4. Helpers (no role may execute them; the functions run them as their owner).

  -- The caller of a nursing function: an active membership here not held by the cutover, the access the function
  -- needs, and an allowed purpose. The answer says which codes the member holds. The seven nursing codes come with
  -- 0177; before it no role holds one, so every function that needs one refuses.
  create function ehr.nursing_caller(required_access text, allowed_purposes text[])
  returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
    actor_organization uuid, actor_staff uuid, actor_purpose text, can_vital_read boolean, can_vital_write boolean,
    can_admission_read boolean, can_mar_read boolean, can_mar_record boolean, can_task_read boolean,
    can_task_write boolean, can_handover boolean, can_assign boolean, can_shift_setup boolean)
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    refusal text;
  begin
    actor_subject := platform.current_actor_subject();
    actor_account := auth.account_id_for_subject(actor_subject);
    actor_membership := platform.current_membership_id();
    actor_facility := platform.current_facility_id();
    actor_purpose := platform.current_purpose_of_use();
    refusal := case when required_access = 'mar_record' then 'MAR_RECORD_NOT_ALLOWED'
                    when required_access = 'shift_setup' then 'SHIFT_SETUP_NOT_ALLOWED'
                    when required_access = 'assign' then 'SHIFT_ASSIGN_NOT_ALLOWED'
                    else 'NURSING_NOT_ALLOWED' end;
    if actor_account is null or actor_membership is null or actor_facility is null then
      raise exception using errcode = '42501', message = refusal;
    end if;
    select membership.organization_id, membership.staff_id into actor_organization, actor_staff
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if not found then
      raise exception using errcode = '42501', message = refusal;
    end if;
    can_vital_read := auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.vital.read');
    can_vital_write := can_vital_read
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.vital.write');
    can_admission_read := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'ehr.admission.read');
    can_mar_read := auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.mar.read');
    can_mar_record := can_mar_read
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.mar.record');
    can_task_read := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'ehr.nursing-task.read');
    can_task_write := can_task_read
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.nursing-task.write');
    can_handover := can_task_read
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.handover.write');
    can_assign := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'ehr.shift-assignment.manage');
    can_shift_setup := auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
      'ehr.clinical-shift.manage');
    if (required_access = 'chart' and not (can_vital_read and can_admission_read))
       or (required_access = 'fluid_read' and not can_vital_read)
       or (required_access = 'fluid_write' and not can_vital_write)
       or (required_access = 'mar_read' and not can_mar_read)
       or (required_access = 'mar_record' and not can_mar_record)
       or (required_access = 'task_read' and not can_task_read)
       or (required_access = 'task_write' and not can_task_write)
       or (required_access = 'handover' and not can_handover)
       or (required_access = 'assign' and not can_assign)
       or (required_access = 'assign_read' and not (can_task_read or can_assign))
       or (required_access = 'shift_list' and not (can_task_read or can_assign or can_shift_setup))
       or (required_access = 'shift_setup' and not can_shift_setup)
       or required_access not in ('chart', 'fluid_read', 'fluid_write', 'mar_read', 'mar_record', 'task_read',
                                  'task_write', 'handover', 'assign', 'assign_read', 'shift_list', 'shift_setup') then
      raise exception using errcode = '42501', message = refusal;
    end if;
    if actor_purpose is null or not actor_purpose = any (allowed_purposes) then
      raise exception using errcode = '22023', message = 'NURSING_PURPOSE_REQUIRED';
    end if;
    return next;
  end
  $fn$;
  revoke all on function ehr.nursing_caller(text, text[]) from public;

  -- The hourly fluid in, out and running balance of a stay (0176 replaces this once fluid balance exists).
  create function ehr.observation_fluid_hours(requested_admission uuid, requested_from timestamptz,
    requested_to timestamptz)
  returns table (hour_start timestamptz, fluid_in_ml bigint, fluid_out_ml bigint, running_balance_ml bigint)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select null::timestamptz, 0::bigint, 0::bigint, 0::bigint where false
  $fn$;
  revoke all on function ehr.observation_fluid_hours(uuid, timestamptz, timestamptz) from public;

  -- Route 2: the stay's observation chart (Q195 A, Q199 A, Q202 A).
  create function ehr.observation_chart(requested_admission uuid, requested_from timestamptz,
    requested_to timestamptz, requested_hourly boolean)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
    ward_type_value text;
    readings jsonb;
    hours jsonb;
    previous_status_setting text := current_setting('app.vitals_status', true);
  begin
    select * into caller from ehr.nursing_caller('chart', array['direct-care']);
    if requested_admission is null or requested_from is null or requested_to is null
       or requested_to <= requested_from or requested_to - requested_from > interval '7 days' then
      raise exception using errcode = '22023', message = 'NURSING_INVALID';
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility;
    if not found then
      perform ehr.inpatient_audit(null, 'ehr.observation-chart.read', 'failure', 'admission',
        requested_admission::text, jsonb_build_object('refusal', 'not_found'));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    if not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'read_records'), false) then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.observation-chart.read', 'denied', 'admission',
        admission_row.id::text, jsonb_build_object('refusal', 'chart_access_required'));
      return jsonb_build_object('outcome', 'chart_access_required');
    end if;
    select ward.ward_type into ward_type_value from ehr.wards ward where ward.id = admission_row.ward_id;
    -- Readings entered in error are shown, marked (EHR-C8b's chart rule), so the session reads them for this call.
    perform set_config('app.vitals_status', '0142', true);
    select coalesce(jsonb_agg(jsonb_build_object(
             'vitalId', reading.id, 'recordedAt', reading.recorded_at, 'status', reading.status,
             'corrected', reading.corrected,
             'values', jsonb_strip_nulls(jsonb_build_object(
               'heightCm', reading.m->'height_cm', 'weightKg', reading.m->'weight_kg',
               'temperatureC', reading.m->'temperature_c', 'pulseBpm', reading.m->'pulse_bpm',
               'respiratoryRate', reading.m->'respiratory_rate', 'systolicMmhg', reading.m->'systolic_mmhg',
               'diastolicMmhg', reading.m->'diastolic_mmhg',
               'oxygenSaturationPercent', reading.m->'oxygen_saturation_percent',
               'painScore', reading.m->'pain_score', 'avpu', reading.m->'avpu',
               'bloodGlucoseMmolL', reading.m->'blood_glucose_mmol_l', 'oxygenDevice', reading.m->'oxygen_device',
               'oxygenFlowLPerMin', reading.m->'oxygen_flow_l_per_min', 'fio2Percent', reading.m->'fio2_percent',
               'gcsEye', reading.m->'gcs_eye', 'gcsVerbal', reading.m->'gcs_verbal',
               'gcsVerbalNotTestable', reading.m->'gcs_verbal_not_testable', 'gcsMotor', reading.m->'gcs_motor')),
             'recordedByMembershipId', reading.created_by_membership_id, 'rowVersion', reading.row_version)
             order by reading.recorded_at, reading.id), '[]'::jsonb)
      into readings
      from (select vital.id, vital.recorded_at, vital.status, vital.created_by_membership_id, vital.row_version,
                   correction.id is not null as corrected,
                   to_jsonb(vital) || coalesce(correction.replacement_values, '{}'::jsonb) as m
              from ehr.vitals vital
              left join ehr.vital_corrections correction
                on correction.vital_id = vital.id and correction.correction_no = vital.current_correction_no
               and correction.patient_id = vital.patient_id and correction.facility_id = vital.facility_id
             where vital.encounter_id = admission_row.encounter_id and vital.patient_id = admission_row.patient_id
               and vital.facility_id = admission_row.facility_id
               and vital.recorded_at >= requested_from and vital.recorded_at < requested_to) reading;
    if coalesce(requested_hourly, false) then
      select coalesce(jsonb_agg(jsonb_build_object(
               'hourStart', hour_row.hour_start,
               'readingIds', coalesce((select jsonb_agg(vital.id order by vital.recorded_at, vital.id)
                                         from ehr.vitals vital
                                        where vital.encounter_id = admission_row.encounter_id
                                          and vital.patient_id = admission_row.patient_id
                                          and vital.facility_id = admission_row.facility_id
                                          and vital.status = 'recorded'
                                          and vital.recorded_at >= hour_row.hour_start
                                          and vital.recorded_at < hour_row.hour_start + interval '1 hour'), '[]'::jsonb),
               'fluidInMl', coalesce(fluid.fluid_in_ml, 0), 'fluidOutMl', coalesce(fluid.fluid_out_ml, 0),
               'runningBalanceMl', coalesce(fluid.running_balance_ml, 0))
               order by hour_row.hour_start), '[]'::jsonb)
        into hours
        from generate_series(date_trunc('hour', requested_from), requested_to - interval '1 microsecond',
                             interval '1 hour') hour_row(hour_start)
        left join ehr.observation_fluid_hours(admission_row.id, date_trunc('hour', requested_from), requested_to) fluid
          on fluid.hour_start = hour_row.hour_start;
    end if;
    perform set_config('app.vitals_status', coalesce(previous_status_setting, ''), true);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.observation-chart.read', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('from', requested_from, 'to', requested_to,
        'hourly', coalesce(requested_hourly, false), 'readingCount', jsonb_array_length(readings)));
    return jsonb_build_object('outcome', 'found', 'admissionId', admission_row.id,
      'encounterId', admission_row.encounter_id, 'patientId', admission_row.patient_id, 'wardType', ward_type_value,
      'from', requested_from, 'to', requested_to, 'readings', readings, 'hours', hours, 'score', null);
  end
  $fn$;
  comment on function ehr.observation_chart(uuid, timestamptz, timestamptz, boolean) is
    '0174 (NUR-1, Q195 A, Q199 A, Q202 A): the stay''s observation chart: every reading of the stay''s visit in the window (up to 7 days) with its current correction applied, entered in error included and marked; with hourly, the ICU grid''s hours (the readings of each hour, and the hourly fluid in, out and running balance from 0176). No score is ever computed: score is always null. Needs ehr.vital.read, ehr.admission.read and chart read access. Outcomes found, not_found, chart_access_required. Audited (ehr.observation-chart.read; never a value).';
  revoke all on function ehr.observation_chart(uuid, timestamptz, timestamptz, boolean) from public;

  -- Owners and EXECUTE (as 0135: the owner of identity.has_active_consent_grant).
  if v_owner <> current_user then
    execute (select string_agg(format('alter function %s owner to %I', proc.oid::regprocedure, v_owner), '; ')
               from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'ehr'
                and (proc.proname like 'observation\_%' or proc.proname like 'nursing\_%'));
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.observation_chart(uuid, timestamptz, timestamptz, boolean) to hid_ehr_runtime;
  end if;

  -- 3. Post-checks.
  if (select count(*) from pg_attribute attribute_row
       where attribute_row.attrelid = 'ehr.vitals'::regclass and not attribute_row.attisdropped
         and attribute_row.attname in ('pain_score', 'avpu', 'blood_glucose_mmol_l', 'oxygen_device',
           'oxygen_flow_l_per_min', 'fio2_percent', 'gcs_eye', 'gcs_verbal', 'gcs_verbal_not_testable', 'gcs_motor')
         and not attribute_row.attnotnull and not attribute_row.atthasdef) <> 10
     or (select count(*) from pg_constraint constraint_row
          where ((constraint_row.conrelid = 'ehr.vitals'::regclass
                  and constraint_row.conname in ('vitals_oxygen_ck', 'vitals_gcs_ck', 'vitals_one_value_ck'))
                 or (constraint_row.conrelid = 'ehr.vital_corrections'::regclass
                     and constraint_row.conname = 'vital_corrections_keys_ck'))
            and constraint_row.convalidated) <> 4
     or exists (select 1 from pg_constraint constraint_row
                 where (constraint_row.conrelid = 'ehr.vitals'::regclass and constraint_row.conname = 'vitals_check')
                    or (constraint_row.conrelid = 'ehr.vital_corrections'::regclass
                        and constraint_row.conname = 'vital_corrections_replacement_values_check3')) then
    raise exception using errcode = '55000', message = '0174: post-check failed (the columns or the CHECKs)';
  end if;
  if (select string_agg(policy_row.polname || ':' || policy_row.polcmd::text || ':' || policy_row.polpermissive::text || ':'
                        || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '') || ':'
                        || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), ''),
                        ' | ' order by policy_row.polrelid, policy_row.polname)
        from pg_policy policy_row
       where policy_row.polrelid in ('ehr.vitals'::regclass, 'ehr.vital_corrections'::regclass))
     is distinct from v_policies
     or (select md5(prosrc) from pg_proc where oid = 'ehr.guard_vital_status()'::regprocedure)
        <> '62fb8e13f61422c2296731daede3b160'
     or (select md5(prosrc) from pg_proc where oid = 'ehr.capture_record_version()'::regprocedure)
        <> 'cae99883d00e70ab1d20ed6fbc97ad7b'
     or (select count(*) from pg_trigger trigger_row
          where trigger_row.tgrelid = 'ehr.vitals'::regclass and not trigger_row.tgisinternal
            and trigger_row.tgname in ('vitals_versioned', 'vitals_no_delete', 'vitals_status_guard')
            and trigger_row.tgenabled = 'O') <> 3 then
    raise exception using errcode = '55000', message = '0174: post-check failed (a kept policy, trigger or body changed)';
  end if;
  if exists (select 1 from pg_proc proc
               join pg_namespace namespace on namespace.oid = proc.pronamespace,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where namespace.nspname = 'ehr'
                and (proc.proname like 'observation\_%' or proc.proname like 'nursing\_%')
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or proc.proname <> 'observation_chart'))
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'observation\_%' or proc.proname like 'nursing\_%')) <> 3
     or not (select prosecdef from pg_proc
              where oid = 'ehr.observation_chart(uuid, timestamptz, timestamptz, boolean)'::regprocedure)
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'observation\_%' or proc.proname like 'nursing\_%')
                   and proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0174: post-check failed (the functions'' security or grants)';
  end if;

  -- Post-check, rows: no row of audit.events, ehr.vitals, ehr.vital_corrections written.
  if (select string_agg(format('%s %s/%s/%s', watched.relation, pg_stat_get_xact_tuples_inserted(watched.relation),
               pg_stat_get_xact_tuples_updated(watched.relation), pg_stat_get_xact_tuples_deleted(watched.relation)),
               ', ' order by watched.ord)
        from unnest(array['audit.events', 'ehr.vitals', 'ehr.vital_corrections']::regclass[])
             with ordinality watched(relation, ord))
     is distinct from v_writes_before then
    raise exception using errcode = '55000', message = '0174: post-check failed (it wrote a row of a table '
      || 'it must not write; counters before: ' || v_writes_before || ')';
  end if;
  -- Post-check, functions (0168's form). The 3 functions this file makes (3) or replaces (0):
  -- each a plain function with its SECURITY DEFINER setting, volatility, body (the md5 of prosrc) and fixed
  -- search_path as written here. Those it makes are the owner's (v_owner), with EXECUTE for exactly the runtimes
  -- listed (the entry points, when the role exists) and for no other role (none on the helpers); CREATE OR REPLACE
  -- keeps a replaced function's owner and grants.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_post_mismatch
    from (values
      ('ehr.nursing_caller(text,text[])', false, false, 's', 'afe0851769a0403fff7f0df4adbfbf6e',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.observation_fluid_hours(uuid,timestamp with time zone,timestamp with time zone)', false, false, 's', 'c15ad3a0e447fafd48a7d4b8f1630f0c',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.observation_chart(uuid,timestamp with time zone,timestamp with time zone,boolean)', false, true, 'v', 'abf5df7fcb9a7798d70344e44a1697ca',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime'])
    ) expected(signature, replaced, security_definer, volatility, body_md5, config, runtimes)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
   where proc.oid is null or proc.prokind <> 'f' or proc.prosecdef <> expected.security_definer
      or proc.provolatile::text <> expected.volatility or md5(proc.prosrc) <> expected.body_md5
      or proc.proconfig is distinct from array[expected.config]
      or (not expected.replaced
          and (proc.proowner <> (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner)
               or exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                           where acl.grantee <> proc.proowner
                             and (acl.grantee = 0 or acl.privilege_type <> 'EXECUTE'
                                  or not pg_get_userbyid(acl.grantee) = any (expected.runtimes)))
               or exists (select 1 from unnest(expected.runtimes) runtime_name
                            join pg_roles role_row on role_row.rolname = runtime_name
                           where not exists (select 1 from aclexplode(proc.proacl) acl
                                              where acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE'))));
  if v_post_mismatch is not null then
    raise exception using errcode = '55000',
      message = '0174: post-check failed (these functions are not as made: ' || v_post_mismatch || ')';
  end if;
  -- End of the functions' post-check.
  raise notice '0174: the observation chart fields are on vitals (10 columns, 2 new CHECKs, 2 CHECKs replaced; no reading changed) and the chart is installed. No score is computed (Q199 A).';
end
$nur0174$;
