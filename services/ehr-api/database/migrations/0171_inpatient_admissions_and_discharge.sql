-- 0171 ADT-1 Inpatient admission: admissions, transfers, discharge,
-- wristbands and the death record (Release D, the department sprint the owner
-- approved on 25 November 2026, verbatim: "I approve Q147–Q290 at the
-- recommended options"). Written on claude/sprint-inpatient-backend at
-- 64b22777 (staging at 95fa1e52, 0001-0151 applied) after 0170 in the same
-- pull request. The number is provisional (given at merge, after 0152-0169).
-- It needs 0170, 0135, 0145 and ED-1's 0168 (the ED record's two CHECKs
-- below); it reads nothing 0152-0154, APPT-1 or BILL-1 create. The
-- declaration in config/production-schema-compatibility.json stays unsigned
-- until the owner signs this file.
--
-- Owner decisions (25 November 2026, each at its recommended option): Q184 A
-- (an admission is an inpatient encounter plus an admission row), Q185 A
-- (doctors and clinicians request, decide and discharge; nurses, clinicians
-- and doctors give and move beds), Q186 A (one patient per bed), Q187 A (five
-- outcomes: routine, dama, referred_out, absconded, died), Q188 A (the death
-- record built and switched off), Q189 A (discharge never reads the bill),
-- Q190 A (names on ward lists: the 0170 switch), Q192 A (inpatient and newborn
-- bands), Q194 A (ehr.admission_notice_recipients for ORD-11). Smaller choices
-- at their recommended option, not yet answered: Q-ADT-9 A (the planned
-- encounter at the request), Q-ADT-10 A (the reason on ward lists for
-- nurses, clinicians and doctors), Q-ADT-11 A (clinical steps need chart
-- write access; giving and moving beds and bands do not), Q-ADT-12 A
-- (routine and referred-out discharges need "Prepare discharge" first),
-- Q-ADT-16 A (the band), Q-ADT-17 A (the newborn's own admission linked to
-- the mother's), Q-ADT-18 A (ED-1's admission requests adopted).
--
-- What it changes (nothing else):
-- A1 ehr.admission_counters      the admission number counter per facility
--                                and Lagos year, taken FOR UPDATE (A-2026-
--                                000123, gap free).
-- A2 ehr.admissions              who and where (facility, organisation,
--                                patient, the inpatient encounter (unique),
--                                the admission number); where it came from
--                                (source ed, consultation, waiting_list or
--                                direct, with the ED record, the earlier
--                                visit, the waiting-list row, the mother's
--                                admission); the request (reason 1-300, care
--                                team 1-80, responsible doctor, ward wanted,
--                                who and when); the stay (status requested,
--                                admitted, discharge_ready, discharged or
--                                cancelled; when and by whom admitted; ward
--                                and bed; expected discharge date; follow-up
--                                plan 1-2000; when and by whom prepared); the
--                                end (outcome, when and by whom discharged,
--                                the summary note, the structured summary as
--                                signed, the referral facility 2-120, the time
--                                of death, cancel time and reason 8-500); who
--                                changed it last; row version. CHECKs: a bed
--                                and ward exactly while admitted or
--                                discharge_ready; an outcome and discharge
--                                time exactly when discharged; died_at exactly
--                                for died; a facility name exactly for
--                                referred_out; the source columns match the
--                                source. Unique: one open admission per
--                                (facility, patient); one open admission per
--                                bed (one patient per bed under any race).
-- A3 ehr.admission_movements     one row per request, admit, transfer,
--                                prepare, discharge, cancel, change and band
--                                print, with from and to ward and bed, the
--                                actor, the time, the Idempotency-Key with the
--                                request's SHA-256 (unique per membership and
--                                key), small details (an outcome, a print
--                                number, a reprint reason; never text) and the
--                                handover (1-2000, transfers only). Append
--                                only.
-- A4 ehr.admission_discharge_medicines  the medicines on discharge, as a set
--                                of the stay's prescriptions, replaced by
--                                "Prepare discharge".
-- A5 ehr.wristband_prints        every band print (inpatient or newborn), its
--                                number, the reprint reason and the pair
--                                code. Never a Health ID. Append only.
-- A6 ehr.death_records, ehr.death_record_versions  the certificate content
--                                and every amendment (append only). Built and
--                                empty: no role holds ehr.death-record.write
--                                and the death_record switch is off.
--    Every new table has row-level security enabled and no policy or
--    privilege for any runtime role: only the functions below read or write
--    them, as their owner.
-- A7 ED-1 link (Q-ADT-18 A): ehr.ed_attendances' closed_via CHECK gains
--    'admission' and ehr.ed_attendance_events' kind CHECK gains 'admitted'.
--    The CHECKs found must be exactly 0168's; every value found is kept.
-- A8 Three owner-only policies, as 0131's encounters_owner_read: no runtime
--    role is a member of the tables' owner, so they open nothing to a runtime
--    role.
--    - encounters_inpatient_owner_update on ehr.encounters (UPDATE): the
--      inpatient functions move a stay's encounter (planned, in progress,
--      completed, cancelled) when the member giving the bed or cancelling the
--      request has no chart grant (Q-ADT-11 A): only an inpatient encounter,
--      only the one named by the transaction-local marker
--      hid.inpatient_encounter the function sets first;
--    - record_versions_inpatient_owner_insert on ehr.record_versions
--      (INSERT): that move's version row (EHR-C1's history, written by
--      0004's trigger as the member);
--    - recorded_allergies_inpatient_band_read on ehr.recorded_allergies
--      (SELECT): the band's "Allergy: check the chart" line reads whether any
--      active allergy is recorded, for the patient named by the marker
--      hid.inpatient_band_patient; the names are never read out.
-- A9 SECURITY DEFINER functions (search_path pg_catalog, pg_temp), owned like
--    0170's, EXECUTE for hid_ehr_runtime only: ehr.admission_request,
--    ehr.admission_list, ehr.admission_read, ehr.admission_admit,
--    ehr.admission_transfer, ehr.admission_handover_read,
--    ehr.admission_prepare_discharge, ehr.admission_discharge,
--    ehr.admission_cancel, ehr.admission_update, ehr.discharge_summary_print,
--    ehr.wristband_print, ehr.newborn_band_print, ehr.death_record_write,
--    ehr.death_record_read, ehr.death_record_amend, ehr.death_record_print.
--    Helpers no role may execute: ehr.admission_cards (the card, 0145's
--    record kind and label, the name and reason hiding), ehr.admission_key,
--    ehr.admission_encounter_move, ehr.admission_bed_move,
--    ehr.admission_stay_ended (ends the stay's ward-team grants through 0173's
--    identity.end_ward_stay_grants once it exists), ehr.admission_sex_mismatch,
--    ehr.admission_notice_recipients (Q194, for ORD-11: the responsible
--    doctor; NUR-1 replaces it), the history's immutability trigger, and
--    0170's ehr.inpatient_bed_occupants, ehr.inpatient_waiting and
--    ehr.inpatient_day_counts, replaced (md5 pinned before) so the board and
--    the census show admissions.
--    ehr.admission_request makes the encounter (encounter_type 'inpatient',
--    status planned, started now) as the member, after checking
--    ehr.context_allows(patient, facility, 'write_records') (Q-ADT-9 A).
--    ehr.admission_admit sets it in_progress; ehr.admission_discharge
--    completed with ended_at; ehr.admission_cancel cancelled. Each change
--    writes the encounter's version row as EHR-C1 does (0004's trigger).
--    ehr.admission_discharge writes the summary as a signed clinical note
--    and its first revision (note type "Discharge summary"), as EHR-C5 writes
--    a consultation note. No admission function reads a bill (Q189 A; 0172
--    scans their bodies).
--    Every write locks the admission, then the beds involved in id order,
--    then the ED record and the waiting-list row, FOR UPDATE, always in that
--    order; it checks row_version and raises the versions of the rows it
--    changes.
-- A10 Audit, in the request's transaction, refusals included (as 0170):
--    ehr.admission.request (the source), .read, .list (+ .list.shown per
--    patient), .admit, .transfer (whether a handover was given),
--    .handover-read, .prepare-discharge, .discharge (the outcome), .cancel,
--    .update, ehr.admission.sex-mismatch-confirmed,
--    ehr.discharge-summary.print, ehr.wristband.print and
--    ehr.newborn-band.print (print number and reprint reason),
--    ehr.death-record.write, .read, .amend, .print. Never a name, date of
--    birth, Health ID, reason, handover, summary, cause of death, referral
--    facility name or reason text. This file itself writes no audit row.
--
-- Locks (measured with pg_locks before commit and compared by the migrations
-- suite), taken first, NOWAIT: ACCESS EXCLUSIVE on ehr.encounters,
-- ehr.record_versions and ehr.recorded_allergies (CREATE POLICY; the
-- foreign keys to ehr.encounters need no more), and on ehr.ed_attendances and
-- ehr.ed_attendance_events (the CHECK swaps; small tables, milliseconds); SHARE
-- ROW EXCLUSIVE on identity.patients, identity.facilities,
-- identity.staff_facility_memberships, ehr.clinical_notes, ehr.prescriptions,
-- ehr.visit_queue, ehr.wards and ehr.beds (the foreign keys of the new, empty
-- tables); ROW EXCLUSIVE on audit.events and ehr.bed_status_events (the bodies
-- write them; a SQL body is checked when it is created); ACCESS SHARE on
-- identity.unknown_patients, identity.consent_grants,
-- identity.consent_directives, identity.consent_directive_versions,
-- identity.patient_identifiers, identity.facility_profiles, identity.staff,
-- ehr.diagnoses, ehr.clinical_note_revisions, ehr.inpatient_switches,
-- ehr.ward_staff, auth.permissions,
-- auth.role_permissions and auth.account_roles (read by the preconditions or
-- named by the bodies). The ACCESS EXCLUSIVE holds on the three clinical
-- tables last milliseconds (catalog changes only; no scan), as 0131's on
-- ehr.encounters. A busy table fails the attempt at once, and its
-- subtransaction releases what it took. The attempt is made 50 times, 100 ms
-- apart (about 5 seconds); then 55P03 (nothing applied). When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run applies every pending file
-- in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied. Both refusals begin "0171: " and end "run the release again at a
-- quieter time", so the runner's dry run rolls back and tries again (#306).
--
-- Old images on this schema: nothing calls the new functions. ED-1's image
-- never writes closed_via 'admission'; it shows an ED record closed that way
-- as closed. Today's ehr-api shows an inpatient encounter as any visit.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- functions, the three policies and the new tables once no admission exists,
-- put back 0170's three helpers and the two CHECKs found (once no ED record
-- is closed via admission).
--
-- The whole file is one statement (do $adt0171$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0170 applied and its three
--    helpers as 0170 wrote them (md5); 0135, 0145 and 0168 applied;
--    "0171: already applied" when every object of this file is there,
--    "0171: the schema is not in the reviewed state" for any half state; the
--    two ED CHECKs exactly 0168's; the bodies this file calls md5-pinned; the
--    columns it reads by name and type; the owner may read ehr.encounters.
-- 2. A1-A9.
-- 3. Post-checks: the tables have row-level security and no privilege; the
--    functions' security, search_path and EXECUTE; the two CHECKs are the
--    found ones plus the new value; the three policies are there; no row of
--    any existing table changed; no audit row written.

do $adt0171$
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
  v_closed_via_found text;
  v_kind_found text;
  v_ed_rows text;
  -- 0168's two CHECKs, and what this file leaves.
  v_closed_via_0168 constant text := 'CHECK (((closed_via IS NULL) OR (closed_via = ANY (ARRAY[''board''::text, '
    || '''disposition''::text, ''cancel''::text, ''waiting_list''::text]))))';
  v_closed_via_0171 constant text := 'CHECK (((closed_via IS NULL) OR (closed_via = ANY (ARRAY[''board''::text, '
    || '''disposition''::text, ''cancel''::text, ''waiting_list''::text, ''admission''::text]))))';
  v_kind_0168 constant text := 'CHECK ((kind = ANY (ARRAY[''arrived''::text, ''moved_from_waiting_list''::text, '
    || '''already_on_board''::text, ''triaged''::text, ''moved''::text, ''visit_linked''::text, '
    || '''disposition''::text, ''disposition_changed''::text, ''left''::text, ''cancelled''::text, '
    || '''closed_on_waiting_list''::text])))';
  v_kind_0171 constant text := 'CHECK ((kind = ANY (ARRAY[''arrived''::text, ''moved_from_waiting_list''::text, '
    || '''already_on_board''::text, ''triaged''::text, ''moved''::text, ''visit_linked''::text, '
    || '''disposition''::text, ''disposition_changed''::text, ''left''::text, ''cancelled''::text, '
    || '''closed_on_waiting_list''::text, ''admitted''::text])))';
