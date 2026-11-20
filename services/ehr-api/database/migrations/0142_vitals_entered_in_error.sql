-- 0142: vitals marked entered in error (EHR-C8b, Akos P1-14, Release B; the
-- planned contract's "EHR-C8b: Vitals marked entered in error"). Booked as
-- 0142 on hid-system#258; numbers are given in merge order at the Release B
-- cut-off. This file requires 0001-0137 applied.
--
-- Today a single vitals reading cannot be withdrawn: a correction must keep
-- at least one value, so vitals taken on the wrong patient stay unless the
-- whole visit is entered in error (EHR-C8a). This file lets one reading be
-- marked entered in error, for good.
--
-- D1 ehr.vitals gains status ('recorded', the default and every existing
--    row, or 'entered_in_error') and status_changed_at (null exactly while
--    recorded). Adding a column with a constant default rewrites nothing;
--    the two CHECKs read the existing rows once, under the lock below.
-- D2 vitals_entered_in_error_hidden: a RESTRICTIVE select policy on
--    ehr.vitals that hides a reading entered in error from every session
--    that has not set app.vitals_status to '0142', which only this release's
--    ehr-api sets, in its staff transactions (0133 D13's pattern). So an
--    older ehr-api image on this schema (during the rolling deploy, or after
--    a rollback) never shows a withdrawn reading as current: it drops out of
--    that image's latest vitals, chart summary, visit lists, reads, staff
--    chat and evidence, and that image's correction of it finds nothing
--    instead of reaching the guard. A restrictive policy only narrows what
--    the other policies allow. (An index of the latest recorded reading was
--    planned here; every reader tests the status through to_jsonb so that it
--    also runs on a schema without this file, so the index could never be
--    used, and it is not built.)
-- D3 ehr.guard_vital_status() and the trigger vitals_status_guard, BEFORE
--    INSERT OR UPDATE (it fires before vitals_versioned, by name):
--    - a new reading is 'recorded' with no status time (else 23514
--      VITAL_STATUS_INVALID);
--    - a reading entered in error never changes again, its status or
--      anything else (55000 VITAL_ENTERED_IN_ERROR): it cannot be undone,
--      and a correction (which moves current_correction_no) is refused;
--    - the one status change is 'recorded' -> 'entered_in_error', changing
--      no measurement, source, recording time or correction number (else
--      23514 VITAL_STATUS_INVALID); the guard sets status_changed_at.
--    vitals_versioned (0004) still requires the change reason and keeps the
--    prior and resulting row, who and when in ehr.record_versions; rows
--    still cannot be deleted (vitals_no_delete).
-- D4 The patient's own read (0067's vitals_patient_self_read) leaves out
--    entered-in-error readings; its corrections' policy reads the reading
--    through it, so their corrections drop out with them. Staff reads keep
--    every row (ehr-api filters, per the contract).
-- D5 The guard is SECURITY INVOKER, search_path pg_catalog, pg_temp, and
--    reads no table. No grant changes: hid_ehr_runtime already holds SELECT,
--    INSERT and UPDATE on ehr.vitals (table level), and nothing is granted
--    on the guard.
--
-- Locks: ACCESS EXCLUSIVE on ehr.vitals (the column adds, the trigger and the
-- policies) and ACCESS SHARE on ehr.encounters (vitals_patient_self_read's
-- subquery, parsed when the policy is altered), held to commit; nothing else
-- is locked beyond planning. Taken first, together, NOWAIT: a busy table
-- fails the attempt at once and
-- its subtransaction releases what it took; the attempt is made again every
-- 100 ms for at most 5 seconds, then 55P03 (nothing applied). When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run), one attempt and no
-- sleep: 55P03 at once, nothing applied.
--
-- Old services on this schema: today's ehr-api never names the columns and
-- inserts and corrects only recorded readings, which the guard admits
-- unchanged, and D2 hides every withdrawn reading from it. Its staff record
-- evidence hashes each row's to_jsonb, which gains the two columns here, so
-- if today's image refreshes vitals evidence on this schema it embeds those
-- chunks again; this release's image leaves both columns out of its hashes,
-- so its hashes are those of before this file (and such chunks are embedded
-- once more). Roll this release's ehr-api out before this file (it runs on a
-- schema without it) or right after it.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1. The columns (D1).
-- 2. The guard and its trigger (D3, D5).
-- 3. The patient's own read (D4) and the older images' read (D2).
-- 4. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regclass('auth.session_facility_selection') is null
     or to_regprocedure('identity.qoreid_nin_record_used(character,text)') is null then
    raise exception using errcode = '55000', message = '0142: 0001-0137 must be applied first';
  end if;
  if exists (select 1 from pg_attribute attribute
              where attribute.attrelid = 'ehr.vitals'::regclass and attribute.attname in ('status', 'status_changed_at')
                and not attribute.attisdropped)
     or to_regprocedure('ehr.guard_vital_status()') is not null
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid = 'ehr.vitals'::regclass
                   and policy_row.polname = 'vitals_entered_in_error_hidden') then
    raise exception using errcode = '55000', message = '0142: already applied';
  end if;
  select string_agg(expected.column_name, ', ') into mismatch
    from (values ('patient_id', 'uuid'), ('facility_id', 'uuid'), ('encounter_id', 'uuid'),
      ('recorded_at', 'timestamp with time zone'), ('created_at', 'timestamp with time zone'),
      ('source', 'text'), ('current_correction_no', 'integer'), ('row_version', 'bigint')) expected(column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = 'ehr.vitals'::regclass and attribute.attname = expected.column_name
                        and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0142: these ehr.vitals columns are not as this file reads them: ' || mismatch;
  end if;
  if (select string_agg(trigger_row.tgname, ',' order by trigger_row.tgname) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.vitals'::regclass and not trigger_row.tgisinternal)
     is distinct from 'vitals_no_delete,vitals_versioned' then
    raise exception using errcode = '55000', message = '0142: ehr.vitals'' triggers are not 0004''s two';
  end if;
  if not exists (select 1 from pg_policy policy_row
                  where policy_row.polrelid = 'ehr.vitals'::regclass and policy_row.polname = 'vitals_patient_self_read'
                    and policy_row.polcmd = 'r' and policy_row.polpermissive
                    and pg_get_expr(policy_row.polqual, policy_row.polrelid) =
                      '(ehr.patient_self_context(patient_id) AND (EXISTS ( SELECT 1
   FROM ehr.encounters e
  WHERE ((e.id = vitals.encounter_id) AND (e.patient_id = vitals.patient_id) AND (e.status = ''completed''::text)))))') then
    raise exception using errcode = '55000', message = '0142: vitals_patient_self_read is not 0067''s';
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
      lock table ehr.vitals in access exclusive mode nowait;
      lock table ehr.encounters in access share mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0142: ehr.vitals or ehr.encounters is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0142: ehr.vitals or ehr.encounters stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The columns (D1).
