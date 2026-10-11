\set ON_ERROR_STOP on
-- EHR timeline paging keeps the sort key to the microsecond. Rollback-only.
--
-- The six newest-first clinical lists (encounters, clinical notes, diagnoses,
-- lab requests, prescriptions and vitals) page with a keyset cursor on
-- (sort key, id). Their sort keys are timestamptz columns, which keep
-- microseconds: created_at defaults to clock_timestamp(), and started_at and
-- recorded_at accept any fraction the client sends. node-postgres returns a
-- timestamptz as a JavaScript Date, which keeps only milliseconds. A cursor
-- built from that Date made the next page's predicate
-- (key, id) < (cursor key, cursor id) drop every row that sorts after the
-- last row shown within the same millisecond: older rows of that millisecond
-- were never shown. The services now select the key as text with
-- to_char(key at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') and put
-- that text in the cursor (services/ehr-api/src/ehr/shared/clinical-context.ts).
--
-- Case 1 checks that the text form casts back to exactly the same instant
-- whatever the session time zone, so the cursor binds to the existing
-- $n::timestamptz parameter unchanged. That includes a year after 9999, which
-- to_char renders with five or six digits (started_at and recorded_at take
-- any instant the client sends), up to 294276, the last year a timestamptz
-- holds. Case 2 runs the clinical-notes list
-- query on rows that share a millisecond, with the microsecond bound and with
-- the millisecond bound a cursor used to carry. Fixtures are inserted with
-- session_replication_role = replica (no foreign-key checks; CHECK constraints
-- still apply).
begin;

-- 1. The cursor's text form is exact and time-zone independent.
do $$
declare
  zone text;
  instant timestamptz;
  rendered text;
begin
  foreach zone in array array['UTC', 'Africa/Lagos', 'America/Los_Angeles', 'Asia/Kolkata'] loop
    perform set_config('timezone', zone, true);
    foreach instant in array array['2026-10-11 08:00:00.123456+00', '2026-10-11 08:00:00.000001+00',
      '2026-10-11 08:00:00.999999+00', '0001-01-01 00:00:00+00', '2028-02-29 23:59:59.999999+00',
      '9999-12-31 23:00:00-05:00', '294276-12-31 23:59:59.999999+00']::timestamptz[] loop
      rendered := to_char(instant at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
      if rendered !~ '^(\d{4}|[1-9]\d{4,5})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$' or rendered::timestamptz <> instant then
        raise exception 'the cursor text of % under time zone % is %, which is not that instant', instant, zone, rendered;
      end if;
    end loop;
  end loop;
end $$;

-- 2. Rows that share the last row's millisecond are on the next page.
set local session_replication_role = replica;
insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  note_type, title, created_at)
select note.id::uuid, 'b0000000-0000-4000-8000-0000000000e1', 'b0000000-0000-4000-8000-0000000000a1',
  'b0000000-0000-4000-8000-0000000000f1', 'b0000000-0000-4000-8000-0000000000c1',
  'b0000000-0000-4000-8000-0000000000d1', 'progress', 'Timeline cursor fixture', note.created_at::timestamptz
from (values
  ('a0000000-0000-4000-8000-000000000005', '2026-10-11 08:00:00.124000+00'),
  ('a0000000-0000-4000-8000-000000000004', '2026-10-11 08:00:00.123456+00'),
  ('a0000000-0000-4000-8000-000000000003', '2026-10-11 08:00:00.123400+00'),
  ('a0000000-0000-4000-8000-000000000002', '2026-10-11 08:00:00.123400+00'),
  ('a0000000-0000-4000-8000-000000000001', '2026-10-11 08:00:00.122999+00')
) as note(id, created_at);
set local session_replication_role = origin;

do $$
declare
  page uuid[];
  cursor_at text;
  next_page uuid[];
  millisecond_page uuid[];
begin
  -- The list query of ClinicalNotesService.list, first page of two (limit + 1 rows read).
  select array_agg(id order by created_at desc, id desc) into page from (
    select id, created_at from ehr.clinical_notes
     where encounter_id = 'b0000000-0000-4000-8000-0000000000e1' and patient_id = 'b0000000-0000-4000-8000-0000000000a1'
       and facility_id = 'b0000000-0000-4000-8000-0000000000f1'
     order by created_at desc, id desc limit 3) first_page;
  select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') into cursor_at
    from ehr.clinical_notes where id = page[2];
  if cursor_at <> '2026-10-11T08:00:00.123456Z' then
    raise exception 'the last row of the first page has cursor text %, expected 2026-10-11T08:00:00.123456Z', cursor_at;
  end if;

  select array_agg(id order by created_at desc, id desc) into next_page from (
    select id, created_at from ehr.clinical_notes
     where encounter_id = 'b0000000-0000-4000-8000-0000000000e1' and patient_id = 'b0000000-0000-4000-8000-0000000000a1'
       and facility_id = 'b0000000-0000-4000-8000-0000000000f1'
       and (created_at, id) < (cursor_at::timestamptz, page[2])
     order by created_at desc, id desc limit 3) second_page;
  if next_page is distinct from array['a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000002',
      'a0000000-0000-4000-8000-000000000001']::uuid[] then
    raise exception 'the page after the microsecond cursor is %, expected the two .123400 rows (higher id first) then .122999', next_page;
  end if;

  -- The millisecond bound the earlier cursor carried leaves both .123400 rows out: the defect this fixes.
  select array_agg(id order by created_at desc, id desc) into millisecond_page from (
    select id, created_at from ehr.clinical_notes
     where encounter_id = 'b0000000-0000-4000-8000-0000000000e1' and patient_id = 'b0000000-0000-4000-8000-0000000000a1'
       and facility_id = 'b0000000-0000-4000-8000-0000000000f1'
       and (created_at, id) < ('2026-10-11T08:00:00.123Z'::timestamptz, page[2])
     order by created_at desc, id desc limit 3) skipped_page;
  if millisecond_page is distinct from array['a0000000-0000-4000-8000-000000000001']::uuid[] then
    raise exception 'the page after a millisecond cursor is %, expected only the .122999 row', millisecond_page;
  end if;
end $$;

rollback;