begin
  -- Before the locks (catalog reads only): the files whose tables step 0 locks.
  if to_regclass('ehr.wards') is null or to_regclass('ehr.beds') is null
     or to_regclass('ehr.inpatient_switches') is null or to_regclass('ehr.ward_staff') is null then
    raise exception using errcode = '55000', message = '0171: 0170 must be applied first';
  end if;
  if to_regclass('ehr.ed_attendances') is null or to_regclass('ehr.ed_attendance_events') is null then
    raise exception using errcode = '55000', message = '0171: 0135, 0145 and ED-1''s 0168 must be applied first';
  end if;

  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table ehr.encounters, ehr.record_versions, ehr.recorded_allergies in access exclusive mode nowait;
  lock table ehr.ed_attendances, ehr.ed_attendance_events in access exclusive mode nowait;
  lock table identity.patients, identity.facilities, identity.staff_facility_memberships, ehr.clinical_notes,
    ehr.prescriptions, ehr.visit_queue, ehr.wards, ehr.beds
    in share row exclusive mode nowait;
  lock table audit.events, ehr.bed_status_events in row exclusive mode nowait;
  lock table identity.unknown_patients, identity.consent_grants, identity.consent_directives,
    identity.consent_directive_versions, identity.patient_identifiers, identity.facility_profiles, identity.staff,
    ehr.diagnoses, ehr.clinical_note_revisions, ehr.inpatient_switches, ehr.ward_staff,
    auth.permissions, auth.role_permissions, auth.account_roles
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0171: ehr.encounters, ehr.record_versions, ehr.recorded_allergies, the ED records, a table the new '
          || 'tables reference (patients, facilities, staff memberships, clinical notes, prescriptions, the waiting '
          || 'list, wards, beds), audit.events or a table 0171 reads is busy, and this transaction already holds an '
          || 'earlier migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0171: ehr.encounters, ehr.record_versions, ehr.recorded_allergies, the ED records, a table the new '
          || 'tables reference (patients, facilities, staff memberships, clinical notes, prescriptions, the waiting '
          || 'list, wards, beds), audit.events or a table 0171 reads stayed busy for 5 seconds; nothing applied; run '
          || 'the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regclass('ehr.wards') is null or to_regclass('ehr.beds') is null
     or to_regprocedure('ehr.bed_board(uuid, text)') is null
     or to_regprocedure('ehr.inpatient_caller(text, text[])') is null then
    raise exception using errcode = '55000', message = '0171: 0170 must be applied first';
  end if;
  if to_regclass('ehr.ed_attendances') is null or to_regclass('ehr.ed_attendance_events') is null
     or to_regprocedure('ehr.visit_queue_ed_close_mirror()') is null
     or to_regclass('ehr.visit_queue') is null or to_regclass('identity.unknown_patients') is null then
    raise exception using errcode = '55000', message = '0171: 0135, 0145 and ED-1''s 0168 must be applied first';
  end if;

  select pg_get_constraintdef(constraint_row.oid) into v_closed_via_found from pg_constraint constraint_row
   where constraint_row.conrelid = 'ehr.ed_attendances'::regclass
     and constraint_row.conname = 'ed_attendances_closed_via_check';
  select pg_get_constraintdef(constraint_row.oid) into v_kind_found from pg_constraint constraint_row
   where constraint_row.conrelid = 'ehr.ed_attendance_events'::regclass
     and constraint_row.conname = 'ed_attendance_events_kind_check';
  select count(*) into v_present
    from (values (to_regclass('ehr.admissions')::oid), (to_regclass('ehr.admission_movements')::oid),
                 (to_regclass('ehr.admission_discharge_medicines')::oid), (to_regclass('ehr.wristband_prints')::oid),
                 (to_regclass('ehr.death_records')::oid), (to_regclass('ehr.death_record_versions')::oid),
                 (to_regclass('ehr.admission_counters')::oid),
                 (to_regprocedure('ehr.admission_request(uuid, text, uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, text)')::oid),
                 (to_regprocedure('ehr.admission_discharge(uuid, bigint, text, timestamptz, jsonb, text, timestamptz, text, text, text)')::oid),
                 ((select policy_row.oid from pg_policy policy_row
                    where policy_row.polrelid = 'ehr.encounters'::regclass
                      and policy_row.polname = 'encounters_inpatient_owner_update')))
         present(object_id)
   where present.object_id is not null;
  if v_present = 10 and v_closed_via_found = v_closed_via_0171 and v_kind_found = v_kind_0171 then
    raise exception using errcode = '55000', message = '0171: already applied';
  end if;
  if v_present <> 0
     or v_closed_via_found like '%admission%' or v_kind_found like '%''admitted''%'
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'admission\_%' or proc.proname like 'admissions\_%'
                        or proc.proname like 'wristband\_%' or proc.proname like 'newborn\_%'
                        or proc.proname like 'death\_record%' or proc.proname like 'discharge\_%')) then
    raise exception using errcode = '55000',
      message = '0171: the schema is not in the reviewed state (part of 0171 is there); nothing applied';
  end if;
  if v_closed_via_found is distinct from v_closed_via_0168 or v_kind_found is distinct from v_kind_0168 then
    raise exception using errcode = '55000',
      message = '0171: the ED record''s closed_via or history kind CHECK is not as 0168 left it; nothing applied';
  end if;

  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('ehr.capture_record_version()', 'cae99883d00e70ab1d20ed6fbc97ad7b'),
      ('ehr.visit_queue_ed_close_mirror()', '6aaaeb33d1318136fb7fba5ad405fc8e'),
      -- 0170's three parts this file replaces, as 0170 wrote them.
      ('ehr.inpatient_bed_occupants(uuid,uuid[])', 'ef7fdc71d0e22a5f7ea179a432da1125'),
      ('ehr.inpatient_waiting(uuid,uuid[])', '4fe910433909cce113d9bbdeff3902d9'),
      ('ehr.inpatient_day_counts(uuid,date)', '6664ebd5a34ce8e017aa8ab9f05507eb')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0171: these bodies are not as 0001-0170 left them: ' || v_mismatch;
  end if;
  -- The columns this file reads, by name and type.
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('ehr.encounters', 'patient_id', 'uuid'), ('ehr.encounters', 'facility_id', 'uuid'),
      ('ehr.encounters', 'encounter_type', 'text'), ('ehr.encounters', 'status', 'text'),
      ('ehr.encounters', 'started_at', 'timestamp with time zone'),
      ('ehr.encounters', 'ended_at', 'timestamp with time zone'),
      ('ehr.encounters', 'created_by', 'uuid'), ('ehr.encounters', 'created_by_membership_id', 'uuid'),
      ('ehr.clinical_notes', 'note_type', 'text'), ('ehr.clinical_notes', 'signed_by', 'uuid'),
      ('ehr.clinical_notes', 'signed_at', 'timestamp with time zone'),
      ('ehr.clinical_note_revisions', 'content', 'text'), ('ehr.clinical_note_revisions', 'change_reason', 'text'),
      ('ehr.prescriptions', 'encounter_id', 'uuid'), ('ehr.prescriptions', 'medication_display', 'text'),
      ('ehr.prescriptions', 'medication_strength', 'text'), ('ehr.prescriptions', 'medication_dose_form', 'text'),
      ('ehr.prescriptions', 'dose_quantity', 'numeric(12,4)'), ('ehr.prescriptions', 'dose_unit', 'text'),
      ('ehr.prescriptions', 'frequency', 'text'), ('ehr.prescriptions', 'duration_value', 'integer'),
      ('ehr.prescriptions', 'duration_unit', 'text'), ('ehr.prescriptions', 'status', 'text'),
      ('ehr.diagnoses', 'encounter_id', 'uuid'), ('ehr.diagnoses', 'display', 'text'),
      ('ehr.diagnoses', 'code', 'text'), ('ehr.diagnoses', 'code_system', 'text'),
      ('ehr.diagnoses', 'verification_status', 'text'),
      ('ehr.recorded_allergies', 'patient_id', 'uuid'), ('ehr.recorded_allergies', 'status', 'text'),
      ('ehr.visit_queue', 'stage', 'text'), ('ehr.visit_queue', 'closed_at', 'timestamp with time zone'),
      ('ehr.visit_queue', 'row_version', 'bigint'),
      ('ehr.ed_attendances', 'status', 'text'), ('ehr.ed_attendances', 'disposition_outcome', 'text'),
      ('ehr.ed_attendances', 'admitting_membership_id', 'uuid'),
      ('ehr.ed_attendances', 'visit_queue_entry_id', 'uuid'), ('ehr.ed_attendances', 'row_version', 'bigint'),
      ('identity.patients', 'full_name', 'text'), ('identity.patients', 'first_name', 'text'),
      ('identity.patients', 'last_name', 'text'), ('identity.patients', 'gender', 'text'),
      ('identity.patients', 'dob', 'date'), ('identity.patients', 'hid_code', 'text'),
      ('identity.patients', 'status', 'text'),
      ('identity.unknown_patients', 'label', 'text'), ('identity.unknown_patients', 'status', 'text'),
      ('identity.patient_identifiers', 'identifier_type', 'text'),
      ('identity.patient_identifiers', 'verified', 'boolean'),
      ('identity.patient_identifiers', 'revoked_at', 'timestamp with time zone'),
      ('identity.facility_profiles', 'address_line', 'text'), ('identity.facility_profiles', 'city', 'text'),
      ('identity.facility_profiles', 'phone_e164', 'text'), ('identity.staff', 'full_name', 'text')
    ) wanted(relation, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = wanted.relation::regclass
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0171: these columns are not as 0001-0170 left them: ' || v_mismatch;
  end if;
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'ehr.bed_board(uuid, text)'::regprocedure);
  if not pg_has_role(v_owner, (select relation.relowner from pg_class relation
                                where relation.oid = 'ehr.encounters'::regclass), 'USAGE') then
    raise exception using errcode = '55000',
      message = '0171: the owner of 0170''s functions cannot read ehr.encounters under its forced row-level security';
  end if;
  select count(*) into v_audit_rows from audit.events;
  select md5(coalesce(string_agg(to_jsonb(attendance)::text, ',' order by attendance.id), '')) into v_ed_rows
    from ehr.ed_attendances attendance;

  -- A1. The admission number counter.
  create table ehr.admission_counters (
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    year integer not null check (year between 2000 and 9999),
    next_value bigint not null default 1 check (next_value between 1 and 999999999),
    primary key (facility_id, year)
  );
  alter table ehr.admission_counters enable row level security;
  revoke all on ehr.admission_counters from public;

  -- A2. Admissions.
  create table ehr.admissions (
    id uuid primary key default gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    organization_id uuid not null,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    encounter_id uuid not null unique,
    admission_number text not null check (admission_number ~ '^A-[0-9]{4}-[0-9]{6,9}$'),
    source text not null check (source in ('ed', 'consultation', 'waiting_list', 'direct')),
    ed_attendance_id uuid references ehr.ed_attendances(id) on delete restrict,
    from_encounter_id uuid references ehr.encounters(id) on delete restrict,
    visit_queue_entry_id uuid references ehr.visit_queue(id) on delete restrict,
    mother_admission_id uuid references ehr.admissions(id) on delete restrict,
    reason text not null check (reason = btrim(reason) and length(reason) between 1 and 300
      and reason !~ '[[:cntrl:]]'),
    care_team text check (care_team is null or (care_team = btrim(care_team) and length(care_team) between 1 and 80
      and care_team !~ '[[:cntrl:]]')),
    responsible_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    requested_ward_id uuid references ehr.wards(id) on delete restrict,
    requested_at timestamptz not null,
    requested_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    status text not null default 'requested'
      check (status in ('requested', 'admitted', 'discharge_ready', 'discharged', 'cancelled')),
    admitted_at timestamptz,
    admitted_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    ward_id uuid references ehr.wards(id) on delete restrict,
    bed_id uuid references ehr.beds(id) on delete restrict,
    expected_discharge_on date,
    follow_up_plan text check (follow_up_plan is null or (length(btrim(follow_up_plan)) between 1 and 2000)),
    prepared_at timestamptz,
    prepared_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    outcome text check (outcome is null or outcome in ('routine', 'dama', 'referred_out', 'absconded', 'died')),
    discharged_at timestamptz,
    discharged_by_membership_id uuid references identity.staff_facility_memberships(id) on delete restrict,
    summary_note_id uuid references ehr.clinical_notes(id) on delete restrict,
    discharge_summary jsonb check (discharge_summary is null or jsonb_typeof(discharge_summary) = 'object'),
    referred_to_facility_name text check (referred_to_facility_name is null
      or (referred_to_facility_name = btrim(referred_to_facility_name)
          and length(referred_to_facility_name) between 2 and 120 and referred_to_facility_name !~ '[[:cntrl:]]')),
    died_at timestamptz,
    cancelled_at timestamptz,
    cancel_reason text check (cancel_reason is null or (cancel_reason = btrim(cancel_reason)
      and length(cancel_reason) between 8 and 500)),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    unique (facility_id, admission_number),
    unique (id, facility_id),
    constraint admissions_facility_organization_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict,
    constraint admissions_encounter_fk foreign key (encounter_id, patient_id, facility_id)
      references ehr.encounters(id, patient_id, facility_id) on delete restrict,
    constraint admissions_bed_fk foreign key (bed_id, facility_id) references ehr.beds(id, facility_id) on delete restrict,
    constraint admissions_ward_fk foreign key (ward_id, facility_id) references ehr.wards(id, facility_id) on delete restrict,
    -- A bed and a ward exactly while admitted or discharge ready.
    constraint admissions_bed_ck check (
      (status in ('admitted', 'discharge_ready')) = (bed_id is not null)
      and (bed_id is null) = (ward_id is null)),
    constraint admissions_admitted_ck check (
      (admitted_at is null) = (admitted_by_membership_id is null)
      and (status in ('admitted', 'discharge_ready', 'discharged') or admitted_at is null)
      and (status not in ('admitted', 'discharge_ready') or admitted_at is not null)),
    constraint admissions_prepared_ck check (
      (prepared_at is null) = (prepared_by_membership_id is null)
      and (status <> 'discharge_ready' or prepared_at is not null)),
    -- An outcome and a discharge time exactly when discharged.
    constraint admissions_discharged_ck check (
      (status = 'discharged') = (outcome is not null)
      and (status = 'discharged') = (discharged_at is not null)
      and (status = 'discharged') = (discharged_by_membership_id is not null)
      and (discharged_at is null or admitted_at is null or discharged_at >= admitted_at)),
    constraint admissions_died_ck check ((outcome is not distinct from 'died') = (died_at is not null)),
    constraint admissions_referral_ck check (
      (outcome is not distinct from 'referred_out') = (referred_to_facility_name is not null)),
    constraint admissions_summary_ck check (
      (summary_note_id is null) = (discharge_summary is null) and (summary_note_id is null or status = 'discharged')),
    constraint admissions_cancelled_ck check (
      (status = 'cancelled') = (cancelled_at is not null) and (status = 'cancelled') = (cancel_reason is not null)),
    -- The source columns match the source.
    constraint admissions_source_ck check (
      (source = 'ed') = (ed_attendance_id is not null)
      and (source = 'consultation') = (from_encounter_id is not null)
      and (source in ('ed', 'waiting_list')) = (visit_queue_entry_id is not null)),
    constraint admissions_mother_ck check (mother_admission_id is null or mother_admission_id <> id)
  );
  create unique index admissions_open_patient_ux on ehr.admissions (facility_id, patient_id)
    where status in ('requested', 'admitted', 'discharge_ready');
  create unique index admissions_open_bed_ux on ehr.admissions (bed_id) where status in ('admitted', 'discharge_ready');
  create index admissions_facility_status_idx on ehr.admissions (facility_id, status, ward_id);
  create index admissions_patient_idx on ehr.admissions (patient_id);
  create index admissions_discharged_idx on ehr.admissions (facility_id, discharged_at) where status = 'discharged';
  create index admissions_mother_idx on ehr.admissions (mother_admission_id) where mother_admission_id is not null;
  create index admissions_ed_idx on ehr.admissions (ed_attendance_id) where ed_attendance_id is not null;
  alter table ehr.admissions enable row level security;
  revoke all on ehr.admissions from public;
  comment on table ehr.admissions is
    '0171 (ADT-1, Q184 A): an admission: the inpatient encounter plus this row. One open admission per patient per facility, one per bed. Only the inpatient functions read and write it, as its owner.';

  -- A3. Movements.
  create table ehr.admission_movements (
    id uuid primary key default gen_random_uuid(),
    sequence_no bigint generated always as identity,
    admission_id uuid not null references ehr.admissions(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    kind text not null check (kind in ('requested', 'admitted', 'transferred', 'prepared', 'discharged', 'cancelled',
      'details_changed', 'wristband_printed')),
    at timestamptz not null default clock_timestamp(),
    by_account_id uuid not null,
    by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    from_ward_id uuid references ehr.wards(id) on delete restrict,
    from_bed_id uuid references ehr.beds(id) on delete restrict,
    to_ward_id uuid references ehr.wards(id) on delete restrict,
    to_bed_id uuid references ehr.beds(id) on delete restrict,
    handover text check (handover is null or length(btrim(handover)) between 1 and 2000),
    details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
    constraint admission_movements_handover_ck check (handover is null or kind = 'transferred')
  );
  create unique index admission_movements_key_ux on ehr.admission_movements (by_membership_id, idempotency_key);
  create index admission_movements_admission_idx on ehr.admission_movements (admission_id, sequence_no);
  create index admission_movements_facility_day_idx on ehr.admission_movements (facility_id, at, kind);
  alter table ehr.admission_movements enable row level security;
  revoke all on ehr.admission_movements from public;
  comment on table ehr.admission_movements is
    '0171 (ADT-1): every request, admit, transfer, prepare, discharge, cancel, change and band print of an admission, with the beds, the actor, the Idempotency-Key and the request''s SHA-256. The handover text (transfers only) is clinical content, read only through ehr.admission_handover_read. Append only.';

  create function ehr.admission_history_immutable()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    raise exception using errcode = '55000', message = 'INPATIENT_HISTORY_IMMUTABLE';
  end
  $fn$;
  revoke all on function ehr.admission_history_immutable() from public;
  create trigger admission_movements_immutable
    before update or delete on ehr.admission_movements
    for each row execute function ehr.admission_history_immutable();

  -- A4. Medicines on discharge.
  create table ehr.admission_discharge_medicines (
    admission_id uuid not null references ehr.admissions(id) on delete restrict,
    prescription_id uuid not null,
    patient_id uuid not null,
    facility_id uuid not null,
    added_at timestamptz not null default clock_timestamp(),
    primary key (admission_id, prescription_id),
    foreign key (prescription_id, patient_id, facility_id)
      references ehr.prescriptions(id, patient_id, facility_id) on delete restrict
  );
  alter table ehr.admission_discharge_medicines enable row level security;
  revoke all on ehr.admission_discharge_medicines from public;

  -- A5. Band prints.
  create table ehr.wristband_prints (
    id uuid primary key default gen_random_uuid(),
    admission_id uuid not null references ehr.admissions(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    kind text not null check (kind in ('inpatient', 'newborn')),
    print_number integer not null check (print_number between 1 and 1000),
    reprint_reason text check (reprint_reason is null
      or reprint_reason in ('lost', 'damaged', 'details_changed', 'moved_ward')),
    pair_code text check (pair_code is null or pair_code ~ '^A-[0-9]{4}-[0-9]{6,9} / B[0-9]{1,2}(, B[0-9]{1,2})*$'),
    by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    at timestamptz not null default clock_timestamp(),
    unique (admission_id, kind, print_number),
    constraint wristband_prints_reason_ck check ((print_number = 1) = (reprint_reason is null))
  );
  alter table ehr.wristband_prints enable row level security;
  revoke all on ehr.wristband_prints from public;
  create trigger wristband_prints_immutable
    before update or delete on ehr.wristband_prints
    for each row execute function ehr.admission_history_immutable();
  comment on table ehr.wristband_prints is
    '0171 (ADT-1, Q192 A): every inpatient and newborn band print, its number, reprint reason and pair code. Never a Health ID. Append only.';

  -- A6. The death record (built, switched off).
  create table ehr.death_records (
    admission_id uuid primary key references ehr.admissions(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    patient_id uuid not null references identity.patients(id) on delete restrict,
    current_version_no integer not null default 1 check (current_version_no > 0),
    created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp()
  );
  create table ehr.death_record_versions (
    admission_id uuid not null references ehr.death_records(admission_id) on delete restrict,
    version_no integer not null check (version_no > 0),
    died_at timestamptz not null,
    causes jsonb not null check (jsonb_typeof(causes) = 'array' and jsonb_array_length(causes) between 1 and 4),
    other_conditions text check (other_conditions is null or length(other_conditions) <= 2000),
    manner text not null check (manner in ('natural', 'accident', 'intentional_self_harm', 'assault',
      'pending_investigation', 'unknown')),
    autopsy text not null check (autopsy in ('not_requested', 'requested', 'done')),
    pregnancy_status text not null default 'not_applicable' check (pregnancy_status in ('not_applicable',
      'not_pregnant', 'pregnant', 'within_42_days', 'within_one_year', 'unknown')),
    place_of_death text not null default 'ward' check (place_of_death in ('ward', 'icu', 'theatre', 'emergency',
      'other')),
    certified_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    signed_at timestamptz not null default clock_timestamp(),
    amend_reason text check (amend_reason is null or length(btrim(amend_reason)) between 8 and 500),
    primary key (admission_id, version_no),
    constraint death_record_versions_amend_ck check ((version_no = 1) = (amend_reason is null))
  );
  alter table ehr.death_records enable row level security;
  alter table ehr.death_record_versions enable row level security;
  revoke all on ehr.death_records from public;
  revoke all on ehr.death_record_versions from public;
  create trigger death_record_versions_immutable
    before update or delete on ehr.death_record_versions
    for each row execute function ehr.admission_history_immutable();
  comment on table ehr.death_records is
    '0171 (ADT-1, Q188 A): the medical certificate of cause of death of an admission discharged as died, built and switched off (no role holds ehr.death-record.write; the death_record switch is off). Never changes the Health ID record and sends no notice.';

  -- A7. The ED record (Q-ADT-18 A): closed by an admission, and its history.
  alter table ehr.ed_attendances drop constraint ed_attendances_closed_via_check;
  alter table ehr.ed_attendances add constraint ed_attendances_closed_via_check
    check (closed_via is null or closed_via in ('board', 'disposition', 'cancel', 'waiting_list', 'admission'));
  alter table ehr.ed_attendance_events drop constraint ed_attendance_events_kind_check;
  alter table ehr.ed_attendance_events add constraint ed_attendance_events_kind_check
    check (kind in ('arrived', 'moved_from_waiting_list', 'already_on_board', 'triaged', 'moved', 'visit_linked',
      'disposition', 'disposition_changed', 'left', 'cancelled', 'closed_on_waiting_list', 'admitted'));

  -- A8. The owner-only policies (see the header).
  create policy encounters_inpatient_owner_update on ehr.encounters
    for update
    using (pg_has_role((select relation.relowner from pg_class relation
                         where relation.oid = 'ehr.encounters'::regclass), 'USAGE')
           and encounter_type = 'inpatient'
           and id::text = current_setting('hid.inpatient_encounter', true))
    with check (pg_has_role((select relation.relowner from pg_class relation
                              where relation.oid = 'ehr.encounters'::regclass), 'USAGE')
                and encounter_type = 'inpatient'
                and id::text = current_setting('hid.inpatient_encounter', true));
  create policy record_versions_inpatient_owner_insert on ehr.record_versions
    for insert
    with check (pg_has_role((select relation.relowner from pg_class relation
                              where relation.oid = 'ehr.record_versions'::regclass), 'USAGE')
                and resource_type = 'encounters'
                and resource_id = current_setting('hid.inpatient_encounter', true)
                and changed_by = platform.current_account_id()
                and changed_by_membership_id = platform.current_membership_id()
                and correlation_id = platform.current_correlation_id());
  create policy recorded_allergies_inpatient_band_read on ehr.recorded_allergies
    for select
    using (pg_has_role((select relation.relowner from pg_class relation
                         where relation.oid = 'ehr.recorded_allergies'::regclass), 'USAGE')
           and patient_id::text = current_setting('hid.inpatient_band_patient', true));

  -- A9. Helpers (no role may execute them; the functions below run them as their owner).

  -- The Idempotency-Key of an admission write: 'new', 'replay' (the same key and body: the admission and the first
  -- answer's kind and details) or 'reused'. Under an advisory lock per membership and key.
  create function ehr.admission_key(a_membership uuid, a_key text, a_sha text)
  returns table (state text, admission_id uuid, kind text, details jsonb)
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    found_movement ehr.admission_movements%rowtype;
  begin
    if a_key is null or a_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or a_sha is null or a_sha !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'INPATIENT_IDEMPOTENCY_KEY_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('inpatient-key:' || a_membership::text || ':' || a_key, 0));
    select movement.* into found_movement from ehr.admission_movements movement
     where movement.by_membership_id = a_membership and movement.idempotency_key = a_key;
    if not found then
      -- A key used for a ward or bed write is reused here.
      if exists (select 1 from ehr.ward_events event
                  where event.by_membership_id = a_membership and event.idempotency_key = a_key) then
        state := 'reused';
      else
        state := 'new';
      end if;
    elsif found_movement.request_sha256 = a_sha then
      state := 'replay';
      admission_id := found_movement.admission_id;
      kind := found_movement.kind;
      details := found_movement.details;
    else
      state := 'reused';
      admission_id := found_movement.admission_id;
    end if;
    return next;
  end
  $fn$;
  revoke all on function ehr.admission_key(uuid, text, text) from public;

  -- The admission card of each given admission at the session facility, in the given order: the admission, 0145's
  -- record kind and label, the name (Q190: ehr.ward_patient_name_visible) and the reason (Q-ADT-10: only when
  -- show_reason). Never a Health ID (its last 4 characters only, and not while the name is hidden).
  create function ehr.admission_cards(requested_ids uuid[], show_reason boolean)
  returns table (ord bigint, admission_id uuid, patient_id uuid, name_shown boolean, card jsonb)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ordering.ord_position, admission.id, admission.patient_id, shown.name_shown,
      jsonb_build_object(
        'admissionId', admission.id, 'admissionNumber', admission.admission_number,
        'patientId', admission.patient_id,
        'fullName', case when not shown.name_shown then null
                         when unknown_record.patient_id is not null then 'Unknown patient ' || unknown_record.label
                         else patient.full_name end,
        'nameHidden', not shown.name_shown,
        'initials', case when unknown_record.patient_id is not null then unknown_record.label
                         else upper(left(patient.first_name, 1)) || ' ' || upper(left(patient.last_name, 1)) end,
        'recordKind', case when unknown_record.patient_id is null then 'standard' else 'unknown' end,
        'unknownLabel', unknown_record.label,
        'sex', patient.gender,
        'dateOfBirth', case when shown.name_shown then patient.dob end,
        'dateOfBirthEstimated', unknown_record.patient_id is not null and patient.dob is not null,
        'ageYears', case when patient.dob is null then null
                         else extract(year from age((clock_timestamp() at time zone 'Africa/Lagos')::date,
                                                    patient.dob))::integer end,
        'ageEstimated', unknown_record.patient_id is not null,
        'healthIdLast4', case when shown.name_shown then right(patient.hid_code, 4) end,
        'ninStatus', case when exists (select 1 from identity.patient_identifiers identifier
                                        where identifier.patient_id = admission.patient_id
                                          and identifier.identifier_type = 'nin' and identifier.verified
                                          and identifier.revoked_at is null) then 'verified' else 'not_verified' end,
        'chartBlocked', shown.blocked,
        'encounterId', admission.encounter_id, 'status', admission.status, 'source', admission.source,
        'edAttendanceId', admission.ed_attendance_id, 'fromEncounterId', admission.from_encounter_id,
        'visitQueueEntryId', admission.visit_queue_entry_id, 'motherAdmissionId', admission.mother_admission_id,
        'reason', case when coalesce(show_reason, false) then admission.reason end,
        'reasonHidden', not coalesce(show_reason, false),
        'careTeam', admission.care_team, 'responsibleMembershipId', admission.responsible_membership_id,
        'requestedWardId', admission.requested_ward_id, 'requestedAt', admission.requested_at,
        'requestedByMembershipId', admission.requested_by_membership_id,
        'admittedAt', admission.admitted_at, 'admittedByMembershipId', admission.admitted_by_membership_id,
        'daysAdmitted', case when admission.admitted_at is null then null
                             else ((coalesce(admission.discharged_at, clock_timestamp()) at time zone 'Africa/Lagos')::date
                                   - (admission.admitted_at at time zone 'Africa/Lagos')::date) end,
        'wardId', admission.ward_id, 'wardName', ward.name, 'bedId', admission.bed_id, 'bedName', bed.name,
        'expectedDischargeOn', admission.expected_discharge_on, 'preparedAt', admission.prepared_at,
        'dischargeReady', admission.status = 'discharge_ready',
        'discharge', case when admission.status <> 'discharged' then null else jsonb_build_object(
          'outcome', admission.outcome, 'dischargedAt', admission.discharged_at,
          'dischargedByMembershipId', admission.discharged_by_membership_id,
          'summaryNoteId', admission.summary_note_id,
          'referredToFacilityName', case when coalesce(show_reason, false) then admission.referred_to_facility_name end,
          'diedAt', admission.died_at) end,
        'cancelledAt', admission.cancelled_at,
        'deathRecorded', exists (select 1 from ehr.death_records record_row where record_row.admission_id = admission.id),
        'billId', null,
        'rowVersion', admission.row_version)
      from unnest(requested_ids) with ordinality ordering(id, ord_position)
      join ehr.admissions admission on admission.id = ordering.id
                                   and admission.facility_id = platform.current_facility_id()
      join identity.patients patient on patient.id = admission.patient_id
      left join identity.unknown_patients unknown_record
        on unknown_record.patient_id = admission.patient_id and unknown_record.status <> 'identified'
      left join ehr.wards ward on ward.id = admission.ward_id
      left join ehr.beds bed on bed.id = admission.bed_id
      cross join lateral (
        select viewer.facility_id, viewer.organization_id, viewer.staff_id
          from identity.staff_facility_memberships viewer
         where viewer.id = platform.current_membership_id()) viewer
      cross join lateral (
        select ehr.inpatient_chart_blocked(admission.patient_id, viewer.facility_id, viewer.organization_id,
                                           viewer.staff_id) as blocked,
               ehr.ward_patient_name_visible(platform.current_membership_id(), admission.patient_id) as name_shown) shown
     order by ordering.ord_position
  $fn$;
  revoke all on function ehr.admission_cards(uuid[], boolean) from public;

  -- Moves a stay's encounter (Q-ADT-9 A) as the member, writing EHR-C1's version row through 0004's trigger. The
  -- marker lets 0171's owner-only policies admit exactly this encounter when the member holds no chart grant.
  create function ehr.admission_encounter_move(requested_encounter uuid, requested_status text,
    requested_ended_at timestamptz, requested_reason text)
  returns void
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    previous_reason text := current_setting('app.change_reason', true);
    moved integer;
  begin
    perform set_config('hid.inpatient_encounter', requested_encounter::text, true);
    perform set_config('app.change_reason', requested_reason, true);
    update ehr.encounters encounter
       set status = requested_status,
           ended_at = case when requested_status = 'completed' then requested_ended_at else encounter.ended_at end
     where encounter.id = requested_encounter and encounter.encounter_type = 'inpatient';
    get diagnostics moved = row_count;
    perform set_config('hid.inpatient_encounter', '', true);
    perform set_config('app.change_reason', coalesce(previous_reason, ''), true);
    if moved <> 1 then
      raise exception using errcode = '55000', message = 'INPATIENT_ENCOUNTER_NOT_MOVED';
    end if;
  end
  $fn$;
  revoke all on function ehr.admission_encounter_move(uuid, text, timestamptz, text) from public;

  -- A bed's status set by an admission step (occupied, or cleaning when the patient leaves), with its history row.
  create function ehr.admission_bed_move(requested_bed uuid, requested_status text, requested_cause text)
  returns void
  language sql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
    insert into ehr.bed_status_events (bed_id, facility_id, from_status, to_status, cause, by_membership_id)
    select bed.id, bed.facility_id, bed.status, requested_status, requested_cause, platform.current_membership_id()
      from ehr.beds bed where bed.id = requested_bed;
    update ehr.beds bed
       set status = requested_status, status_since = clock_timestamp(),
           updated_by_membership_id = platform.current_membership_id(), updated_at = clock_timestamp(),
           row_version = bed.row_version + 1
     where bed.id = requested_bed;
  $fn$;
  revoke all on function ehr.admission_bed_move(uuid, text, text) from public;

  -- Ends the stay's ward-team grants (Q156, Q-ADT-15) through 0173's identity.end_ward_stay_grants once it exists;
  -- before 0173 there is none to end.
  create function ehr.admission_stay_ended(requested_admission uuid, requested_reason text)
  returns integer
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    ended integer := 0;
  begin
    if to_regprocedure('identity.end_ward_stay_grants(uuid, text)') is not null then
      execute 'select identity.end_ward_stay_grants($1, $2)' into ended using requested_admission, requested_reason;
    end if;
    return coalesce(ended, 0);
  end
  $fn$;
  revoke all on function ehr.admission_stay_ended(uuid, text) from public;

  -- Whether a ward takes one sex and the patient's recorded sex is the other.
  create function ehr.admission_sex_mismatch(requested_ward uuid, requested_patient uuid)
  returns boolean
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select coalesce((select ward.takes <> 'any' and lower(patient.gender) in ('male', 'female')
                            and lower(patient.gender) <> ward.takes
                       from ehr.wards ward, identity.patients patient
                      where ward.id = requested_ward and patient.id = requested_patient), false)
  $fn$;
  revoke all on function ehr.admission_sex_mismatch(uuid, uuid) from public;

  -- Q194 A, for ORD-11's staff inbox: who is told of a critical result for an admitted patient. Here the
  -- responsible doctor; NUR-1's 0176 replaces it to add the nurses on shift and the on-call doctor.
  create function ehr.admission_notice_recipients(requested_admission uuid)
  returns table (membership_id uuid, why text)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select admission.responsible_membership_id, 'responsible_doctor'
      from ehr.admissions admission
      join identity.staff_facility_memberships membership on membership.id = admission.responsible_membership_id
     where admission.id = requested_admission and admission.status in ('requested', 'admitted', 'discharge_ready')
       and membership.active and membership.migration_hold_reason is null
  $fn$;
  revoke all on function ehr.admission_notice_recipients(uuid) from public;

  -- 0170's three parts, now with admissions.
  create or replace function ehr.inpatient_bed_occupants(requested_facility uuid, requested_wards uuid[])
  returns table (bed_id uuid, patient_id uuid, admission_id uuid, name_shown boolean, card jsonb)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select admission.bed_id, card.patient_id, card.admission_id, card.name_shown, card.card
      from ehr.admission_cards(
             (select coalesce(array_agg(occupied.id order by occupied.id), array[]::uuid[])
                from ehr.admissions occupied
               where occupied.facility_id = requested_facility and occupied.ward_id = any (requested_wards)
                 and occupied.status in ('admitted', 'discharge_ready')),
             coalesce(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
                                                     platform.current_facility_id(), 'ehr.admission.read'), false)) card
      join ehr.admissions admission on admission.id = card.admission_id
  $fn$;

  create or replace function ehr.inpatient_waiting(requested_facility uuid, requested_wards uuid[])
  returns table (patient_id uuid, admission_id uuid, name_shown boolean, card jsonb)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select card.patient_id, card.admission_id, card.name_shown, card.card
      from ehr.admission_cards(
             (select coalesce(array_agg(waiting_row.id order by waiting_row.requested_at, waiting_row.id), array[]::uuid[])
                from ehr.admissions waiting_row
               where waiting_row.facility_id = requested_facility and waiting_row.status = 'requested'
                 and (waiting_row.requested_ward_id is null or waiting_row.requested_ward_id = any (requested_wards))),
             coalesce(auth.membership_has_permission(platform.current_actor_subject(), platform.current_membership_id(),
                                                     platform.current_facility_id(), 'ehr.admission.read'), false)) card
     order by card.ord
  $fn$;

  create or replace function ehr.inpatient_day_counts(requested_facility uuid, requested_day date)
  returns table (ward_id uuid, admitted integer, transfers_in integer, transfers_out integer, discharged integer,
    died integer, waiting_for_bed integer, midnight_count integer)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    with bounds as (
      select (requested_day::timestamp at time zone 'Africa/Lagos') as day_start,
             least(((requested_day + 1)::timestamp at time zone 'Africa/Lagos'), clock_timestamp()) as day_end),
    moves as (
      select movement.* from ehr.admission_movements movement, bounds
       where movement.facility_id = requested_facility and movement.at >= bounds.day_start
         and movement.at < bounds.day_end),
    counted as (
      select moves.to_ward_id as ward_id, 'admitted' as what from moves where moves.kind = 'admitted'
      union all
      select moves.to_ward_id, 'in' from moves
       where moves.kind = 'transferred' and moves.to_ward_id is distinct from moves.from_ward_id
      union all
      select moves.from_ward_id, 'out' from moves
       where moves.kind = 'transferred' and moves.to_ward_id is distinct from moves.from_ward_id
      union all
      select moves.from_ward_id, case when moves.details->>'outcome' = 'died' then 'died' else 'discharged' end
        from moves where moves.kind = 'discharged'
      union all
      select waiting_row.requested_ward_id, 'waiting'
        from ehr.admissions waiting_row, bounds
       where waiting_row.facility_id = requested_facility and waiting_row.requested_at < bounds.day_end
         and (waiting_row.admitted_at is null or waiting_row.admitted_at >= bounds.day_end)
         and (waiting_row.cancelled_at is null or waiting_row.cancelled_at >= bounds.day_end)
      union all
      select at_midnight.ward_id, 'midnight'
        from ehr.admissions stay, bounds,
             lateral (select movement.to_ward_id as ward_id from ehr.admission_movements movement
                       where movement.admission_id = stay.id and movement.kind in ('admitted', 'transferred')
                         and movement.at < bounds.day_start
                       order by movement.sequence_no desc limit 1) at_midnight
       where stay.facility_id = requested_facility and stay.admitted_at < bounds.day_start
         and (stay.discharged_at is null or stay.discharged_at >= bounds.day_start))
    select counted.ward_id,
           count(*) filter (where counted.what = 'admitted')::integer,
           count(*) filter (where counted.what = 'in')::integer,
           count(*) filter (where counted.what = 'out')::integer,
           count(*) filter (where counted.what = 'discharged')::integer,
           count(*) filter (where counted.what = 'died')::integer,
           count(*) filter (where counted.what = 'waiting')::integer,
           count(*) filter (where counted.what = 'midnight')::integer
      from counted
     group by counted.ward_id
  $fn$;

  -- Route 10: request an admission (Q184 A, Q185 A, Q-ADT-9 A, Q-ADT-18 A).
  create function ehr.admission_request(requested_patient uuid, requested_source text, requested_from_encounter uuid,
    requested_ed_attendance uuid, requested_visit_queue_entry uuid, requested_reason text, requested_care_team text,
    requested_responsible uuid, requested_ward uuid, requested_mother_admission uuid, requested_idempotency_key text,
    requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    reason_value text := btrim(coalesce(requested_reason, ''));
    team_value text := nullif(btrim(coalesce(requested_care_team, '')), '');
    responsible_value uuid := requested_responsible;
    entry_value uuid;
    attendance_row ehr.ed_attendances%rowtype;
    refusal text;
    open_id uuid;
    encounter_value uuid;
    number_value bigint;
    year_value integer := extract(year from (clock_timestamp() at time zone 'Africa/Lagos'))::integer;
    new_id uuid;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.inpatient_caller('admission_decide', array['direct-care']);
    if requested_patient is null or requested_source is null
       or requested_source not in ('consultation', 'ed', 'waiting_list', 'direct')
       or (requested_source = 'consultation') <> (requested_from_encounter is not null)
       or (requested_source = 'ed') <> (requested_ed_attendance is not null)
       or (requested_source = 'waiting_list') <> (requested_visit_queue_entry is not null) then
      raise exception using errcode = '22023', message = 'ADMISSION_SOURCE_INVALID';
    end if;
    if length(reason_value) not between 1 and 300 or reason_value ~ '[[:cntrl:]]'
       or (requested_care_team is not null and (team_value is null or length(team_value) > 80
                                               or team_value ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.admission_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'requested' then
      perform ehr.inpatient_audit((select admission.patient_id from ehr.admissions admission
                                    where admission.id = key_state.admission_id),
        'ehr.admission.request', 'success', 'admission', key_state.admission_id::text,
        jsonb_build_object('replayed', true));
      return jsonb_build_object('outcome', 'created', 'replayed', true,
        'admission', (select card.card from ehr.admission_cards(array[key_state.admission_id], true) card));
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    end if;

    -- The patient: active, the facility's seal allows them, and the member can write in their chart now.
    if refusal is null and not exists (
         select 1 from identity.patients patient
          where patient.id = requested_patient and patient.status = 'active'
            and identity.sealed_demo_facility(caller.actor_facility) = identity.sealed_demo_patient(patient.id)
            and identity.sealed_qa_facility(caller.actor_facility) = identity.sealed_qa_patient(patient.id)) then
      refusal := 'chart_access_required';
    elsif refusal is null
          and not coalesce(ehr.context_allows(requested_patient, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    end if;

    if refusal is null then
      -- One open admission per patient per facility.
      perform pg_advisory_xact_lock(hashtextextended(
        'inpatient-admission:' || caller.actor_facility::text || ':' || requested_patient::text, 0));
      select admission.id into open_id from ehr.admissions admission
       where admission.facility_id = caller.actor_facility and admission.patient_id = requested_patient
         and admission.status in ('requested', 'admitted', 'discharge_ready');
      if open_id is not null then
        refusal := 'already_open';
      end if;
    end if;

    -- Where it comes from.
    if refusal is null and requested_source = 'consultation'
       and not exists (select 1 from ehr.encounters encounter
                        where encounter.id = requested_from_encounter and encounter.patient_id = requested_patient
                          and encounter.facility_id = caller.actor_facility
                          and encounter.status not in ('cancelled', 'entered_in_error')) then
      refusal := 'source_invalid';
    elsif refusal is null and requested_source = 'ed' then
      select attendance.* into attendance_row from ehr.ed_attendances attendance
       where attendance.id = requested_ed_attendance and attendance.facility_id = caller.actor_facility
         and attendance.patient_id = requested_patient
       for update;
      if not found or attendance_row.status <> 'decided'
         or attendance_row.disposition_outcome is distinct from 'admit_requested' then
        refusal := 'source_invalid';
      else
        entry_value := attendance_row.visit_queue_entry_id;
        responsible_value := coalesce(responsible_value, attendance_row.admitting_membership_id);
      end if;
    elsif refusal is null and requested_source = 'waiting_list' then
      select entry.id into entry_value from ehr.visit_queue entry
       where entry.id = requested_visit_queue_entry and entry.facility_id = caller.actor_facility
         and entry.patient_id = requested_patient and entry.closed_at is null;
      if entry_value is null then
        refusal := 'source_invalid';
      end if;
    end if;
    if refusal is null and (responsible_value is null
       or not ehr.inpatient_member_has_role(responsible_value, caller.actor_facility, array['doctor', 'clinician'])) then
      refusal := 'responsible_invalid';
    end if;
    if refusal is null and requested_ward is not null
       and not exists (select 1 from ehr.wards ward where ward.id = requested_ward
                        and ward.facility_id = caller.actor_facility and ward.active) then
      refusal := 'ward_not_found';
    end if;
    if refusal is null and requested_mother_admission is not null
       and not exists (select 1 from ehr.admissions mother
                        where mother.id = requested_mother_admission and mother.facility_id = caller.actor_facility
                          and mother.patient_id <> requested_patient
                          and mother.status in ('requested', 'admitted', 'discharge_ready')) then
      refusal := 'mother_invalid';
    end if;

    if refusal is not null then
      perform ehr.inpatient_audit(case when refusal in ('already_open', 'source_invalid', 'responsible_invalid',
                                                         'ward_not_found', 'mother_invalid') then requested_patient end,
        'ehr.admission.request', 'denied', 'admission', open_id::text,
        jsonb_build_object('refusal', refusal, 'source', requested_source));
      return jsonb_build_object('outcome', refusal, 'openAdmissionId', open_id);
    end if;

    -- The stay's encounter, planned, as the member (EHR-C1's create version row by 0004's trigger).
    insert into ehr.encounters (patient_id, facility_id, created_by, created_by_membership_id, encounter_type,
      status, started_at)
    values (requested_patient, caller.actor_facility, caller.actor_account, caller.actor_membership, 'inpatient',
      'planned', now_value)
    returning id into encounter_value;

    insert into ehr.admission_counters (facility_id, year) values (caller.actor_facility, year_value)
      on conflict (facility_id, year) do nothing;
    select counter.next_value into number_value from ehr.admission_counters counter
     where counter.facility_id = caller.actor_facility and counter.year = year_value for update;
    update ehr.admission_counters counter set next_value = number_value + 1
     where counter.facility_id = caller.actor_facility and counter.year = year_value;

    insert into ehr.admissions (facility_id, organization_id, patient_id, encounter_id, admission_number, source,
      ed_attendance_id, from_encounter_id, visit_queue_entry_id, mother_admission_id, reason, care_team,
      responsible_membership_id, requested_ward_id, requested_at, requested_by_membership_id,
      updated_by_membership_id, updated_at)
    values (caller.actor_facility, caller.actor_organization, requested_patient, encounter_value,
      'A-' || year_value::text || '-' || lpad(number_value::text, 6, '0'), requested_source,
      requested_ed_attendance, requested_from_encounter, entry_value, requested_mother_admission, reason_value,
      team_value, responsible_value, requested_ward, now_value, caller.actor_membership, caller.actor_membership,
      now_value)
    returning id into new_id;
    insert into ehr.admission_movements (admission_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, to_ward_id, details, idempotency_key, request_sha256)
    values (new_id, caller.actor_facility, requested_patient, 'requested', now_value, caller.actor_account,
      caller.actor_membership, requested_ward, jsonb_build_object('source', requested_source), requested_idempotency_key,
      requested_request_sha256);
    perform ehr.inpatient_audit(requested_patient, 'ehr.admission.request', 'success', 'admission', new_id::text,
      jsonb_build_object('source', requested_source, 'encounterId', encounter_value,
        'requestedWardId', requested_ward, 'newborn', requested_mother_admission is not null));
    return jsonb_build_object('outcome', 'created', 'replayed', false,
      'admission', (select card.card from ehr.admission_cards(array[new_id], true) card));
  end
  $fn$;
  comment on function ehr.admission_request(uuid, text, uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, text) is
    '0171 (ADT-1, Q184 A, Q-ADT-9 A, Q-ADT-18 A): request an admission from a visit, the emergency board (an ED record decided admit_requested; the responsible doctor defaults to its admitting doctor), the waiting list (an open row) or directly. Needs ehr.admission.decide and write access to the chart (ehr.context_allows). Makes the planned inpatient encounter at once. One open admission per patient per facility. Outcomes created (replayed), chart_access_required, already_open (with its id), source_invalid, responsible_invalid, ward_not_found, mother_invalid, key_reused. Audited (ehr.admission.request, with the source).';
  revoke all on function ehr.admission_request(uuid, text, uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, text)
    from public;

  -- Route 11: the admissions list.
  create function ehr.admission_list(requested_status text, requested_ward uuid, requested_ward_type text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    list_limit constant integer := 500;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    found_ids uuid[];
    shown_ids uuid[];
    more boolean;
    items jsonb;
    shown jsonb;
  begin
    select * into caller from ehr.inpatient_caller('ward_read', array['direct-care']);
    if (requested_status is not null
        and requested_status not in ('open', 'requested', 'admitted', 'discharge_ready', 'discharged', 'cancelled'))
       or (requested_ward_type is not null
           and requested_ward_type not in ('general', 'paediatric', 'maternity', 'icu', 'private', 'other')) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select array_agg(listed.id order by listed.waiting desc, lower(listed.ward_name) nulls first,
                     lower(listed.bed_name) nulls first, listed.requested_at, listed.id)
      into found_ids
      from (
        select admission.id, admission.status = 'requested' as waiting, ward.name as ward_name, bed.name as bed_name,
               admission.requested_at
          from ehr.admissions admission
          left join ehr.wards ward on ward.id = coalesce(admission.ward_id, admission.requested_ward_id)
          left join ehr.beds bed on bed.id = admission.bed_id
         where admission.facility_id = caller.actor_facility
           and (requested_ward is null or admission.ward_id = requested_ward
                or (admission.status = 'requested' and admission.requested_ward_id = requested_ward))
           and (requested_ward_type is null or ward.ward_type = requested_ward_type)
           and (case
                  when requested_status is null then
                    admission.status in ('requested', 'admitted', 'discharge_ready')
                    or (admission.status = 'discharged' and (admission.discharged_at at time zone 'Africa/Lagos')::date = today)
                    or (admission.status = 'cancelled' and (admission.cancelled_at at time zone 'Africa/Lagos')::date = today)
                  when requested_status = 'open' then admission.status in ('requested', 'admitted', 'discharge_ready')
                  else admission.status = requested_status end)
         order by 2 desc, lower(ward.name) nulls first, lower(bed.name) nulls first, admission.requested_at, admission.id
         limit list_limit + 1
      ) listed;
    more := coalesce(cardinality(found_ids), 0) > list_limit;
    shown_ids := coalesce(found_ids[1:list_limit], array[]::uuid[]);
    select coalesce(jsonb_agg(card.card order by card.ord), '[]'::jsonb),
           coalesce(jsonb_agg(jsonb_build_object('patientId', card.patient_id, 'admissionId', card.admission_id,
             'nameShown', card.name_shown) order by card.ord), '[]'::jsonb)
      into items, shown
      from ehr.admission_cards(shown_ids, caller.can_read_admission) card;
    perform ehr.inpatient_audit(null, 'ehr.admission.list', 'success', 'admission-list', null,
      jsonb_build_object('status', requested_status, 'wardId', requested_ward, 'wardType', requested_ward_type,
        'resultCount', cardinality(shown_ids), 'hasMore', more,
        'patientIds', coalesce((select jsonb_agg(distinct listed->'patientId') from jsonb_array_elements(shown) listed),
                               '[]'::jsonb)));
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    )
    select caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
           caller.actor_organization, caller.actor_facility, (item.value->>'patientId')::uuid,
           'ehr.admission.list.shown', 'success', 'admission', item.value->>'admissionId', caller.actor_purpose,
           'application', 'ehr-api', jsonb_build_object('nameShown', (item.value->>'nameShown')::boolean)
      from jsonb_array_elements(shown) with ordinality item(value, ord)
     order by item.ord;
    return jsonb_build_object('items', items, 'hasMore', more, 'limit', list_limit);
  end
  $fn$;
  comment on function ehr.admission_list(text, uuid, text) is
    '0171 (ADT-1): this facility''s admissions: by default the open ones and those discharged or cancelled today (Lagos); or one status; in one ward, or in wards of one type (icu is the ICU page). Waiting for a bed first, then ward, then bed. At most 500, has_more beyond. Needs ehr.ward.read, for direct care; the reason only with ehr.admission.read. Audited: one ehr.admission.list row with the patient ids shown and one ehr.admission.list.shown row per patient.';
  revoke all on function ehr.admission_list(text, uuid, text) from public;

  -- Route 12: one admission with its movements (never the handover text).
  create function ehr.admission_read(requested_admission uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
  begin
    select * into caller from ehr.inpatient_caller('ward_read', array['direct-care']);
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility;
    if not found then
      perform ehr.inpatient_audit(null, 'ehr.admission.read', 'failure', 'admission', requested_admission::text,
        jsonb_build_object('refusal', 'not_found'));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.read', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('status', admission_row.status));
    return jsonb_build_object('outcome', 'found',
      'admission', (select card.card from ehr.admission_cards(array[admission_row.id], caller.can_read_admission) card),
      'movements', coalesce((select jsonb_agg(jsonb_build_object('movementId', movement.id, 'kind', movement.kind,
          'at', movement.at, 'byMembershipId', movement.by_membership_id, 'fromWardId', movement.from_ward_id,
          'fromBedId', movement.from_bed_id, 'toWardId', movement.to_ward_id, 'toBedId', movement.to_bed_id,
          'handoverRecorded', movement.handover is not null,
          'outcome', movement.details->>'outcome', 'printNumber', (movement.details->>'printNumber')::integer,
          'reprintReason', movement.details->>'reprintReason') order by movement.sequence_no)
        from ehr.admission_movements movement where movement.admission_id = admission_row.id), '[]'::jsonb));
  end
  $fn$;
  comment on function ehr.admission_read(uuid) is
    '0171 (ADT-1): one admission of this facility with its movements (whether a handover was recorded, never its text). Needs ehr.ward.read. Audited (ehr.admission.read).';
  revoke all on function ehr.admission_read(uuid) from public;

  -- Route 13: "Admit and allocate bed" (Q185 A: nurses, clinicians and doctors; Q-ADT-11 A: no chart access).
  create function ehr.admission_admit(requested_admission uuid, requested_row_version bigint, requested_bed uuid,
    requested_confirm_sex boolean, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    admission_row ehr.admissions%rowtype;
    bed_row ehr.beds%rowtype;
    attendance_row ehr.ed_attendances%rowtype;
    entry_row ehr.visit_queue%rowtype;
    refusal text;
    mismatch boolean := false;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.inpatient_caller('bed_allocate', array['direct-care']);
    if requested_admission is null or requested_row_version is null or requested_bed is null then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.admission_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'admitted' and key_state.admission_id = requested_admission then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'admission', (select card.card from ehr.admission_cards(array[requested_admission], caller.can_read_admission) card));
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif admission_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif admission_row.status <> 'requested' then
      refusal := 'state_invalid';
    end if;
    if refusal is null then
      select bed.* into bed_row from ehr.beds bed
       where bed.id = requested_bed and bed.facility_id = caller.actor_facility and bed.active
         and exists (select 1 from ehr.wards ward where ward.id = bed.ward_id and ward.active)
       for update;
      if not found then
        refusal := 'bed_not_found';
      elsif bed_row.status <> 'available' then
        refusal := 'bed_not_available';
      else
        mismatch := ehr.admission_sex_mismatch(bed_row.ward_id, admission_row.patient_id);
        if mismatch and not coalesce(requested_confirm_sex, false) then
          refusal := 'sex_mismatch';
        end if;
      end if;
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.admit',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal, 'bedId', requested_bed));
      return jsonb_build_object('outcome', refusal);
    end if;
    if mismatch then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.sex-mismatch-confirmed', 'success',
        'admission', admission_row.id::text, jsonb_build_object('wardId', bed_row.ward_id, 'step', 'admit'));
    end if;

    perform ehr.admission_bed_move(bed_row.id, 'occupied', 'admission');
    update ehr.admissions admission
       set status = 'admitted', admitted_at = now_value, admitted_by_membership_id = caller.actor_membership,
           ward_id = bed_row.ward_id, bed_id = bed_row.id,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = admission.row_version + 1
     where admission.id = admission_row.id;
    perform ehr.admission_encounter_move(admission_row.encounter_id, 'in_progress', null,
      'Admitted to a bed (ADT-1)');

    -- Q-ADT-18 A: the ED record closes by itself and its waiting-list row finishes.
    if admission_row.source = 'ed' then
      select attendance.* into attendance_row from ehr.ed_attendances attendance
       where attendance.id = admission_row.ed_attendance_id for update;
      if found and attendance_row.status <> 'closed' then
        select entry.* into entry_row from ehr.visit_queue entry
         where entry.id = attendance_row.visit_queue_entry_id for update;
        if entry_row.closed_at is null then
          perform set_config('hid.ed_board_closing', entry_row.id::text, true);
          update ehr.visit_queue entry
             set stage = 'finished', stage_changed_at = now_value, closed_at = now_value,
                 updated_by_membership_id = caller.actor_membership, updated_at = now_value,
                 row_version = entry.row_version + 1
           where entry.id = entry_row.id;
          perform set_config('hid.ed_board_closing', '', true);
        end if;
        update ehr.ed_attendances attendance
           set status = 'closed', left_at = now_value, closed_via = 'admission',
               updated_by_membership_id = caller.actor_membership, updated_at = now_value,
               row_version = attendance.row_version + 1
         where attendance.id = attendance_row.id;
        insert into ehr.ed_attendance_events (attendance_id, facility_id, patient_id, kind, at, by_account_id,
          by_membership_id, from_stage, to_stage, idempotency_key, request_sha256)
        values (attendance_row.id, caller.actor_facility, admission_row.patient_id, 'admitted', now_value,
          caller.actor_account, caller.actor_membership, entry_row.stage, 'finished', requested_idempotency_key,
          requested_request_sha256);
      end if;
    elsif admission_row.source = 'waiting_list' then
      select entry.* into entry_row from ehr.visit_queue entry
       where entry.id = admission_row.visit_queue_entry_id for update;
      if found and entry_row.closed_at is null then
        update ehr.visit_queue entry
           set stage = 'finished', stage_changed_at = now_value, closed_at = now_value,
               updated_by_membership_id = caller.actor_membership, updated_at = now_value,
               row_version = entry.row_version + 1
         where entry.id = entry_row.id;
      end if;
    end if;

    insert into ehr.admission_movements (admission_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, to_ward_id, to_bed_id, details, idempotency_key, request_sha256)
    values (admission_row.id, caller.actor_facility, admission_row.patient_id, 'admitted', now_value,
      caller.actor_account, caller.actor_membership, bed_row.ward_id, bed_row.id,
      jsonb_build_object('sexMismatchConfirmed', mismatch), requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.admit', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('wardId', bed_row.ward_id, 'bedId', bed_row.id,
        'source', admission_row.source, 'sexMismatchConfirmed', mismatch));
    return jsonb_build_object('outcome', 'updated', 'replayed', false,
      'admission', (select card.card from ehr.admission_cards(array[admission_row.id], caller.can_read_admission) card));
  end
  $fn$;
  comment on function ehr.admission_admit(uuid, bigint, uuid, boolean, text, text) is
    '0171 (ADT-1, Q185 A, Q186 A, Q-ADT-11 A, Q-ADT-18 A): give a requested admission a free bed or overflow space of an active ward here: the admission admitted, the bed occupied, the encounter in progress; an ED record closes (closed_via admission) and its waiting-list row finishes; a waiting-list row finishes. A ward that takes one sex and a patient of the other needs the confirmation (audited). Needs ehr.bed.allocate; no chart access. Outcomes updated (replayed), not_found, changed, state_invalid, bed_not_found, bed_not_available, sex_mismatch, key_reused. Audited (ehr.admission.admit).';
  revoke all on function ehr.admission_admit(uuid, bigint, uuid, boolean, text, text) from public;

  -- Route 14: "Transfer bed", with an optional nursing handover (clinical: needs chart write access).
  create function ehr.admission_transfer(requested_admission uuid, requested_row_version bigint, requested_bed uuid,
    requested_handover text, requested_confirm_sex boolean, requested_idempotency_key text,
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
    old_bed ehr.beds%rowtype;
    new_bed ehr.beds%rowtype;
    handover_value text := nullif(btrim(coalesce(requested_handover, '')), '');
    refusal text;
    mismatch boolean := false;
    ended integer;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.inpatient_caller('bed_allocate', array['direct-care']);
    if requested_admission is null or requested_row_version is null or requested_bed is null
       or (requested_handover is not null and (handover_value is null or length(handover_value) > 2000)) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.admission_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'transferred' and key_state.admission_id = requested_admission then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'admission', (select card.card from ehr.admission_cards(array[requested_admission], caller.can_read_admission) card));
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif admission_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif admission_row.status not in ('admitted', 'discharge_ready') or admission_row.bed_id = requested_bed then
      refusal := 'state_invalid';
    elsif handover_value is not null
          and not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    end if;
    if refusal is null then
      -- The beds, in id order.
      perform 1 from ehr.beds bed where bed.id in (admission_row.bed_id, requested_bed) order by bed.id for update;
      select bed.* into old_bed from ehr.beds bed where bed.id = admission_row.bed_id;
      select bed.* into new_bed from ehr.beds bed
       where bed.id = requested_bed and bed.facility_id = caller.actor_facility and bed.active
         and exists (select 1 from ehr.wards ward where ward.id = bed.ward_id and ward.active);
      if not found then
        refusal := 'bed_not_found';
      elsif new_bed.status <> 'available' then
        refusal := 'bed_not_available';
      else
        mismatch := ehr.admission_sex_mismatch(new_bed.ward_id, admission_row.patient_id);
        if mismatch and not coalesce(requested_confirm_sex, false) then
          refusal := 'sex_mismatch';
        end if;
      end if;
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.transfer',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal, 'bedId', requested_bed, 'handoverGiven', handover_value is not null));
      return jsonb_build_object('outcome', refusal);
    end if;
    if mismatch then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.sex-mismatch-confirmed', 'success',
        'admission', admission_row.id::text, jsonb_build_object('wardId', new_bed.ward_id, 'step', 'transfer'));
    end if;

    perform ehr.admission_bed_move(old_bed.id, 'cleaning', 'transfer');
    perform ehr.admission_bed_move(new_bed.id, 'occupied', 'transfer');
    update ehr.admissions admission
       set ward_id = new_bed.ward_id, bed_id = new_bed.id,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = admission.row_version + 1
     where admission.id = admission_row.id;
    insert into ehr.admission_movements (admission_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_ward_id, from_bed_id, to_ward_id, to_bed_id, handover, details, idempotency_key,
      request_sha256)
    values (admission_row.id, caller.actor_facility, admission_row.patient_id, 'transferred', now_value,
      caller.actor_account, caller.actor_membership, old_bed.ward_id, old_bed.id, new_bed.ward_id, new_bed.id,
      handover_value, jsonb_build_object('sexMismatchConfirmed', mismatch), requested_idempotency_key,
      requested_request_sha256);
    ended := ehr.admission_stay_ended(admission_row.id, 'transfer');
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.transfer', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('fromWardId', old_bed.ward_id, 'fromBedId', old_bed.id,
        'toWardId', new_bed.ward_id, 'toBedId', new_bed.id, 'handoverGiven', handover_value is not null,
        'sexMismatchConfirmed', mismatch));
    return jsonb_build_object('outcome', 'updated', 'replayed', false,
      'admission', (select card.card from ehr.admission_cards(array[admission_row.id], caller.can_read_admission) card));
  end
  $fn$;
  comment on function ehr.admission_transfer(uuid, bigint, uuid, text, boolean, text, text) is
    '0171 (ADT-1): move an admitted or discharge-ready patient to a free bed of any active ward here, ICU included: the old bed goes to cleaning, the new one is occupied, every movement is kept. The nursing handover (1-2000) is clinical: it needs chart write access and is read only through ehr.admission_handover_read. Ward-team grants of members not on the new ward end 2 hours later (0173). Needs ehr.bed.allocate. Outcomes updated (replayed), not_found, changed, state_invalid, chart_access_required, bed_not_found, bed_not_available, sex_mismatch, key_reused. Audited (ehr.admission.transfer: whether a handover was given).';
  revoke all on function ehr.admission_transfer(uuid, bigint, uuid, text, boolean, text, text) from public;

  -- The handover text of a transfer, for members who can read the chart.
  create function ehr.admission_handover_read(requested_admission uuid, requested_movement uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
    movement_row ehr.admission_movements%rowtype;
  begin
    select * into caller from ehr.inpatient_caller('admission_read', array['direct-care']);
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility;
    select movement.* into movement_row from ehr.admission_movements movement
     where movement.id = requested_movement and movement.admission_id = admission_row.id
       and movement.handover is not null;
    if admission_row.id is null or movement_row.id is null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.handover-read', 'failure', 'admission',
        requested_admission::text, jsonb_build_object('refusal', 'not_found', 'movementId', requested_movement));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    if not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'read_records'), false) then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.handover-read', 'denied', 'admission',
        admission_row.id::text, jsonb_build_object('refusal', 'chart_access_required', 'movementId', movement_row.id));
      return jsonb_build_object('outcome', 'chart_access_required');
    end if;
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.handover-read', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('movementId', movement_row.id));
    return jsonb_build_object('outcome', 'found', 'movementId', movement_row.id, 'handover', movement_row.handover,
      'at', movement_row.at, 'byMembershipId', movement_row.by_membership_id);
  end
  $fn$;
  comment on function ehr.admission_handover_read(uuid, uuid) is
    '0171 (ADT-1, Q-ADT-11 A): the nursing handover text of a transfer, only for a member who can read the patient''s chart now. Needs ehr.admission.read. Audited (ehr.admission.handover-read; never the text).';
  revoke all on function ehr.admission_handover_read(uuid, uuid) from public;

  -- Route 15: "Prepare discharge" (clinical).
  create function ehr.admission_prepare_discharge(requested_admission uuid, requested_row_version bigint,
    requested_follow_up text, requested_expected_on date, requested_medicines uuid[], requested_idempotency_key text,
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
    plan_value text := btrim(coalesce(requested_follow_up, ''));
    medicines uuid[] := coalesce((select array_agg(distinct medicine) from unnest(requested_medicines) medicine
                                   where medicine is not null), array[]::uuid[]);
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.inpatient_caller('admission_decide', array['direct-care']);
    if requested_admission is null or requested_row_version is null
       or length(plan_value) not between 1 and 2000 or cardinality(medicines) > 50 then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.admission_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'prepared' and key_state.admission_id = requested_admission then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'admission', (select card.card from ehr.admission_cards(array[requested_admission], true) card));
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif admission_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif admission_row.status not in ('admitted', 'discharge_ready') then
      refusal := 'state_invalid';
    elsif not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    elsif requested_expected_on is not null
          and (requested_expected_on < (admission_row.admitted_at at time zone 'Africa/Lagos')::date
               or requested_expected_on > (now_value at time zone 'Africa/Lagos')::date + 365) then
      refusal := 'expected_date_invalid';
    elsif exists (select 1 from unnest(medicines) medicine
                   where not exists (select 1 from ehr.prescriptions prescription
                                      where prescription.id = medicine
                                        and prescription.encounter_id = admission_row.encounter_id
                                        and prescription.patient_id = admission_row.patient_id
                                        and prescription.facility_id = caller.actor_facility
                                        and prescription.status not in ('cancelled', 'entered_in_error'))) then
      refusal := 'medicines_invalid';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.prepare-discharge',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    update ehr.admissions admission
       set status = 'discharge_ready', follow_up_plan = plan_value,
           expected_discharge_on = coalesce(requested_expected_on, admission.expected_discharge_on),
           prepared_at = now_value, prepared_by_membership_id = caller.actor_membership,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = admission.row_version + 1
     where admission.id = admission_row.id;
    delete from ehr.admission_discharge_medicines medicine where medicine.admission_id = admission_row.id;
    insert into ehr.admission_discharge_medicines (admission_id, prescription_id, patient_id, facility_id)
    select admission_row.id, medicine, admission_row.patient_id, caller.actor_facility from unnest(medicines) medicine;
    insert into ehr.admission_movements (admission_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, details, idempotency_key, request_sha256)
    values (admission_row.id, caller.actor_facility, admission_row.patient_id, 'prepared', now_value,
      caller.actor_account, caller.actor_membership,
      jsonb_build_object('medicines', cardinality(medicines), 'again', admission_row.status = 'discharge_ready'),
      requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.prepare-discharge', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('medicines', cardinality(medicines),
        'again', admission_row.status = 'discharge_ready'));
    return jsonb_build_object('outcome', 'updated', 'replayed', false,
      'admission', (select card.card from ehr.admission_cards(array[admission_row.id], true) card));
  end
  $fn$;
  comment on function ehr.admission_prepare_discharge(uuid, bigint, text, date, uuid[], text, text) is
    '0171 (ADT-1): "Prepare discharge": the follow-up plan (1-2000), the expected discharge date and the medicines on discharge (0-50 of the stay''s prescriptions, replaced as a set). From admitted to discharge_ready; can be sent again while discharge_ready. Needs ehr.admission.decide and chart write access. Outcomes updated (replayed), not_found, changed, state_invalid, chart_access_required, expected_date_invalid, medicines_invalid, key_reused. Audited (ehr.admission.prepare-discharge).';
  revoke all on function ehr.admission_prepare_discharge(uuid, bigint, text, date, uuid[], text, text) from public;

  -- Route 16: "Discharge patient" (Q187 A, Q-ADT-12 A). Never reads a bill (Q189 A).
  create function ehr.admission_discharge(requested_admission uuid, requested_row_version bigint,
    requested_outcome text, requested_discharged_at timestamptz, requested_summary jsonb,
    requested_referred_to text, requested_died_at timestamptz, requested_signature text,
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
    refusal text;
    now_value timestamptz := clock_timestamp();
    discharged_value timestamptz;
    referral_value text := nullif(btrim(coalesce(requested_referred_to, '')), '');
    summary_value jsonb;
    condition_value text;
    field text;
    note_value uuid;
    content_value text;
    diagnoses_value jsonb;
    medicines_value jsonb;
    ended integer;
  begin
    select * into caller from ehr.inpatient_caller('admission_decide', array['direct-care']);
    if requested_admission is null or requested_row_version is null or requested_outcome is null
       or requested_outcome not in ('routine', 'dama', 'referred_out', 'absconded', 'died')
       or (requested_summary is not null and jsonb_typeof(requested_summary) <> 'object')
       or (requested_outcome = 'referred_out') <> (referral_value is not null)
       or (referral_value is not null and (length(referral_value) not between 2 and 120
                                          or referral_value ~ '[[:cntrl:]]'))
       or (requested_outcome <> 'died' and requested_died_at is not null) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    if requested_summary is null and requested_outcome in ('routine', 'dama', 'referred_out') then
      raise exception using errcode = '22023', message = 'DISCHARGE_SUMMARY_REQUIRED';
    end if;
    if requested_outcome = 'died' and requested_died_at is null then
      raise exception using errcode = '22023', message = 'DIED_AT_REQUIRED';
    end if;
    if requested_signature is null or upper(btrim(requested_signature)) <> 'SIGN' then
      raise exception using errcode = '22023', message = 'SIGNATURE_REQUIRED';
    end if;
    if requested_summary is not null then
      if exists (select 1 from jsonb_object_keys(requested_summary) summary_key
                  where summary_key not in ('presentingProblem', 'courseInHospital', 'proceduresDone',
                                            'conditionAtDischarge', 'followUpPlan', 'patientAdvice')) then
        raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
      end if;
      foreach field in array array['presentingProblem', 'courseInHospital', 'proceduresDone', 'followUpPlan',
                                   'patientAdvice'] loop
        if requested_summary ? field and (jsonb_typeof(requested_summary->field) <> 'string'
                                          or char_length(requested_summary->>field) > 4000) then
          raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
        end if;
      end loop;
      if length(btrim(coalesce(requested_summary->>'presentingProblem', ''))) = 0
         or length(btrim(coalesce(requested_summary->>'courseInHospital', ''))) = 0 then
        raise exception using errcode = '22023', message = 'DISCHARGE_SUMMARY_REQUIRED';
      end if;
      condition_value := coalesce(requested_summary->>'conditionAtDischarge', 'not_applicable');
      if condition_value not in ('improved', 'unchanged', 'worse', 'not_applicable') then
        raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
      end if;
    end if;
    select * into key_state from ehr.admission_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'discharged' and key_state.admission_id = requested_admission then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'summaryNoteId', (select admission.summary_note_id from ehr.admissions admission
                           where admission.id = requested_admission),
        'admission', (select card.card from ehr.admission_cards(array[requested_admission], true) card));
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for update;
    discharged_value := coalesce(requested_discharged_at, now_value);
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif admission_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif admission_row.status not in ('admitted', 'discharge_ready') then
      refusal := 'state_invalid';
    elsif requested_outcome in ('routine', 'referred_out') and admission_row.status <> 'discharge_ready' then
      refusal := 'not_prepared';
    elsif not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    elsif discharged_value > now_value + interval '2 minutes' or discharged_value < admission_row.admitted_at
          or discharged_value < now_value - interval '24 hours'
          or (requested_died_at is not null
              and (requested_died_at > now_value + interval '2 minutes' or requested_died_at < admission_row.admitted_at)) then
      refusal := 'time_invalid';
    end if;
    discharged_value := least(discharged_value, now_value);
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.discharge',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal, 'outcome', requested_outcome));
      return jsonb_build_object('outcome', refusal);
    end if;

    perform 1 from ehr.beds bed where bed.id = admission_row.bed_id for update;
    perform ehr.admission_bed_move(admission_row.bed_id, 'cleaning', 'discharge');

    -- The summary, as a signed clinical note of the stay's encounter (as EHR-C5 writes a consultation note): the
    -- text, the stay's diagnoses now, and the medicines on discharge.
    if requested_summary is not null then
      select coalesce(jsonb_agg(jsonb_build_object('display', diagnosis.display, 'code', diagnosis.code,
               'codeSystem', diagnosis.code_system) order by diagnosis.created_at, diagnosis.id), '[]'::jsonb)
        into diagnoses_value
        from ehr.diagnoses diagnosis
       where diagnosis.encounter_id = admission_row.encounter_id and diagnosis.patient_id = admission_row.patient_id
         and diagnosis.verification_status not in ('refuted', 'entered_in_error');
      select coalesce(jsonb_agg(jsonb_build_object('prescriptionId', prescription.id,
               'medicationDisplay', prescription.medication_display, 'strength', prescription.medication_strength,
               'doseForm', prescription.medication_dose_form,
               'dose', case when prescription.dose_quantity is null then null
                            else trim(trailing '.' from trim(trailing '0' from prescription.dose_quantity::text))
                                 || ' ' || prescription.dose_unit end,
               'frequency', prescription.frequency,
               'duration', case when prescription.duration_value is null then null
                                else prescription.duration_value::text || ' ' || prescription.duration_unit
                                     || case when prescription.duration_value > 1 then 's' else '' end end)
               order by prescription.created_at, prescription.id), '[]'::jsonb)
        into medicines_value
        from ehr.admission_discharge_medicines medicine
        join ehr.prescriptions prescription on prescription.id = medicine.prescription_id
       where medicine.admission_id = admission_row.id;
      summary_value := jsonb_build_object(
        'presentingProblem', btrim(requested_summary->>'presentingProblem'),
        'courseInHospital', btrim(requested_summary->>'courseInHospital'),
        'proceduresDone', nullif(btrim(coalesce(requested_summary->>'proceduresDone', '')), ''),
        'conditionAtDischarge', condition_value,
        'followUpPlan', coalesce(nullif(btrim(coalesce(requested_summary->>'followUpPlan', '')), ''),
                                 admission_row.follow_up_plan),
        'patientAdvice', nullif(btrim(coalesce(requested_summary->>'patientAdvice', '')), ''),
        'diagnoses', diagnoses_value, 'medicinesOnDischarge', medicines_value);
      content_value := concat_ws(E'\n',
        'Discharge summary (' || admission_row.admission_number || ')',
        'Outcome: ' || case requested_outcome when 'routine' then 'Routine discharge'
          when 'dama' then 'Discharged against medical advice' when 'referred_out' then 'Referred out'
          when 'absconded' then 'Absconded' else 'Died' end,
        'Admitted: ' || to_char(admission_row.admitted_at at time zone 'Africa/Lagos', 'DD Mon YYYY HH24:MI'),
        'Discharged: ' || to_char(discharged_value at time zone 'Africa/Lagos', 'DD Mon YYYY HH24:MI'),
        case when referral_value is not null then 'Referred to: ' || referral_value end,
        'Presenting problem: ' || (summary_value->>'presentingProblem'),
        'Course in hospital: ' || (summary_value->>'courseInHospital'),
        case when summary_value->>'proceduresDone' is not null then 'Procedures done: ' || (summary_value->>'proceduresDone') end,
        'Condition at discharge: ' || replace(initcap(replace(condition_value, '_', ' ')), 'Not Applicable', 'Not applicable'),
        case when summary_value->>'followUpPlan' is not null then 'Follow-up plan: ' || (summary_value->>'followUpPlan') end,
        case when summary_value->>'patientAdvice' is not null then 'Advice: ' || (summary_value->>'patientAdvice') end,
        case when jsonb_array_length(diagnoses_value) > 0 then 'Diagnoses: ' || (select string_agg(
          item->>'display' || coalesce(' (' || (item->>'codeSystem') || ' ' || (item->>'code') || ')', ''), '; ')
          from jsonb_array_elements(diagnoses_value) item) end,
        case when jsonb_array_length(medicines_value) > 0 then 'Medicines on discharge: ' || (select string_agg(
          concat_ws(' ', item->>'medicationDisplay', item->>'strength', item->>'doseForm',
            case when item->>'dose' is not null then '- ' || (item->>'dose') end, item->>'frequency',
            case when item->>'duration' is not null then 'for ' || (item->>'duration') end), '; ')
          from jsonb_array_elements(medicines_value) item) end);
      insert into ehr.clinical_notes (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
        note_type, title, status, signed_at, signed_by)
      values (admission_row.encounter_id, admission_row.patient_id, caller.actor_facility, caller.actor_account,
        caller.actor_membership, 'Discharge summary', 'Discharge summary', 'signed', now_value, caller.actor_account)
      returning id into note_value;
      insert into ehr.clinical_note_revisions (clinical_note_id, patient_id, facility_id, revision_no, content,
        change_reason, supersedes_revision_no, created_by, created_by_membership_id)
      values (note_value, admission_row.patient_id, caller.actor_facility, 1, content_value, 'initial clinical note',
        null, caller.actor_account, caller.actor_membership);
    end if;

    update ehr.admissions admission
       set status = 'discharged', outcome = requested_outcome, discharged_at = discharged_value,
           discharged_by_membership_id = caller.actor_membership, summary_note_id = note_value,
           discharge_summary = summary_value, referred_to_facility_name = referral_value,
           died_at = case when requested_outcome = 'died' then least(requested_died_at, now_value) end,
           ward_id = null, bed_id = null,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = admission.row_version + 1
     where admission.id = admission_row.id;
    perform ehr.admission_encounter_move(admission_row.encounter_id, 'completed',
      greatest(discharged_value, (select encounter.started_at from ehr.encounters encounter
                                   where encounter.id = admission_row.encounter_id)),
      'Discharged from the ward (ADT-1)');
    insert into ehr.admission_movements (admission_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, from_ward_id, from_bed_id, details, idempotency_key, request_sha256)
    values (admission_row.id, caller.actor_facility, admission_row.patient_id, 'discharged', now_value,
      caller.actor_account, caller.actor_membership, admission_row.ward_id, admission_row.bed_id,
      jsonb_build_object('outcome', requested_outcome, 'summaryWritten', note_value is not null),
      requested_idempotency_key, requested_request_sha256);
    ended := ehr.admission_stay_ended(admission_row.id, 'discharge');
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.discharge', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('outcome', requested_outcome, 'summaryNoteId', note_value,
        'wardId', admission_row.ward_id, 'bedId', admission_row.bed_id, 'wardStayGrantsEnded', ended));
    return jsonb_build_object('outcome', 'updated', 'replayed', false, 'summaryNoteId', note_value,
      'admission', (select card.card from ehr.admission_cards(array[admission_row.id], true) card));
  end
  $fn$;
  comment on function ehr.admission_discharge(uuid, bigint, text, timestamptz, jsonb, text, timestamptz, text, text, text) is
    '0171 (ADT-1, Q187 A, Q189 A, Q-ADT-12 A): "Discharge patient" with an outcome: routine or referred_out only from discharge_ready (not_prepared); dama, absconded and died also from admitted. The summary (required for routine, dama and referred_out) is written as a signed clinical note "Discharge summary" of the stay''s encounter with the stay''s diagnoses and the medicines on discharge; the bed goes to cleaning; the encounter is completed; the stay''s ward-team grants end (0173). died records the outcome and the time of death only. The typed word SIGN. Never reads a bill: no balance, deposit or setting can refuse or delay it. Needs ehr.admission.decide and chart write access. Outcomes updated (replayed), not_found, changed, state_invalid, not_prepared, chart_access_required, time_invalid, key_reused. Audited (ehr.admission.discharge, with the outcome).';
  revoke all on function ehr.admission_discharge(uuid, bigint, text, timestamptz, jsonb, text, timestamptz, text, text, text)
    from public;

  -- Route 17: cancel a request (only while waiting for a bed). An ED record stays "Waiting for admission".
  create function ehr.admission_cancel(requested_admission uuid, requested_row_version bigint, requested_reason text,
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
    reason_value text := btrim(coalesce(requested_reason, ''));
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.inpatient_caller('admission_decide', array['direct-care']);
    if requested_admission is null or requested_row_version is null
       or length(reason_value) not between 8 and 500 or reason_value ~ '[\x01-\x09\x0b-\x1f\x7f]' then
      raise exception using errcode = '22023', message = 'INPATIENT_REASON_REQUIRED';
    end if;
    select * into key_state from ehr.admission_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'cancelled' and key_state.admission_id = requested_admission then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'admission', (select card.card from ehr.admission_cards(array[requested_admission], true) card));
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif admission_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif admission_row.status <> 'requested' then
      refusal := 'state_invalid';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.cancel',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    update ehr.admissions admission
       set status = 'cancelled', cancelled_at = now_value, cancel_reason = reason_value,
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = admission.row_version + 1
     where admission.id = admission_row.id;
    perform ehr.admission_encounter_move(admission_row.encounter_id, 'cancelled', null,
      'Admission request cancelled (ADT-1)');
    insert into ehr.admission_movements (admission_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, details, idempotency_key, request_sha256)
    values (admission_row.id, caller.actor_facility, admission_row.patient_id, 'cancelled', now_value,
      caller.actor_account, caller.actor_membership, '{}'::jsonb, requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.cancel', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('source', admission_row.source));
    return jsonb_build_object('outcome', 'updated', 'replayed', false,
      'admission', (select card.card from ehr.admission_cards(array[admission_row.id], true) card));
  end
  $fn$;
  comment on function ehr.admission_cancel(uuid, bigint, text, text, text) is
    '0171 (ADT-1): cancel an admission request still waiting for a bed, with a reason (8-500; never audited). The encounter is cancelled; the request is kept; an ED record stays decided ("Waiting for admission"). Needs ehr.admission.decide. Outcomes updated (replayed), not_found, changed, state_invalid, key_reused. Audited (ehr.admission.cancel).';
  revoke all on function ehr.admission_cancel(uuid, bigint, text, text, text) from public;

  -- Route 18: change the care team, responsible doctor, expected discharge date or reason of an open admission.
  create function ehr.admission_update(requested_admission uuid, requested_row_version bigint,
    requested_care_team text, requested_responsible uuid, requested_expected_on date, requested_reason text,
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
    team_value text := nullif(btrim(coalesce(requested_care_team, '')), '');
    reason_value text := nullif(btrim(coalesce(requested_reason, '')), '');
    refusal text;
    now_value timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.inpatient_caller('admission_decide', array['direct-care']);
    if requested_admission is null or requested_row_version is null
       or (requested_care_team is not null and (team_value is null or length(team_value) > 80
                                               or team_value ~ '[[:cntrl:]]'))
       or (requested_reason is not null and (reason_value is null or length(reason_value) > 300
                                            or reason_value ~ '[[:cntrl:]]'))
       or (requested_care_team is null and requested_responsible is null and requested_expected_on is null
           and requested_reason is null) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.admission_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'details_changed'
       and key_state.admission_id = requested_admission then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'admission', (select card.card from ehr.admission_cards(array[requested_admission], true) card));
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif admission_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif admission_row.status not in ('requested', 'admitted', 'discharge_ready') then
      refusal := 'state_invalid';
    elsif requested_responsible is not null
          and not ehr.inpatient_member_has_role(requested_responsible, caller.actor_facility,
                                                array['doctor', 'clinician']) then
      refusal := 'responsible_invalid';
    elsif requested_expected_on is not null
          and (requested_expected_on < (coalesce(admission_row.admitted_at, admission_row.requested_at)
                                        at time zone 'Africa/Lagos')::date
               or requested_expected_on > (now_value at time zone 'Africa/Lagos')::date + 365) then
      refusal := 'expected_date_invalid';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.update',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    update ehr.admissions admission
       set care_team = coalesce(team_value, admission.care_team),
           responsible_membership_id = coalesce(requested_responsible, admission.responsible_membership_id),
           expected_discharge_on = coalesce(requested_expected_on, admission.expected_discharge_on),
           reason = coalesce(reason_value, admission.reason),
           updated_by_membership_id = caller.actor_membership, updated_at = now_value,
           row_version = admission.row_version + 1
     where admission.id = admission_row.id;
    insert into ehr.admission_movements (admission_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, details, idempotency_key, request_sha256)
    values (admission_row.id, caller.actor_facility, admission_row.patient_id, 'details_changed', now_value,
      caller.actor_account, caller.actor_membership,
      jsonb_build_object('careTeam', team_value is not null, 'responsible', requested_responsible is not null,
        'expectedDischargeOn', requested_expected_on is not null, 'reason', reason_value is not null),
      requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.admission.update', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('careTeamChanged', team_value is not null,
        'responsibleMembershipId', requested_responsible, 'expectedDischargeOnChanged', requested_expected_on is not null,
        'reasonChanged', reason_value is not null));
    return jsonb_build_object('outcome', 'updated', 'replayed', false,
      'admission', (select card.card from ehr.admission_cards(array[admission_row.id], true) card));
  end
  $fn$;
  comment on function ehr.admission_update(uuid, bigint, text, uuid, date, text, text, text) is
    '0171 (ADT-1): change an open admission''s care team, responsible doctor or clinician, expected discharge date or reason. Needs ehr.admission.decide. Outcomes updated (replayed), not_found, changed, state_invalid, responsible_invalid, expected_date_invalid, key_reused. Audited (ehr.admission.update; which fields changed, never their text).';
  revoke all on function ehr.admission_update(uuid, bigint, text, uuid, date, text, text, text) from public;

  -- Route 19: the printable discharge summary (chart read access).
  create function ehr.discharge_summary_print(requested_admission uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
    note_row ehr.clinical_notes%rowtype;
    printed timestamptz := clock_timestamp();
  begin
    select * into caller from ehr.inpatient_caller('admission_read', array['direct-care']);
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility
       and admission.status = 'discharged' and admission.summary_note_id is not null;
    if not found then
      perform ehr.inpatient_audit(null, 'ehr.discharge-summary.print', 'failure', 'admission',
        requested_admission::text, jsonb_build_object('refusal', 'not_found'));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    if not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'read_records'), false) then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.discharge-summary.print', 'denied', 'admission',
        admission_row.id::text, jsonb_build_object('refusal', 'chart_access_required'));
      return jsonb_build_object('outcome', 'chart_access_required');
    end if;
    select note.* into note_row from ehr.clinical_notes note where note.id = admission_row.summary_note_id;
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.discharge-summary.print', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('summaryNoteId', admission_row.summary_note_id));
    return jsonb_build_object('outcome', 'found', 'print', jsonb_build_object(
      'facility', (select jsonb_build_object('name', facility.name,
                     'address', nullif(concat_ws(', ', profile.address_line, profile.city), ''),
                     'phone', profile.phone_e164)
                     from identity.facilities facility
                     left join identity.facility_profiles profile on profile.facility_id = facility.id
                    where facility.id = caller.actor_facility),
      'patient', (select jsonb_build_object(
                    'fullName', case when unknown_record.patient_id is not null then 'Unknown patient ' || unknown_record.label
                                     else patient.full_name end,
                    'sex', patient.gender, 'dateOfBirth', patient.dob,
                    'dateOfBirthEstimated', unknown_record.patient_id is not null and patient.dob is not null,
                    'healthId', null, 'healthIdLast4', right(patient.hid_code, 4),
                    'ninStatus', case when exists (select 1 from identity.patient_identifiers identifier
                                                    where identifier.patient_id = patient.id
                                                      and identifier.identifier_type = 'nin' and identifier.verified
                                                      and identifier.revoked_at is null) then 'verified'
                                      else 'not_verified' end)
                    from identity.patients patient
                    left join identity.unknown_patients unknown_record
                      on unknown_record.patient_id = patient.id and unknown_record.status <> 'identified'
                   where patient.id = admission_row.patient_id),
      'admissionNumber', admission_row.admission_number, 'admittedAt', admission_row.admitted_at,
      'dischargedAt', admission_row.discharged_at,
      'wards', coalesce((select jsonb_agg(visited.name order by visited.first_at)
                           from (select ward.name, min(movement.sequence_no) as first_at
                                   from ehr.admission_movements movement
                                   join ehr.wards ward on ward.id = movement.to_ward_id
                                  where movement.admission_id = admission_row.id
                                    and movement.kind in ('admitted', 'transferred')
                                  group by ward.name) visited), '[]'::jsonb),
      'responsibleDoctor', (select staff.full_name from identity.staff_facility_memberships membership
                              join identity.staff staff on staff.id = membership.staff_id
                             where membership.id = admission_row.responsible_membership_id),
      'outcome', admission_row.outcome, 'referredToFacilityName', admission_row.referred_to_facility_name,
      'diedAt', admission_row.died_at,
      'summary', admission_row.discharge_summary - 'diagnoses' - 'medicinesOnDischarge',
      'diagnoses', coalesce(admission_row.discharge_summary->'diagnoses', '[]'::jsonb),
      'medicinesOnDischarge', coalesce(admission_row.discharge_summary->'medicinesOnDischarge', '[]'::jsonb),
      'signedBy', (select staff.full_name from identity.staff_facility_memberships membership
                     join identity.staff staff on staff.id = membership.staff_id
                    where membership.id = admission_row.discharged_by_membership_id),
      'signedAt', note_row.signed_at, 'printedAt', printed));
  end
  $fn$;
  comment on function ehr.discharge_summary_print(uuid) is
    '0171 (ADT-1): the printable discharge summary of a discharged admission of this facility, as signed: the facility, the patient (the Health ID''s last 4 characters only), the stay, the wards, the responsible doctor, the outcome, the summary, the diagnoses and medicines on discharge, who signed and when. Needs ehr.admission.read and chart read access. Each print is audited (ehr.discharge-summary.print).';
  revoke all on function ehr.discharge_summary_print(uuid) from public;

  -- Routes 20 and 21: the inpatient band and the newborn band (Q192 A, Q-ADT-16 A, Q-ADT-17 A).
  create function ehr.wristband_answer(requested_admission uuid, requested_kind text, print_value integer,
    printed_at timestamptz)
  returns jsonb
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    admission_row ehr.admissions%rowtype;
    mother_row ehr.admissions%rowtype;
    pair_value text;
    allergy boolean;
    answer jsonb;
  begin
    select admission.* into admission_row from ehr.admissions admission where admission.id = requested_admission;
    if admission_row.mother_admission_id is not null then
      select mother.* into mother_row from ehr.admissions mother where mother.id = admission_row.mother_admission_id;
      pair_value := mother_row.admission_number || ' / B' || (
        select count(*) from ehr.admissions sibling
         where sibling.mother_admission_id = mother_row.id and sibling.status <> 'cancelled'
           and (sibling.requested_at, sibling.id) <= (admission_row.requested_at, admission_row.id))::text;
    elsif exists (select 1 from ehr.admissions baby where baby.mother_admission_id = admission_row.id
                   and baby.status <> 'cancelled') then
      pair_value := admission_row.admission_number || ' / ' || (
        select string_agg('B' || ordinal::text, ', ' order by ordinal)
          from generate_series(1, (select count(*) from ehr.admissions baby
                                    where baby.mother_admission_id = admission_row.id
                                      and baby.status <> 'cancelled')::integer) ordinal);
    end if;
    perform set_config('hid.inpatient_band_patient', admission_row.patient_id::text, true);
    allergy := exists (select 1 from ehr.recorded_allergies allergy_row
                        where allergy_row.patient_id = admission_row.patient_id and allergy_row.status = 'active');
    perform set_config('hid.inpatient_band_patient', '', true);
    select jsonb_build_object(
      'fullName', case when unknown_record.patient_id is null then patient.full_name end,
      'unknownLabel', case when unknown_record.patient_id is not null then 'Unknown patient ' || unknown_record.label end,
      'sex', patient.gender, 'dateOfBirth', patient.dob,
      'ageEstimated', unknown_record.patient_id is not null,
      'healthId', patient.hid_code, 'admissionNumber', admission_row.admission_number,
      'facilityName', facility.name, 'wardName', ward.name, 'allergyAlert', allergy,
      'barcode', admission_row.admission_number, 'pairCode', pair_value,
      'printNumber', print_value, 'printedAt', printed_at)
      into answer
      from identity.patients patient
      join identity.facilities facility on facility.id = admission_row.facility_id
      left join ehr.wards ward on ward.id = admission_row.ward_id
      left join identity.unknown_patients unknown_record
        on unknown_record.patient_id = patient.id and unknown_record.status <> 'identified'
     where patient.id = admission_row.patient_id;
    if requested_kind = 'newborn' then
      answer := answer || jsonb_build_object(
        'motherName', (select case when unknown_record.patient_id is not null then 'Unknown patient ' || unknown_record.label
                                   else patient.full_name end
                         from identity.patients patient
                         left join identity.unknown_patients unknown_record
                           on unknown_record.patient_id = patient.id and unknown_record.status <> 'identified'
                        where patient.id = mother_row.patient_id),
        'motherAdmissionNumber', mother_row.admission_number, 'bornAt', null);
    end if;
    return answer;
  end
  $fn$;
  revoke all on function ehr.wristband_answer(uuid, text, integer, timestamptz) from public;

  create function ehr.wristband_print_for(requested_admission uuid, requested_kind text, requested_reprint_reason text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    admission_row ehr.admissions%rowtype;
    refusal text;
    print_value integer;
    action_value text := case when requested_kind = 'newborn' then 'ehr.newborn-band.print' else 'ehr.wristband.print' end;
    now_value timestamptz := clock_timestamp();
    answer jsonb;
  begin
    select * into caller from ehr.inpatient_caller('wristband', array['direct-care']);
    if requested_admission is null
       or (requested_reprint_reason is not null
           and requested_reprint_reason not in ('lost', 'damaged', 'details_changed', 'moved_ward')) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.admission_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'wristband_printed' and key_state.admission_id = requested_admission
       and key_state.details->>'kind' = requested_kind then
      return jsonb_build_object('outcome', 'printed', 'replayed', true,
        'band', ehr.wristband_answer(requested_admission, requested_kind, (key_state.details->>'printNumber')::integer,
          (select print_row.at from ehr.wristband_prints print_row
            where print_row.admission_id = requested_admission and print_row.kind = requested_kind
              and print_row.print_number = (key_state.details->>'printNumber')::integer)));
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif admission_row.status not in ('admitted', 'discharge_ready') then
      refusal := 'state_invalid';
    elsif requested_kind = 'newborn' and admission_row.mother_admission_id is null then
      refusal := 'mother_invalid';
    end if;
    if refusal is null then
      print_value := coalesce((select max(print_row.print_number) from ehr.wristband_prints print_row
                                where print_row.admission_id = admission_row.id and print_row.kind = requested_kind), 0) + 1;
      if print_value > 1 and requested_reprint_reason is null then
        refusal := 'reprint_reason_required';
      end if;
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, action_value,
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    answer := ehr.wristband_answer(admission_row.id, requested_kind, print_value, now_value);
    insert into ehr.wristband_prints (admission_id, facility_id, kind, print_number, reprint_reason, pair_code,
      by_membership_id, at)
    values (admission_row.id, caller.actor_facility, requested_kind, print_value,
      case when print_value > 1 then requested_reprint_reason end, answer->>'pairCode', caller.actor_membership,
      now_value);
    insert into ehr.admission_movements (admission_id, facility_id, patient_id, kind, at, by_account_id,
      by_membership_id, details, idempotency_key, request_sha256)
    values (admission_row.id, caller.actor_facility, admission_row.patient_id, 'wristband_printed', now_value,
      caller.actor_account, caller.actor_membership,
      jsonb_strip_nulls(jsonb_build_object('kind', requested_kind, 'printNumber', print_value,
        'reprintReason', case when print_value > 1 then requested_reprint_reason end)),
      requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(admission_row.patient_id, action_value, 'success', 'admission', admission_row.id::text,
      jsonb_strip_nulls(jsonb_build_object('printNumber', print_value,
        'reprintReason', case when print_value > 1 then requested_reprint_reason end,
        'paired', answer->>'pairCode' is not null)));
    return jsonb_build_object('outcome', 'printed', 'replayed', false, 'band', answer);
  end
  $fn$;
  revoke all on function ehr.wristband_print_for(uuid, text, text, text, text) from public;

  create function ehr.wristband_print(requested_admission uuid, requested_reprint_reason text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.wristband_print_for(requested_admission, 'inpatient', requested_reprint_reason,
      requested_idempotency_key, requested_request_sha256)
  $fn$;
  comment on function ehr.wristband_print(uuid, text, text, text) is
    '0171 (ADT-1, Q192 A, Q-ADT-16 A): the inpatient band of an admitted or discharge-ready patient: the name (or "Unknown patient U-0007"), sex, date of birth (or estimated age), the Health ID as text (this answer only, for printing; never logged or audited), the admission number (also the barcode), the facility and ward, the allergy alert (true when any active allergy is recorded; the names are not read out) and, for a mother with a linked newborn admission, the pair code. A reprint needs a reason (lost, damaged, details_changed, moved_ward). Needs ehr.wristband.print. Outcomes printed (replayed), not_found, state_invalid, reprint_reason_required, key_reused. Audited (ehr.wristband.print: print number and reprint reason).';
  revoke all on function ehr.wristband_print(uuid, text, text, text) from public;

  create function ehr.newborn_band_print(requested_admission uuid, requested_reprint_reason text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language sql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
    select ehr.wristband_print_for(requested_admission, 'newborn', requested_reprint_reason,
      requested_idempotency_key, requested_request_sha256)
  $fn$;
  comment on function ehr.newborn_band_print(uuid, text, text, text) is
    '0171 (ADT-1, Q192 A, Q-ADT-17 A): the newborn band of an admission linked to the mother''s (mother_invalid otherwise): as the inpatient band, plus the mother''s name and admission number and the pair code (the mother''s admission number and B1, B2...). The mother''s band is reprinted with the same pair code (ehr.wristband_print, reason details_changed). Needs ehr.wristband.print. Audited (ehr.newborn-band.print).';
  revoke all on function ehr.newborn_band_print(uuid, text, text, text) from public;

  -- Route 22: the death record (Q188 A), built and switched off. Every function refuses first while the
  -- death_record switch is off (DEATH_RECORD_NOT_AVAILABLE); then the caller needs ehr.death-record.write (no role
  -- holds it in this release) or, to read and print, ehr.admission.read; and chart access.
  create function ehr.death_record_gate(required_access text)
  returns record
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
  begin
    if not coalesce((select switch_row.enabled from ehr.inpatient_switches switch_row
                      where switch_row.key = 'death_record'), false) then
      raise exception using errcode = '55000', message = 'DEATH_RECORD_NOT_AVAILABLE';
    end if;
    select * into caller from ehr.inpatient_caller(required_access, array['direct-care']);
    return caller;
  end
  $fn$;
  revoke all on function ehr.death_record_gate(text) from public;

  -- The certificate's content, checked: lines a (required) to d, each 1-300 characters with an optional interval
  -- (1-40) and ICD-11 code; the manner, autopsy, pregnancy status and place.
  create function ehr.death_record_content_valid(requested jsonb)
  returns boolean
  language sql
  immutable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select jsonb_typeof(requested) = 'object'
       and jsonb_typeof(requested->'causes') = 'array'
       and jsonb_array_length(requested->'causes') between 1 and 4
       and (requested->'causes'->0->>'line') = 'a'
       and not exists (
         select 1 from jsonb_array_elements(requested->'causes') with ordinality cause(value, ord)
          where jsonb_typeof(cause.value) <> 'object'
             or cause.value->>'line' is distinct from chr(96 + cause.ord::integer)
             or length(btrim(coalesce(cause.value->>'text', ''))) not between 1 and 300
             or (cause.value ? 'interval' and cause.value->'interval' <> 'null'::jsonb
                 and length(btrim(coalesce(cause.value->>'interval', ''))) not between 1 and 40)
             or (cause.value ? 'icd11Code' and cause.value->'icd11Code' <> 'null'::jsonb
                 and coalesce(cause.value->>'icd11Code', '') !~ '^[0-9A-Z][0-9A-Z.&/]{1,30}$'))
       and coalesce(requested->>'manner', '') in ('natural', 'accident', 'intentional_self_harm', 'assault',
                                                  'pending_investigation', 'unknown')
       and coalesce(requested->>'autopsy', '') in ('not_requested', 'requested', 'done')
       and coalesce(requested->>'pregnancyStatus', 'not_applicable') in ('not_applicable', 'not_pregnant', 'pregnant',
                                                                          'within_42_days', 'within_one_year', 'unknown')
       and coalesce(requested->>'placeOfDeath', 'ward') in ('ward', 'icu', 'theatre', 'emergency', 'other')
       and length(coalesce(requested->>'otherConditions', '')) <= 2000
       and upper(btrim(coalesce(requested->>'signature', ''))) = 'SIGN'
  $fn$;
  revoke all on function ehr.death_record_content_valid(jsonb) from public;

  create function ehr.death_record_json(requested_admission uuid)
  returns jsonb
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select jsonb_build_object('admissionId', record_row.admission_id, 'version', version_row.version_no,
      'diedAt', version_row.died_at, 'causes', version_row.causes, 'otherConditions', version_row.other_conditions,
      'manner', version_row.manner, 'autopsy', version_row.autopsy, 'pregnancyStatus', version_row.pregnancy_status,
      'placeOfDeath', version_row.place_of_death, 'certifiedByMembershipId', version_row.certified_by_membership_id,
      'signedAt', version_row.signed_at,
      'versions', (select jsonb_agg(jsonb_build_object('version', every_version.version_no,
          'signedAt', every_version.signed_at, 'certifiedByMembershipId', every_version.certified_by_membership_id,
          'amended', every_version.amend_reason is not null) order by every_version.version_no)
        from ehr.death_record_versions every_version where every_version.admission_id = record_row.admission_id))
      from ehr.death_records record_row
      join ehr.death_record_versions version_row
        on version_row.admission_id = record_row.admission_id and version_row.version_no = record_row.current_version_no
     where record_row.admission_id = requested_admission
  $fn$;
  revoke all on function ehr.death_record_json(uuid) from public;

  create function ehr.death_record_write(requested_admission uuid, requested jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
    died_value timestamptz;
    refusal text;
  begin
    caller := ehr.death_record_gate('death_record');
    if requested_admission is null or not ehr.death_record_content_valid(requested) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility for update;
    died_value := coalesce((requested->>'diedAt')::timestamptz, admission_row.died_at);
    if not found then
      refusal := 'not_found';
    elsif admission_row.status <> 'discharged' or admission_row.outcome <> 'died' then
      refusal := 'state_invalid';
    elsif exists (select 1 from ehr.death_records record_row where record_row.admission_id = admission_row.id) then
      refusal := 'already_recorded';
    elsif not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    elsif died_value > clock_timestamp() or died_value < admission_row.admitted_at then
      refusal := 'time_invalid';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.death-record.write',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    insert into ehr.death_records (admission_id, facility_id, patient_id, created_by_membership_id)
    values (admission_row.id, caller.actor_facility, admission_row.patient_id, caller.actor_membership);
    insert into ehr.death_record_versions (admission_id, version_no, died_at, causes, other_conditions, manner, autopsy,
      pregnancy_status, place_of_death, certified_by_membership_id)
    values (admission_row.id, 1, died_value, requested->'causes', nullif(btrim(coalesce(requested->>'otherConditions', '')), ''),
      requested->>'manner', requested->>'autopsy', coalesce(requested->>'pregnancyStatus', 'not_applicable'),
      coalesce(requested->>'placeOfDeath', 'ward'), caller.actor_membership);
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.death-record.write', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('version', 1));
    return jsonb_build_object('outcome', 'created', 'deathRecord', ehr.death_record_json(admission_row.id));
  end
  $fn$;
  comment on function ehr.death_record_write(uuid, jsonb) is
    '0171 (ADT-1, Q188 A): the medical certificate of cause of death (the WHO international form) for an admission discharged as died. Switched off: refuses with DEATH_RECORD_NOT_AVAILABLE while the death_record switch is off, and no role holds ehr.death-record.write. Needs chart write access and the typed word SIGN. Never changes the Health ID record and sends no notice. Audited (ehr.death-record.write; never the causes).';
  revoke all on function ehr.death_record_write(uuid, jsonb) from public;

  create function ehr.death_record_read(requested_admission uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
  begin
    caller := ehr.death_record_gate('admission_read');
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility
       and exists (select 1 from ehr.death_records record_row where record_row.admission_id = admission.id);
    if not found then
      perform ehr.inpatient_audit(null, 'ehr.death-record.read', 'failure', 'admission', requested_admission::text,
        jsonb_build_object('refusal', 'not_found'));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    if not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'read_records'), false) then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.death-record.read', 'denied', 'admission',
        admission_row.id::text, jsonb_build_object('refusal', 'chart_access_required'));
      return jsonb_build_object('outcome', 'chart_access_required');
    end if;
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.death-record.read', 'success', 'admission',
      admission_row.id::text, '{}'::jsonb);
    return jsonb_build_object('outcome', 'found', 'deathRecord', ehr.death_record_json(admission_row.id));
  end
  $fn$;
  comment on function ehr.death_record_read(uuid) is
    '0171 (ADT-1, Q188 A): the death record with its versions (chart read access). Switched off (DEATH_RECORD_NOT_AVAILABLE). Audited (ehr.death-record.read).';
  revoke all on function ehr.death_record_read(uuid) from public;

  create function ehr.death_record_amend(requested_admission uuid, requested jsonb, requested_reason text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
    record_row ehr.death_records%rowtype;
    reason_value text := btrim(coalesce(requested_reason, ''));
    died_value timestamptz;
    refusal text;
  begin
    caller := ehr.death_record_gate('death_record');
    if requested_admission is null or not ehr.death_record_content_valid(requested)
       or length(reason_value) not between 8 and 500 then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility;
    select death_row.* into record_row from ehr.death_records death_row
     where death_row.admission_id = admission_row.id for update;
    died_value := coalesce((requested->>'diedAt')::timestamptz, admission_row.died_at);
    if record_row.admission_id is null then
      refusal := 'not_found';
    elsif not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'write_records'), false) then
      refusal := 'chart_access_required';
    elsif died_value > clock_timestamp() or died_value < admission_row.admitted_at then
      refusal := 'time_invalid';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.death-record.amend',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    insert into ehr.death_record_versions (admission_id, version_no, died_at, causes, other_conditions, manner, autopsy,
      pregnancy_status, place_of_death, certified_by_membership_id, amend_reason)
    values (record_row.admission_id, record_row.current_version_no + 1, died_value, requested->'causes',
      nullif(btrim(coalesce(requested->>'otherConditions', '')), ''), requested->>'manner', requested->>'autopsy',
      coalesce(requested->>'pregnancyStatus', 'not_applicable'), coalesce(requested->>'placeOfDeath', 'ward'),
      caller.actor_membership, reason_value);
    update ehr.death_records death_row
       set current_version_no = death_row.current_version_no + 1, updated_at = clock_timestamp()
     where death_row.admission_id = record_row.admission_id;
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.death-record.amend', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('version', record_row.current_version_no + 1));
    return jsonb_build_object('outcome', 'updated', 'deathRecord', ehr.death_record_json(admission_row.id));
  end
  $fn$;
  comment on function ehr.death_record_amend(uuid, jsonb, text) is
    '0171 (ADT-1, Q188 A): amend the death record with a reason (8-500); every version is kept. Switched off (DEATH_RECORD_NOT_AVAILABLE). Audited (ehr.death-record.amend; never the reason).';
  revoke all on function ehr.death_record_amend(uuid, jsonb, text) from public;

  create function ehr.death_record_print(requested_admission uuid, requested_form text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    admission_row ehr.admissions%rowtype;
  begin
    caller := ehr.death_record_gate('admission_read');
    if requested_form is null or requested_form not in ('certificate', 'registration-notice') then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = caller.actor_facility
       and exists (select 1 from ehr.death_records record_row where record_row.admission_id = admission.id);
    if not found then
      perform ehr.inpatient_audit(null, 'ehr.death-record.print', 'failure', 'admission', requested_admission::text,
        jsonb_build_object('refusal', 'not_found', 'form', requested_form));
      return jsonb_build_object('outcome', 'not_found');
    end if;
    if not coalesce(ehr.context_allows(admission_row.patient_id, caller.actor_facility, 'read_records'), false) then
      perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.death-record.print', 'denied', 'admission',
        admission_row.id::text, jsonb_build_object('refusal', 'chart_access_required', 'form', requested_form));
      return jsonb_build_object('outcome', 'chart_access_required');
    end if;
    perform ehr.inpatient_audit(admission_row.patient_id, 'ehr.death-record.print', 'success', 'admission',
      admission_row.id::text, jsonb_build_object('form', requested_form));
    return jsonb_build_object('outcome', 'found', 'print', jsonb_build_object('form', requested_form,
      'facility', (select jsonb_build_object('name', facility.name,
                     'address', nullif(concat_ws(', ', profile.address_line, profile.city), ''))
                     from identity.facilities facility
                     left join identity.facility_profiles profile on profile.facility_id = facility.id
                    where facility.id = caller.actor_facility),
      'patient', (select jsonb_build_object('fullName', patient.full_name, 'sex', patient.gender,
                    'dateOfBirth', patient.dob, 'healthId', null)
                    from identity.patients patient where patient.id = admission_row.patient_id),
      'admissionNumber', admission_row.admission_number,
      'deathRecord', ehr.death_record_json(admission_row.id) - 'versions',
      'printedAt', clock_timestamp()));
  end
  $fn$;
  comment on function ehr.death_record_print(uuid, text) is
    '0171 (ADT-1, Q188 A): the certificate, or the notice the family takes to the death registrar (National Population Commission). Switched off (DEATH_RECORD_NOT_AVAILABLE). Each print is audited (ehr.death-record.print).';
  revoke all on function ehr.death_record_print(uuid, text) from public;

  -- Owners and EXECUTE (as 0170).
  if v_owner <> current_user then
    execute (select string_agg(format('alter table %s owner to %I', relation.oid::regclass, v_owner), '; ')
               from pg_class relation
              where relation.oid in ('ehr.admission_counters'::regclass, 'ehr.admissions'::regclass,
                'ehr.admission_movements'::regclass, 'ehr.admission_discharge_medicines'::regclass,
                'ehr.wristband_prints'::regclass, 'ehr.death_records'::regclass,
                'ehr.death_record_versions'::regclass));
    execute (select string_agg(format('alter function %s owner to %I', proc.oid::regprocedure, v_owner), '; ')
               from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'ehr'
                and (proc.proname like 'admission\_%' or proc.proname like 'wristband\_%'
                     or proc.proname like 'newborn\_%' or proc.proname like 'death\_record%'
                     or proc.proname like 'discharge\_%'));
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function
      ehr.admission_request(uuid, text, uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, text),
      ehr.admission_list(text, uuid, text),
      ehr.admission_read(uuid),
      ehr.admission_admit(uuid, bigint, uuid, boolean, text, text),
      ehr.admission_transfer(uuid, bigint, uuid, text, boolean, text, text),
      ehr.admission_handover_read(uuid, uuid),
      ehr.admission_prepare_discharge(uuid, bigint, text, date, uuid[], text, text),
      ehr.admission_discharge(uuid, bigint, text, timestamptz, jsonb, text, timestamptz, text, text, text),
      ehr.admission_cancel(uuid, bigint, text, text, text),
      ehr.admission_update(uuid, bigint, text, uuid, date, text, text, text),
      ehr.discharge_summary_print(uuid),
      ehr.wristband_print(uuid, text, text, text),
      ehr.newborn_band_print(uuid, text, text, text),
      ehr.death_record_write(uuid, jsonb),
      ehr.death_record_read(uuid),
      ehr.death_record_amend(uuid, jsonb, text),
      ehr.death_record_print(uuid, text)
      to hid_ehr_runtime;
  end if;

  -- 3. Post-checks.
  if exists (select 1 from pg_class class_row,
                    lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid in ('ehr.admission_counters'::regclass, 'ehr.admissions'::regclass,
                'ehr.admission_movements'::regclass, 'ehr.admission_discharge_medicines'::regclass,
                'ehr.wristband_prints'::regclass, 'ehr.death_records'::regclass,
                'ehr.death_record_versions'::regclass)
                and acl.grantee <> class_row.relowner)
     or (select count(*) from pg_class
          where oid in ('ehr.admission_counters'::regclass, 'ehr.admissions'::regclass,
                'ehr.admission_movements'::regclass, 'ehr.admission_discharge_medicines'::regclass,
                'ehr.wristband_prints'::regclass, 'ehr.death_records'::regclass,
                'ehr.death_record_versions'::regclass)
            and relrowsecurity) <> 7
     or exists (select 1 from pg_policy where polrelid in ('ehr.admission_counters'::regclass, 'ehr.admissions'::regclass,
                'ehr.admission_movements'::regclass, 'ehr.admission_discharge_medicines'::regclass,
                'ehr.wristband_prints'::regclass, 'ehr.death_records'::regclass,
                'ehr.death_record_versions'::regclass)) then
    raise exception using errcode = '55000',
      message = '0171: post-check failed (a table is granted to a role, has a policy or lacks row-level security)';
  end if;
  if exists (select 1 from pg_proc proc
               join pg_namespace namespace on namespace.oid = proc.pronamespace,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where namespace.nspname = 'ehr'
                and (proc.proname like 'admission\_%' or proc.proname like 'wristband\_%'
                     or proc.proname like 'newborn\_%' or proc.proname like 'death\_record%'
                     or proc.proname like 'discharge\_%' or proc.proname like 'inpatient\_%')
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or not proc.prosecdef))
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'admission\_%' or proc.proname like 'wristband\_%'
                 or proc.proname like 'newborn\_%' or proc.proname like 'death\_record%'
                 or proc.proname like 'discharge\_%')
            and proc.prosecdef) <> 17
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'admission\_%' or proc.proname like 'wristband\_%'
                 or proc.proname like 'newborn\_%' or proc.proname like 'death\_record%'
                 or proc.proname like 'discharge\_%')) <> 30
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'admission\_%' or proc.proname like 'wristband\_%'
                        or proc.proname like 'newborn\_%' or proc.proname like 'death\_record%'
                        or proc.proname like 'discharge\_%' or proc.proname like 'inpatient\_%')
                   and proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0171: post-check failed (the functions'' security or grants)';
  end if;
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'ehr.ed_attendances'::regclass
         and constraint_row.conname = 'ed_attendances_closed_via_check') is distinct from v_closed_via_0171
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'ehr.ed_attendance_events'::regclass
            and constraint_row.conname = 'ed_attendance_events_kind_check') is distinct from v_kind_0171 then
    raise exception using errcode = '55000', message = '0171: post-check failed (the ED record''s CHECKs)';
  end if;
  if (select count(*) from pg_policy policy_row
       where (policy_row.polrelid, policy_row.polname) in (
               ('ehr.encounters'::regclass, 'encounters_inpatient_owner_update'),
               ('ehr.record_versions'::regclass, 'record_versions_inpatient_owner_insert'),
               ('ehr.recorded_allergies'::regclass, 'recorded_allergies_inpatient_band_read'))) <> 3
     or (select count(*) from pg_trigger trigger_row
          where (trigger_row.tgrelid, trigger_row.tgname) in (
                  ('ehr.admission_movements'::regclass, 'admission_movements_immutable'),
                  ('ehr.wristband_prints'::regclass, 'wristband_prints_immutable'),
                  ('ehr.death_record_versions'::regclass, 'death_record_versions_immutable'))
            and trigger_row.tgenabled = 'O') <> 3 then
    raise exception using errcode = '55000', message = '0171: post-check failed (the policies or the triggers)';
  end if;
  if (select md5(coalesce(string_agg(to_jsonb(attendance)::text, ',' order by attendance.id), ''))
        from ehr.ed_attendances attendance) is distinct from v_ed_rows
     or (select count(*) from audit.events) <> v_audit_rows then
    raise exception using errcode = '55000', message = '0171: post-check failed (an existing row changed)';
  end if;

  raise notice '0171: admissions, transfers, discharge, bands and the death record are installed (7 tables, 30 functions, 3 owner-only policies; the ED record closes by an admission). Nobody can use them until 0173 gives the codes; the death record stays off.';
end
$adt0171$;