alter table ehr.vitals
  add column status text not null default 'recorded',
  add column status_changed_at timestamptz,
  add constraint vitals_status_ck check (status in ('recorded', 'entered_in_error')),
  add constraint vitals_status_shape_ck check ((status = 'recorded') = (status_changed_at is null));
comment on column ehr.vitals.status is
  'recorded, or entered_in_error (0142, EHR-C8b): a reading withdrawn for good; the reason is in ehr.record_versions.';
comment on column ehr.vitals.status_changed_at is 'When the reading was marked entered in error (0142); null while recorded.';

-- 2. The guard (D3, D5) and its trigger.
create function ehr.guard_vital_status()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status is distinct from 'recorded' or new.status_changed_at is not null then
      raise exception using errcode = '23514', message = 'VITAL_STATUS_INVALID';
    end if;
    return new;
  end if;
  if old.status = 'entered_in_error' then
    raise exception using errcode = '55000', message = 'VITAL_ENTERED_IN_ERROR';
  end if;
  if new.status is distinct from old.status then
    if new.status is distinct from 'entered_in_error'
       or (new.encounter_id, new.recorded_at, new.height_cm, new.weight_kg, new.temperature_c, new.pulse_bpm,
           new.respiratory_rate, new.systolic_mmhg, new.diastolic_mmhg, new.oxygen_saturation_percent, new.source,
           new.current_correction_no)
          is distinct from
          (old.encounter_id, old.recorded_at, old.height_cm, old.weight_kg, old.temperature_c, old.pulse_bpm,
           old.respiratory_rate, old.systolic_mmhg, old.diastolic_mmhg, old.oxygen_saturation_percent, old.source,
           old.current_correction_no) then
      raise exception using errcode = '23514', message = 'VITAL_STATUS_INVALID';
    end if;
    new.status_changed_at := clock_timestamp();
  elsif new.status_changed_at is distinct from old.status_changed_at then
    raise exception using errcode = '23514', message = 'VITAL_STATUS_INVALID';
  end if;
  return new;
