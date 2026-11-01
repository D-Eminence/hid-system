-- Pharmacy acceptance source check (0100): how many EXISTING same-facility
-- Pharmacy work items do not match their EHR prescription. Read-only; counts
-- only (no id, name, patient, medicine or any other value leaves the
-- database). For the owner to run on production, before or after 0100: 0100
-- checks new acceptances only and changes no existing row, so the answer is
-- the same either way.
--
-- How to run: psql (or any client) connected to the production database,
--   psql "$DATABASE_URL" -X -f audit-existing-work-items.sql
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
--
-- Each work item lands in exactly one row of the answer, in this order:
--   missing                     no ehr.prescriptions row has its id;
--   other_patient_or_facility   the prescription belongs to another patient,
--                               another facility, or the work item's facility
--                               and ordering facility differ;
--   other_encounter             same patient and facility, another encounter;
--   version_not_found           neither the history nor the current row has
--                               the version it names;
--   not_active_at_acceptance    that version's status was not 'active';
--   fields_differ               medication, dose, route, frequency,
--                               instructions, dates, prescriber or time
--                               differ from that version;
--   matches                     none of the above (0100 would have accepted
--                               it), of which matches_exactly needed no trim
--                               or millisecond rule.
-- total = the sum of the seven. Also: route_backed (not judged here) and
-- fields_differ_dispensed / not_active_dispensed (of those two rows, how
-- many were dispensed and not reversed: the ones that matter clinically).
-- Every count should be 0 except matches, matches_exactly and route_backed.

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
         coalesce(history.resulting_state,
                  case when prescription.row_version = work.source_ehr_prescription_version
                       then to_jsonb(prescription) end) as state,
         exists (select 1 from pharmacy.dispensings dispensing
                  where dispensing.work_item_id = work.id
                    and not exists (select 1 from pharmacy.dispensing_reversals reversal
                                     where reversal.dispensing_id = dispensing.id)) as dispensed
    from same_facility work
    left join ehr.prescriptions prescription on prescription.id = work.source_ehr_prescription_id
    left join ehr.record_versions history
      on history.resource_type = 'prescriptions'
     and history.resource_id = work.source_ehr_prescription_id::text
     and history.version_no = work.source_ehr_prescription_version
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
  select compared.dispensed, compared.texts_and_time_exact,
         case
           when compared.prescription_id is null then 'missing'
           when compared.rx_patient_id is distinct from compared.patient_id
             or compared.rx_facility_id is distinct from compared.facility_id
             or compared.rx_facility_id is distinct from compared.ordering_facility_id then 'other_patient_or_facility'
           when compared.rx_encounter_id is distinct from compared.source_encounter_id then 'other_encounter'
           when compared.state is null then 'version_not_found'
           when compared.state->>'status' is distinct from 'active' then 'not_active_at_acceptance'
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
       count(*) filter (where outcome = 'fields_differ') as fields_differ,
       count(*) filter (where outcome = 'matches') as matches,
       count(*) filter (where outcome = 'matches' and texts_and_time_exact) as matches_exactly,
       count(*) filter (where outcome = 'not_active_at_acceptance' and dispensed) as not_active_dispensed,
       count(*) filter (where outcome = 'fields_differ' and dispensed) as fields_differ_dispensed,
       (select count(*) from pharmacy.work_items work where work.order_route_id is not null) as route_backed
  from judged;

rollback;
