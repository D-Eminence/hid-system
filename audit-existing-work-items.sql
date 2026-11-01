-- Pharmacy source checks (0100 at acceptance, 0101 at dispensing): how many
-- EXISTING same-facility Pharmacy work items do not match their EHR
-- prescription, and how many are or were dispensed after that prescription
-- changed or stopped. Read-only; counts only (no id, name, patient, medicine
-- or any other value leaves the database). For the owner to run on
-- production, before or after 0100 and 0101: they check new acceptances and
-- dispensings only and change no existing row, so the answer is the same
-- either way (except that the "now" counts below move as the EHR and
-- Pharmacy keep working).
--
-- How to run: psql (or any client) connected to the production database,
--   psql "$DATABASE_URL" -X -x -f audit-existing-work-items.sql
-- (-x prints one count per line)
-- as a role that bypasses row-level security (rolsuper or rolbypassrls):
-- pharmacy.work_items, ehr.prescriptions and ehr.record_versions force
-- row-level security, so any other role would see only part of them. The
-- query does not count what it can see: with row_security off PostgreSQL
-- stops it with "query would be affected by row-level security policy for
-- table ..." instead. To check the role first:
--   select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user;
-- It runs in a READ ONLY transaction that it rolls back, with a 60 second
-- statement timeout, and takes only ACCESS SHARE locks (it never waits for
-- or blocks an acceptance, a dispensing or an EHR change).
--
-- What it compares: each same-facility work item (order_route_id is null;
-- route-backed ones were already checked against their route, 0086) with
-- the prescription it names, as that prescription stood at the version the
-- work item says it accepted: the EHR's own version history
-- (ehr.record_versions, resulting_state of that version), or the current row
-- when it is still at that version and no history row exists. It applies
-- 0100's own rules: texts equal as stored or with what JavaScript's trim()
-- removes cut from the stored text; the dose by value; prescribed_at equal to
-- created_at or created_at cut to the millisecond; ids and dates exactly.
-- It also finds the version that was current when the work item was accepted:
-- the newest ehr.record_versions row recorded at or before accepted_at (both
-- are the database's clock_timestamp()). 0100 compares an acceptance with the
-- prescription as it stands at that moment, so a work item that names an
-- older version than that one, or that was accepted when the prescription
-- was no longer active, is one 0100 would have refused. When no history row
-- was recorded by accepted_at, only the version it names is judged.
--
-- Each work item lands in exactly one row of the answer, in this order:
--   missing                     no ehr.prescriptions row has its id;
--   other_patient_or_facility   the prescription belongs to another patient,
--                               another facility, or the work item's facility
--                               and ordering facility differ;
--   other_encounter             same patient and facility, another encounter;
--   version_not_found           neither the history nor the current row has
--                               the version it names;
--   not_active_at_acceptance    the version it names, or the version current
--                               when it was accepted, was not 'active' (for
--                               example cancelled or completed before Pharmacy
--                               accepted it; 0100: PRESCRIPTION_SOURCE_NOT_ACTIVE);
--   stale_version_at_acceptance a newer, still active version was current when
--                               it was accepted (the prescription had changed;
--                               0100: PRESCRIPTION_SOURCE_VERSION_MISMATCH);
--   fields_differ               medication, dose, route, frequency,
--                               instructions, dates, prescriber or time
--                               differ from the version it names;
--   matches                     none of the above (0100 would have accepted
--                               it), of which matches_exactly needed no trim
--                               or millisecond rule.
-- total = the sum of the eight. Also: route_backed (not judged here) and
-- not_active_dispensed / stale_version_dispensed / fields_differ_dispensed
-- (of those three rows, how many were dispensed and not reversed: the ones
-- that matter clinically).
--
-- Then, for the same work items whose prescription exists, what has happened
-- SINCE they were accepted (the prescription as it stands now; "dispensed"
-- means a dispensing that was not reversed):
--   undispensed_now_not_active  not dispensed, and the prescription is now
--                               not 'active' (cancelled, on hold, completed,
--                               entered in error). From 0101 Pharmacy cannot
--                               dispense these (409
--                               PHARMACY_PRESCRIPTION_NOT_DISPENSABLE); the
--                               prescriber writes a new prescription if one is
--                               still needed;
--   undispensed_now_changed     not dispensed, and the prescription is now at
--                               another version than the one accepted (any
--                               change, including the status changes above);
--                               from 0101 none of these can be dispensed;
--   dispensed_now_changed       dispensed, and the prescription is now not
--                               'active' or at another version (often normal:
--                               completed after it was dispensed);
--   dispensed_after_a_change    dispensed, and a newer version of the
--                               prescription than the one accepted was
--                               recorded at or before the first dispensing:
--                               dispensed after the prescription had been
--                               cancelled, held or changed (what 0101 now
--                               refuses; these matter clinically).
-- Every count should be 0 except matches, matches_exactly, route_backed and
-- the three "now" counts undispensed_now_not_active, undispensed_now_changed
-- and dispensed_now_changed. The first two are the work items 0101 holds
-- back from dispensing (not an error in the data: the prescription changed
-- after Pharmacy accepted it); the third is mostly ordinary (a prescription
-- completed after it was dispensed).

begin transaction isolation level repeatable read read only;
set local row_security = off;
set local statement_timeout = '60s';
set local lock_timeout = '5s';

with js_whitespace(characters) as (
  select string_agg(chr(code), '' order by code)
    from unnest(array[9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
                      8202, 8232, 8233, 8239, 8287, 12288, 65279]) code
),
same_facility as (
  select work.*
    from pharmacy.work_items work
   where work.order_route_id is null
),
accepted as (
  select work.id,
         work.patient_id, work.facility_id, work.ordering_facility_id, work.source_encounter_id,
         work.medication_code_system, work.medication_code, work.medication_display, work.dose_quantity,
         work.dose_unit, work.route_code, work.frequency, work.instructions, work.starts_on, work.ends_on,
         work.prescribed_by, work.prescribed_at,
         prescription.id as prescription_id,
         prescription.patient_id as rx_patient_id, prescription.facility_id as rx_facility_id,
         prescription.encounter_id as rx_encounter_id,
         work.source_ehr_prescription_version as named_version,
         at_acceptance.version_no as version_at_acceptance,
         at_acceptance.resulting_state->>'status' as status_at_acceptance,
         coalesce(history.resulting_state,
                  case when prescription.row_version = work.source_ehr_prescription_version
                       then to_jsonb(prescription) end) as state,
         prescription.status as rx_status_now,
         prescription.row_version as rx_version_now,
         exists (select 1 from pharmacy.dispensings dispensing
                  where dispensing.work_item_id = work.id
                    and not exists (select 1 from pharmacy.dispensing_reversals reversal
                                     where reversal.dispensing_id = dispensing.id)) as dispensed,
         -- A newer version than the one accepted, recorded at or before the
         -- first dispensing (reversed or not) of this work item.
         exists (select 1 from ehr.record_versions newer
                  where newer.resource_type = 'prescriptions'
                    and newer.resource_id = work.source_ehr_prescription_id::text
                    and newer.version_no > work.source_ehr_prescription_version
                    and newer.recorded_at <= (select min(dispensing.dispensed_at) from pharmacy.dispensings dispensing
                                               where dispensing.work_item_id = work.id)) as dispensed_after_change
    from same_facility work
    left join ehr.prescriptions prescription on prescription.id = work.source_ehr_prescription_id
    left join ehr.record_versions history
      on history.resource_type = 'prescriptions'
     and history.resource_id = work.source_ehr_prescription_id::text
     and history.version_no = work.source_ehr_prescription_version
    -- The version current when the work item was accepted (the newest one
    -- recorded before accepted_at): 0100 refuses any other.
    left join lateral (
      select later.version_no, later.resulting_state
        from ehr.record_versions later
       where later.resource_type = 'prescriptions'
         and later.resource_id = work.source_ehr_prescription_id::text
         and later.recorded_at <= work.accepted_at
       order by later.version_no desc
       limit 1) at_acceptance on true
),
compared as (
  select accepted.*,
         -- One field: equal as stored, or as trim() leaves the stored text.
         (accepted.medication_code_system is not distinct from accepted.state->>'medication_code_system'
            or accepted.medication_code_system is not distinct from btrim(accepted.state->>'medication_code_system', ws.characters))
         and (accepted.medication_code is not distinct from accepted.state->>'medication_code'
            or accepted.medication_code is not distinct from btrim(accepted.state->>'medication_code', ws.characters))
         and (accepted.medication_display is not distinct from accepted.state->>'medication_display'
            or accepted.medication_display is not distinct from btrim(accepted.state->>'medication_display', ws.characters))
         and accepted.dose_quantity is not distinct from (accepted.state->>'dose_quantity')::numeric
         and (accepted.dose_unit is not distinct from accepted.state->>'dose_unit'
            or accepted.dose_unit is not distinct from btrim(accepted.state->>'dose_unit', ws.characters))
         and (accepted.route_code is not distinct from accepted.state->>'route_code'
            or accepted.route_code is not distinct from btrim(accepted.state->>'route_code', ws.characters))
         and (accepted.frequency is not distinct from accepted.state->>'frequency'
            or accepted.frequency is not distinct from btrim(accepted.state->>'frequency', ws.characters))
         and (accepted.instructions is not distinct from accepted.state->>'instructions'
            or accepted.instructions is not distinct from btrim(accepted.state->>'instructions', ws.characters))
         and accepted.starts_on is not distinct from (accepted.state->>'starts_on')::date
         and accepted.ends_on is not distinct from (accepted.state->>'ends_on')::date
         and accepted.prescribed_by is not distinct from (accepted.state->>'created_by')::uuid
         and (accepted.prescribed_at is not distinct from (accepted.state->>'created_at')::timestamptz
            or accepted.prescribed_at is not distinct from
                 date_trunc('milliseconds', (accepted.state->>'created_at')::timestamptz)) as fields_match,
         accepted.medication_code_system is not distinct from accepted.state->>'medication_code_system'
         and accepted.medication_code is not distinct from accepted.state->>'medication_code'
         and accepted.medication_display is not distinct from accepted.state->>'medication_display'
         and accepted.dose_unit is not distinct from accepted.state->>'dose_unit'
         and accepted.route_code is not distinct from accepted.state->>'route_code'
         and accepted.frequency is not distinct from accepted.state->>'frequency'
         and accepted.instructions is not distinct from accepted.state->>'instructions'
         and accepted.prescribed_at is not distinct from (accepted.state->>'created_at')::timestamptz as texts_and_time_exact
    from accepted cross join js_whitespace ws
),
judged as (
  select compared.dispensed, compared.texts_and_time_exact, compared.prescription_id, compared.named_version,
         compared.rx_status_now, compared.rx_version_now, compared.dispensed_after_change,
         case
           when compared.prescription_id is null then 'missing'
           when compared.rx_patient_id is distinct from compared.patient_id
             or compared.rx_facility_id is distinct from compared.facility_id
             or compared.rx_facility_id is distinct from compared.ordering_facility_id then 'other_patient_or_facility'
           when compared.rx_encounter_id is distinct from compared.source_encounter_id then 'other_encounter'
           when compared.state is null then 'version_not_found'
           when compared.state->>'status' is distinct from 'active'
             or (compared.version_at_acceptance is not null
                 and compared.status_at_acceptance is distinct from 'active') then 'not_active_at_acceptance'
           when compared.version_at_acceptance is not null
            and compared.version_at_acceptance <> compared.named_version then 'stale_version_at_acceptance'
           when not compared.fields_match then 'fields_differ'
           else 'matches'
         end as outcome
    from compared
)
select count(*) as total,
       count(*) filter (where outcome = 'missing') as missing,
       count(*) filter (where outcome = 'other_patient_or_facility') as other_patient_or_facility,
       count(*) filter (where outcome = 'other_encounter') as other_encounter,
       count(*) filter (where outcome = 'version_not_found') as version_not_found,
       count(*) filter (where outcome = 'not_active_at_acceptance') as not_active_at_acceptance,
       count(*) filter (where outcome = 'stale_version_at_acceptance') as stale_version_at_acceptance,
       count(*) filter (where outcome = 'fields_differ') as fields_differ,
       count(*) filter (where outcome = 'matches') as matches,
       count(*) filter (where outcome = 'matches' and texts_and_time_exact) as matches_exactly,
       count(*) filter (where outcome = 'not_active_at_acceptance' and dispensed) as not_active_dispensed,
       count(*) filter (where outcome = 'fields_differ' and dispensed) as fields_differ_dispensed,
       count(*) filter (where outcome = 'stale_version_at_acceptance' and dispensed) as stale_version_dispensed,
       (select count(*) from pharmacy.work_items work where work.order_route_id is not null) as route_backed,
       count(*) filter (where prescription_id is not null and not dispensed
                          and rx_status_now is distinct from 'active') as undispensed_now_not_active,
       count(*) filter (where prescription_id is not null and not dispensed
                          and rx_version_now is distinct from named_version) as undispensed_now_changed,
       count(*) filter (where prescription_id is not null and dispensed
                          and (rx_status_now is distinct from 'active'
                               or rx_version_now is distinct from named_version)) as dispensed_now_changed,
       count(*) filter (where prescription_id is not null and dispensed and dispensed_after_change)
         as dispensed_after_a_change
  from judged;

rollback;