end
$$;
comment on function ehr.guard_vital_status() is
  'Guard of ehr.vitals.status (0142, EHR-C8b): a new reading is recorded (else 23514 VITAL_STATUS_INVALID); a reading entered in error never changes again (55000 VITAL_ENTERED_IN_ERROR); the one status change is recorded -> entered_in_error, changing nothing else, with status_changed_at set here.';
revoke all on function ehr.guard_vital_status() from public;
create trigger vitals_status_guard
  before insert or update on ehr.vitals
  for each row execute function ehr.guard_vital_status();

-- 3. The patient's own read (D4) and the older images' read (D2).
alter policy vitals_patient_self_read on ehr.vitals using
  (ehr.patient_self_context(patient_id) and status = 'recorded'
   and exists(select 1 from ehr.encounters e where e.id=encounter_id and e.patient_id=vitals.patient_id and e.status='completed'));
create policy vitals_entered_in_error_hidden on ehr.vitals as restrictive for select
  using (status = 'recorded' or current_setting('app.vitals_status', true) = '0142');

-- 4. Post-checks.
do $$
begin
  if (select string_agg(trigger_row.tgname, ',' order by trigger_row.tgname) from pg_trigger trigger_row
       where trigger_row.tgrelid = 'ehr.vitals'::regclass and not trigger_row.tgisinternal)
     is distinct from 'vitals_no_delete,vitals_status_guard,vitals_versioned' then
    raise exception using errcode = '55000', message = '0142: ehr.vitals'' triggers are not as created';
  end if;
  if exists (select 1 from ehr.vitals vital where vital.status <> 'recorded' or vital.status_changed_at is not null) then
    raise exception using errcode = '55000', message = '0142: an existing reading is not recorded';
  end if;
  if not exists (select 1 from pg_policy policy_row
                  where policy_row.polrelid = 'ehr.vitals'::regclass and policy_row.polname = 'vitals_patient_self_read'
                    and pg_get_expr(policy_row.polqual, policy_row.polrelid) like '%status = ''recorded''::text%') then
    raise exception using errcode = '55000', message = '0142: vitals_patient_self_read does not leave out entered-in-error readings';
  end if;
  if (select count(*) from pg_policy policy_row where policy_row.polrelid = 'ehr.vitals'::regclass) <> 5
     or not exists (select 1 from pg_policy policy_row
                     where policy_row.polrelid = 'ehr.vitals'::regclass
                       and policy_row.polname = 'vitals_entered_in_error_hidden'
                       and not policy_row.polpermissive and policy_row.polcmd = 'r'
                       and policy_row.polroles = array[0::oid]
                       and pg_get_expr(policy_row.polqual, policy_row.polrelid) =
                         '((status = ''recorded''::text) OR (current_setting(''app.vitals_status''::text, true) = ''0142''::text))') then
    raise exception using errcode = '55000', message = '0142: ehr.vitals does not have its four policies and the restrictive read';
  end if;
  if exists (select 1 from pg_proc proc where proc.oid = 'ehr.guard_vital_status()'::regprocedure
              and (proc.prosecdef or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp'])) then
    raise exception using errcode = '55000', message = '0142: ehr.guard_vital_status() is not as created';
  end if;
end
$$;
