\set ON_ERROR_STOP on
-- 0154 (ORD-12, owner decision Q131 A, 19 November 2026; the clinical
-- owner's design note on #258, 23 November 2026): prescription refills. The
-- prescriber sets refills_allowed (0-11, null means none) at creation; this
-- facility's own pharmacy records up to 1 + refills_allowed fills of the one
-- work item (pharmacy.dispensings.fill_number, one row per fill number) while
-- the prescription stays active and unchanged and its ends_on is not past
-- (the Lagos day); a route-backed item takes one fill; a reversed fill still
-- counts. The pharmacy reads an own item's refills through 0154's reader,
-- pharmacy.work_item_refills (Ola's answers to Rahman's review, #258, 23
-- November 2026), and its work list finds the own items whose refill is open
-- now through 0154's pharmacy.open_refill_work_items (R7), so a refill that
-- is open stays listed however many items were filled after it. The
-- clinical owner's decisions of 24 November 2026: D8, both readers read
-- ehr.prescriptions in one statement under a refill scan marker (R9, 0143
-- D1's form), so the table's read policies are not asked on every row; D9,
-- refills end on R8's day (ehr.prescription_refills_end_on: the earliest of
-- ends_on, the Lagos day written plus (refills_allowed + 2) fills'
-- durations, and that day plus 365).
-- Rollback-only. Through the exact runtime roles the services use
-- (hid_ehr_api_runtime with ehr-api's INSERT and UPDATE and app.change_reason,
-- hid_pharmacy_api_runtime with pharmacy-api's dispensing and reversal
-- INSERTs, the new one naming fill_number), in the session the services set
-- (the new images also set app.own_facility_work to '0133', 0133 D13). The
-- pharmacist PH holds no consent grant: own items are dispensed on the
-- own-work basis, as at the hospital's pharmacy.
-- Cases (the expect labels start with their number):
--   1. structure: both columns (type, null, default, no column privilege)
--      and CHECKs (validated); the new key exactly and 0023's gone; the two
--      replaced functions (md5, owner, attributes, ACL), the claim function
--      naming no ehr.prescriptions and 0148's recorder unchanged; 0133's S7
--      list with the reader added and nothing else (and, once 0159 is
--      applied, its two notice readers); the five triggers on
--      pharmacy.dispensings and their modes (six with 0159's
--      zz_order_notice); what the runtimes may do with
--      the new columns; the two readers exactly (md5, owner, attributes,
--      result) and who may execute them (the Pharmacy and schema test
--      runtimes only); R7's index on ehr.prescriptions exactly; the
--      refills_allowed column and its CHECK saying that with refills the
--      duration is how long one fill lasts; R8 exactly and who may execute
--      it (the two runtimes that may write prescriptions); R9's table, test
--      and policy exactly, the policy the last read policy by name and 0143's
--      prescriptions_scan_my_orders the one before it; R7's comment giving
--      its cost for own-work sessions and for sessions on consent alone;
--   2. fills 1 to 1 + N pass for N = 0, 1, 2 and 11, and fill N + 2 is
--      refused NO_REFILLS_LEFT; null refills_allowed is one fill; the
--      claim's dispensed_at stays the first fill's;
--   3. the end date: a refill on ends_on's own Lagos day passes, the day
--      after is refused REFILL_PRESCRIPTION_ENDED (DETAIL the last day), and
--      a first fill after ends_on still passes; the same under far time
--      zones (the Lagos day, not the session's);
--   4. a route-backed item: one fill (fill 2 after it: ORDER_ROUTE_CLOSED;
--      a fill 2 as its first: NO_REFILLS_LEFT), whatever refills_allowed;
--      the own item released by the route: sent_elsewhere;
--   5. any change after the first fill ends the refills: an edit, a hold
--      then resume, a completion (0101's check);
--   6. double dispensing: a second refill with the same fill number (two
--      refills that both counted the same fills) meets the key (23505), as
--      does today's pharmacy-api INSERT (fill 1 again); fill numbers out of
--      bounds meet the CHECK;
--   7. replica mode (the validator does not fire): the ALWAYS claim refuses
--      a refill of a route-backed item, of an item sent elsewhere and of an
--      item never dispensed; the CHECK and the key still hold; the refill
--      count is not enforced there (stated);
--   8. a reversed fill still counts;
--   9. 0148: a null refills_allowed leaves 0148's fingerprint as it was
--      before 0154, so a hold recorded before 0154 is followed by a resume
--      that reads 'resumed'; a set value is fingerprinted on both sides
--      ('resumed' too); an owner repair of refills_allowed after dispensing
--      reads 'edited' and ends the refills;
--  10. Release A's and B's shapes after refills: 0144 refuses an acceptance
--      (not_claimed), 0133's and 0144's readers answer one row per item;
--  11. refills_allowed's CHECK: 0, 11 and null pass, -1 and 12 are refused
--      on create and on update;
--  12. the undo of 0154's header, step 1 (0101's and 0133's bodies put
--      back): every refill is refused, first fills still pass;
--  13. the reader, pharmacy.work_item_refills, through the Pharmacy runtime:
--      one row per own item the session may read, never a route-backed
--      item, another facility's item, or one read without
--      pharmacy.work-item.read; each of the work items' two read policies
--      alone lets a pharmacist read (the own-work half without a grant, the
--      consent test without the own-work switch), and the reader answers
--      the items and fills the runtime itself may select, under a superuser
--      owner and a NOSUPERUSER NOBYPASSRLS one alike; at most 200 ids; each
--      closed reason (none_left, stopped, changed, ended) and the open and
--      closed transitions of one item (no fill, fill 1, fill 2, none left;
--      open, held, resumed; cancelled), the Lagos day under far time zones;
--      every item of cases 2-12 as those cases left it; and refill_open is
--      true exactly when the next fill would be recorded;
--  14. the open refills, pharmacy.open_refill_work_items (R7), through the
--      Pharmacy runtime: exactly the own items the per-item reader says
--      have a refill open; an item with a refill open, filled 29 days ago,
--      is answered though 210 items were filled after it (none of them with
--      refills; pharmacy-api's earlier candidates query took the 200 most
--      recently filled items and missed it); an ended prescription and an
--      item with no refill left are not; the item whose latest fill is
--      oldest comes first, and 200 at most; nothing without the session's
--      facility, without pharmacy.work-item.read or at another facility;
--      each of the work items' two read policies alone, as the per-item
--      reader; the same under a superuser owner and a NOSUPERUSER
--      NOBYPASSRLS one; the read policies asked only of the due items it
--      answers, own-work half first, 200 at most (14e);
--  15. the refill interval (cases' own text below);
--  16. the refill scan marker (R9, D8): no runtime role may read or write
--      its table; the owner with a session but no marker, and the EHR
--      runtime, read what they read before (the policy dropped, undone, is
--      'before'); no marker row after R6 or R7 returns or fails (a failure
--      made while the marker is held); R6 and R7 answer exactly as before
--      (as PH and as PG); a later statement in the same transaction reads
--      what it read before, the owner's read in another facility's session
--      included (16e, which also shows it sees a marker left behind by an R7
--      without its DELETE); the policy is asked once per statement, first
--      (pharmacy.refill_scan_open runs once for R6's and once for R7's
--      statement; in the plan, the first arm of the read policies' OR is its
--      one InitPlan);
--  17. the refills' last day (R8, D9): the boundaries of (a) ends_on, (b)
--      the Lagos day written plus (refills_allowed + 2) fills' durations
--      (days, a week, months) and (c) that day plus 365, each written at
--      00:00 Lagos and one microsecond before, under far session time zones;
--      R8, R6 (refills_end_on, 'ended'), R4 (REFILL_PRESCRIPTION_ENDED,
--      DETAIL the day) and R7 agree; an expired prescription is neither
--      listed nor fillable; an edit, a hold and resume, or a later end date
--      does not move the day; R7's statement can range-scan its index by
--      facility and time written (sequential scans off), with R8's day a
--      condition on the index only under an owner that bypasses row-level
--      security; a late fill (a refill whose day would come after the last
--      day) is ended at once in R6, R4 and R7, and a refill whose day is the
--      last day is not_yet until then (17g).
-- Fixtures inserted as the suite runner with session_replication_role =
-- replica where the services would not write them (identity rows, the
-- outside pharmacy's approval). Synthetic values only; uuid prefix e152.
set plpgsql.variable_conflict = error;
begin;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception 'prescription refills: %: got [%], want [%]', label, got, want;
  end if;
end
$f$;
-- A statement's outcome: 'ok', or 'SQLSTATE message / DETAIL' ('-' for none).
create function pg_temp.try(statement text) returns text language plpgsql as $f$
declare failure_detail text;
begin
  execute statement;
  return 'ok';
exception when others then
  get stacked diagnostics failure_detail = pg_exception_detail;
  return sqlstate || ' ' || sqlerrm || ' / ' || coalesce(nullif(failure_detail, ''), '-');
end
$f$;

-- 1. Structure.
do $$
declare
  mismatch text;
  owner_oid oid := (select relowner from pg_class where oid = 'pharmacy.work_items'::regclass);
begin
  -- 1a. The two columns: type, NOT NULL, default, no generation or
  -- identity, no column-level privilege; and their CHECKs, validated.
  perform pg_temp.expect('1a the columns and their CHECKs',
    (select string_agg(attribute.attrelid::regclass::text || '.' || attribute.attname || ' '
              || format_type(attribute.atttypid, attribute.atttypmod)
              || case when attribute.attnotnull then ' not null' else '' end
              || coalesce(' default ' || pg_get_expr(column_default.adbin, column_default.adrelid), '')
              || case when attribute.attgenerated = '' and attribute.attidentity = '' and attribute.attacl is null
                      then '' else ' (generated, identity or column privilege)' end, '; '
              order by attribute.attrelid::regclass::text)
       from pg_attribute attribute
       left join pg_attrdef column_default
         on column_default.adrelid = attribute.attrelid and column_default.adnum = attribute.attnum
      where not attribute.attisdropped
        and ((attribute.attrelid = 'ehr.prescriptions'::regclass and attribute.attname = 'refills_allowed')
          or (attribute.attrelid = 'pharmacy.dispensings'::regclass and attribute.attname = 'fill_number')))
    || ' | ' || (select string_agg(constraint_row.conname || ' ' || pg_get_constraintdef(constraint_row.oid)
                   || ' validated=' || constraint_row.convalidated, '; ' order by constraint_row.conname)
                   from pg_constraint constraint_row
                  where constraint_row.conname in ('prescriptions_refills_allowed_ck', 'dispensings_fill_number_ck')),
    'ehr.prescriptions.refills_allowed smallint; pharmacy.dispensings.fill_number smallint not null default 1 | '
    || 'dispensings_fill_number_ck CHECK (((fill_number >= 1) AND (fill_number <= 12))) validated=true; '
    || 'prescriptions_refills_allowed_ck CHECK (((refills_allowed IS NULL) OR (((refills_allowed >= 0) AND '
    || '(refills_allowed <= 11)) AND ((refills_allowed = 0) OR ((duration_value IS NOT NULL) AND (duration_unit IS NOT '
    || 'NULL)))))) validated=true');
  -- 1b. pharmacy.dispensings' keys: its primary key, 0023's idempotency key
  -- and the new key (not deferrable); 0023's UNIQUE (work_item_id) gone.
  perform pg_temp.expect('1b the keys of pharmacy.dispensings',
    (select string_agg(constraint_row.conname || ' ' || pg_get_constraintdef(constraint_row.oid) || ' deferrable='
              || constraint_row.condeferrable, '; ' order by constraint_row.conname)
       from pg_constraint constraint_row
      where constraint_row.conrelid = 'pharmacy.dispensings'::regclass and constraint_row.contype in ('p', 'u')),
    'dispensings_facility_id_dispensed_by_idempotency_key_key UNIQUE (facility_id, dispensed_by, idempotency_key) '
    || 'deferrable=false; dispensings_pkey PRIMARY KEY (id) deferrable=false; dispensings_work_item_fill_number_key '
    || 'UNIQUE (work_item_id, fill_number) deferrable=false');
  -- 1c. The two replaced functions: md5, owner (the work items' and the
  -- dispensing validator's role, which 0133 D5's prescription policies
  -- name), SECURITY DEFINER, VOLATILE, plpgsql, not STRICT, search_path, and
  -- no EXECUTE for anyone but the owner; 0148's recorder unchanged.
  select string_agg(format('%s md5=%s owner=%s definer=%s volatile=%s strict=%s config=%s', expected.proc_name,
           coalesce(md5(proc.prosrc), 'none (missing)'), pg_get_userbyid(proc.proowner), proc.prosecdef,
           proc.provolatile, proc.proisstrict, proc.proconfig), '; ')
    into mismatch
    from (values
      ('pharmacy.validate_dispensing()', '06be902c41bcd4ee65f7f840c120db8f', '{"search_path=pharmacy, platform, pg_temp"}'),
      ('pharmacy.claim_prescription_dispensing()', '1a50612f5330a36c9b64d0d831c77812', '{"search_path=pg_catalog, pg_temp"}'),
      ('pharmacy.prescription_change_after_dispensing()', 'f61173d77be391a9e9c96db494827e82',
       '{"search_path=pg_catalog, pg_temp"}')) expected(proc_name, digest, config)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc_name)
    left join pg_language language_row on language_row.oid = proc.prolang
   where proc.oid is null or md5(proc.prosrc) <> expected.digest or proc.proowner <> owner_oid or not proc.prosecdef
      or proc.provolatile <> 'v' or proc.proisstrict or language_row.lanname <> 'plpgsql'
      or proc.proconfig::text <> expected.config
      or exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
                  where privilege.grantee <> proc.proowner);
  perform pg_temp.expect('1c the two replaced functions and 0148''s recorder', coalesce(mismatch, 'as built'), 'as built');
  -- 1d. The claim function names no ehr.prescriptions; the two readers do,
  -- so 0133's S7 list (the owner-run definers whose text names
  -- ehr.prescriptions, each of which sees 0133 D5's rows in a pharmacist's
  -- session) is the ten 0133's suite pinned on Release B and the two readers
  -- (the validator was on it already). Cases 13 and 14 show the readers give
  -- the pharmacist nothing the Pharmacy runtime may not select itself, and
  -- own-facility-pharmacy-lab-work's case 8 that the EHR runtime may not run
  -- them. 0159 (ORD-11) adds its list and Seen, which read an order only
  -- for the session's own notices (the order-notices suite, and that case 8).
  perform pg_temp.expect('1d the claim function names no ehr.prescriptions; 0133''s S7 list gains the two readers alone',
    (select count(*) from pg_proc proc
      where proc.oid = 'pharmacy.claim_prescription_dispensing()'::regprocedure and proc.prosrc ~* 'ehr\.prescriptions')
    || ' | ' || (select string_agg(proc.oid::regprocedure::text, ' ' order by proc.oid::regprocedure::text) from pg_proc proc
                  where proc.prosecdef and proc.prosrc ~* 'ehr\.prescriptions' and proc.proowner = owner_oid),
    '0 | ehr.list_my_orders(text[],boolean,date,timestamp with time zone,text,uuid,integer) '
    || 'ehr.list_order_notices(text,integer,timestamp with time zone,uuid,integer) '
    || 'ehr.mark_order_notice_seen(uuid) '
    || 'ehr.patient_list_order_routes() ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,'
    || 'character) ehr.send_prescription_to_own_pharmacy(uuid,bigint) ehr.withdraw_own_pharmacy_send(uuid) '
    || 'identity.decide_unknown_patient(uuid,text,bigint,text,text,text) '
    || 'identity.demo_story_install(text) pharmacy.open_refill_work_items() pharmacy.validate_dispensing() '
    || 'pharmacy.validate_work_item() pharmacy.validate_work_item_acceptance() pharmacy.work_item_refills(uuid[])');
  -- 1e. The six triggers on pharmacy.dispensings: the validator, the
  -- immutability guard and 0086's route return in origin mode; 0133's claim
  -- and key guard always; and 0159's notice to the ordering doctor (AFTER
  -- INSERT, origin), named to fire after the route return.
  perform pg_temp.expect('1e the triggers on pharmacy.dispensings and their modes',
    (select string_agg(trigger_row.tgname || ':' || trigger_row.tgfoid::regprocedure::text || ':' || trigger_row.tgtype
              || ':' || trigger_row.tgenabled::text, ' ' order by trigger_row.tgname::text collate "C")
       from pg_trigger trigger_row
      where trigger_row.tgrelid = 'pharmacy.dispensings'::regclass and not trigger_row.tgisinternal),
    'dispensings_claim_prescription:pharmacy.claim_prescription_dispensing():5:A '
    || 'dispensings_order_route_return:pharmacy.return_order_route_dispensing():5:O '
    || 'pharmacy_dispensing_validate:pharmacy.validate_dispensing():7:O '
    || 'pharmacy_dispensings_immutable:pharmacy.reject_immutable_evidence():27:O '
    || 'prescription_claim_key_immutable:pharmacy.refuse_claim_key_change():19:A '
    || 'zz_order_notice:ehr.order_notice_from_dispensing():5:O');
  -- 1f. The runtimes, through any membership: the EHR runtime writes
  -- refills_allowed (table-wide INSERT and UPDATE; ehr-api's PATCH never
  -- names it), the Pharmacy runtime reads and inserts fill_number and never
  -- updates it; no other runtime gains anything.
  perform pg_temp.expect('1f the runtimes'' privileges on the new columns',
    (select string_agg(format('%s %s.%s %s', role_row.rolname, wanted.relation_name, wanted.column_name, wanted.privilege), ', '
              order by role_row.rolname, wanted.relation_name, wanted.privilege)
       from pg_roles role_row
      cross join (values ('ehr.prescriptions', 'refills_allowed'), ('pharmacy.dispensings', 'fill_number'))
                 columns_row(relation_name, column_name)
      cross join lateral (select columns_row.relation_name, columns_row.column_name, privilege.name as privilege
                            from unnest(array['SELECT', 'INSERT', 'UPDATE']) privilege(name)) wanted
      where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
        and has_column_privilege(role_row.oid, wanted.relation_name::regclass, wanted.column_name, wanted.privilege)),
    'hid_ehr_api_runtime ehr.prescriptions.refills_allowed INSERT, hid_ehr_api_runtime ehr.prescriptions.refills_allowed '
    || 'SELECT, hid_ehr_api_runtime ehr.prescriptions.refills_allowed UPDATE, hid_ehr_runtime '
    || 'ehr.prescriptions.refills_allowed INSERT, hid_ehr_runtime ehr.prescriptions.refills_allowed SELECT, '
    || 'hid_ehr_runtime ehr.prescriptions.refills_allowed UPDATE, hid_pharmacy_api_runtime '
    || 'pharmacy.dispensings.fill_number INSERT, hid_pharmacy_api_runtime pharmacy.dispensings.fill_number SELECT, '
    || 'hid_pharmacy_runtime pharmacy.dispensings.fill_number INSERT, hid_pharmacy_runtime '
    || 'pharmacy.dispensings.fill_number SELECT, hid_schema_test_runtime ehr.prescriptions.refills_allowed INSERT, '
    || 'hid_schema_test_runtime ehr.prescriptions.refills_allowed SELECT, hid_schema_test_runtime '
    || 'pharmacy.dispensings.fill_number INSERT, hid_schema_test_runtime pharmacy.dispensings.fill_number SELECT');
  -- 1g. Every dispensing already there (installs, earlier suites' kept rows)
  -- reads fill 1.
  perform pg_temp.expect('1g every dispensing already there is fill 1',
    (select count(*) filter (where dispensing.fill_number <> 1)::text from pharmacy.dispensings dispensing), '0');
  -- 1h. The reader: its body (md5), owner (the work items' and the
  -- dispensing validator's, the role 0133 D5's prescription policies name),
  -- SECURITY DEFINER, VOLATILE (it writes the refill scan marker, D8),
  -- plpgsql, not STRICT, search_path, its result (with refills_end_on, D9);
  -- 0125's reader is still 0125's.
  perform pg_temp.expect('1h the reader exactly; 0125''s reader unchanged',
    (select format('md5=%s owner=%s definer=%s volatile=%s strict=%s language=%s config=%s', md5(proc.prosrc),
              proc.proowner = owner_oid, proc.prosecdef, proc.provolatile, proc.proisstrict, language_row.lanname,
              proc.proconfig)
       from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
      where proc.oid = 'pharmacy.work_item_refills(uuid[])'::regprocedure)
    || ' | ' || pg_get_function_result('pharmacy.work_item_refills(uuid[])'::regprocedure)
    || ' | ' || (select md5(proc.prosrc) from pg_proc proc
                  where proc.oid = 'pharmacy.work_item_prescription_details(uuid[])'::regprocedure),
    'md5=1563ae61481d70df74c493a497260d44 owner=t definer=t volatile=v strict=f language=plpgsql '
    || 'config={"search_path=pg_catalog, pg_temp"} | TABLE(work_item_id uuid, refills_allowed integer, '
    || 'fills_recorded integer, refill_open boolean, closed_reason text, next_fill_on date, refills_end_on date) | '
    || 'e6013d732354a56794ad8ec7f2bbaf0c');
  -- 1h. R7, the open refills, the same way (VOLATILE too); and its index on
  -- ehr.prescriptions exactly (valid and ready): by facility, the time
  -- written and the refills' last day (R8, D9).
  perform pg_temp.expect('1h the open refills reader exactly, and its index',
    (select format('md5=%s owner=%s definer=%s volatile=%s strict=%s language=%s config=%s', md5(proc.prosrc),
              proc.proowner = owner_oid, proc.prosecdef, proc.provolatile, proc.proisstrict, language_row.lanname,
              proc.proconfig)
       from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
      where proc.oid = 'pharmacy.open_refill_work_items()'::regprocedure)
    || ' | ' || pg_get_function_result('pharmacy.open_refill_work_items()'::regprocedure)
    || ' | ' || (select pg_get_indexdef(index_row.indexrelid) || ' valid=' || (index_row.indisvalid and index_row.indisready)
                   from pg_index index_row
                  where index_row.indexrelid = 'ehr.prescriptions_refills_facility_idx'::regclass),
    'md5=928d4e14fe8d7bff9ce717ef757a6974 owner=t definer=t volatile=v strict=f language=plpgsql '
    || 'config={"search_path=pg_catalog, pg_temp"} | TABLE(work_item_id uuid) | CREATE INDEX '
    || 'prescriptions_refills_facility_idx ON ehr.prescriptions USING btree (facility_id, created_at, '
    || 'ehr.prescription_refills_end_on(created_at, refills_allowed, duration_value, duration_unit, ends_on)) '
    || 'WHERE (refills_allowed > 0) valid=true');
  -- 1i. Who may execute the two readers, through any membership: the
  -- Pharmacy runtime (and the Pharmacy API's login through it) and the
  -- schema test runtime; no other runtime; PUBLIC neither.
  select string_agg(format('%s %s=%s', reader.name, role_row.rolname,
           has_function_privilege(role_row.oid, reader.name, 'EXECUTE')), '; ') into mismatch
    from pg_roles role_row
   cross join (values ('pharmacy.work_item_refills(uuid[])'), ('pharmacy.open_refill_work_items()')) reader(name)
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, reader.name, 'EXECUTE')
         <> (role_row.rolname in ('hid_pharmacy_runtime', 'hid_pharmacy_api_runtime', 'hid_schema_test_runtime'));
  perform pg_temp.expect('1i EXECUTE on the two readers: the Pharmacy and schema test runtimes only',
    coalesce(mismatch, 'as granted') || ' public='
    || exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                where proc.oid in ('pharmacy.work_item_refills(uuid[])'::regprocedure,
                        'pharmacy.open_refill_work_items()'::regprocedure) and acl.grantee = 0)
    || ' ehr_api=' || has_function_privilege('hid_ehr_api_runtime', 'pharmacy.work_item_refills(uuid[])', 'EXECUTE')
    || '/' || has_function_privilege('hid_ehr_api_runtime', 'pharmacy.open_refill_work_items()', 'EXECUTE'),
    'as granted public=false ehr_api=false/false');
  -- 1j. What the duration means with refills, on the column the prescriber's
  -- refills live in and on its CHECK (skeptic's round 2: a course length
  -- entered as the duration holds every refill back for weeks): one fill's
  -- length, not the whole course.
  perform pg_temp.expect('1j the column and its CHECK say the duration is how long one fill lasts',
    (select position('the duration (0125''s duration_value and duration_unit) is how long ONE fill lasts, not the '
                     || 'whole course' in col_description('ehr.prescriptions'::regclass,
                       (select attnum from pg_attribute where attrelid = 'ehr.prescriptions'::regclass
                         and attname = 'refills_allowed'))) > 0
         and position('how long one fill lasts' in obj_description(
               (select oid from pg_constraint where conname = 'prescriptions_refills_allowed_ck'), 'pg_constraint')) > 0)::text,
    'true');
  -- 1k. R8, the refills' last day (the clinical owner's decision D9, 24
  -- November 2026): its body (md5), the owner, SQL, IMMUTABLE, PARALLEL
  -- SAFE, not SECURITY DEFINER, not STRICT, search_path, result; who may
  -- execute it, through any membership: the EHR runtime (and the EHR API's
  -- login through it) and the schema test runtime, the two that may write
  -- ehr.prescriptions (PostgreSQL runs R7's index expression as the writer);
  -- no other runtime, PUBLIC neither.
  select string_agg(format('%s=%s', role_row.rolname, has_function_privilege(role_row.oid,
           'ehr.prescription_refills_end_on(timestamptz,smallint,integer,text,date)', 'EXECUTE')), '; ')
    into mismatch
    from pg_roles role_row
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, 'ehr.prescription_refills_end_on(timestamptz,smallint,integer,text,date)',
           'EXECUTE')
         <> (role_row.rolname in ('hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime'));
  perform pg_temp.expect('1k R8 exactly; EXECUTE for the runtimes that may write prescriptions only',
    (select format('md5=%s owner=%s definer=%s volatile=%s parallel=%s strict=%s language=%s config=%s result=%s',
              md5(proc.prosrc), proc.proowner = owner_oid, proc.prosecdef, proc.provolatile, proc.proparallel,
              proc.proisstrict, language_row.lanname, proc.proconfig, pg_get_function_result(proc.oid))
       from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
      where proc.oid = 'ehr.prescription_refills_end_on(timestamptz,smallint,integer,text,date)'::regprocedure)
    || ' | ' || coalesce(mismatch, 'as granted') || ' public='
    || exists (select 1 from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                where proc.oid = 'ehr.prescription_refills_end_on(timestamptz,smallint,integer,text,date)'::regprocedure
                  and acl.grantee = 0),
    'md5=90de746d4d8377b6dfecabb5d323dc31 owner=t definer=f volatile=i parallel=s strict=f language=sql '
    || 'config={"search_path=pg_catalog, pg_temp"} result=date | as granted public=false');
  -- 1l. R9, the refill scan marker (the clinical owner's decision D8, 0143
  -- D1's form): the table (the owner's, two columns, its key, no row-level
  -- security, no grant); its test (md5, owner, SQL, STABLE, SECURITY
  -- DEFINER, cost 1, search_path; EXECUTE for PUBLIC alone besides the
  -- owner); the policy exactly (permissive, SELECT, PUBLIC, its printed
  -- expression by md5), the last read policy of ehr.prescriptions by name, so
  -- the first asked, and 0143's prescriptions_scan_my_orders the one before
  -- it, so the second asked (no read policy sorts between them: one would be
  -- asked before 0143's marker, inside its walk); no hid_ role but the owner
  -- a member of the table's owner.
  perform pg_temp.expect('1l R9: the marker table, its test and the policy, exactly',
    (select format('table owner=%s rls=%s columns=%s key=%s grants=%s', relation.relowner = owner_oid,
              relation.relrowsecurity,
              (select string_agg(attribute_row.attname || ' ' || format_type(attribute_row.atttypid, attribute_row.atttypmod),
                        ', ' order by attribute_row.attnum)
                 from pg_attribute attribute_row
                where attribute_row.attrelid = relation.oid and attribute_row.attnum > 0 and not attribute_row.attisdropped),
              (select string_agg(pg_get_constraintdef(constraint_row.oid), ', ') from pg_constraint constraint_row
                where constraint_row.conrelid = relation.oid),
              (select count(*) from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                where acl.grantee <> relation.relowner))
       from pg_class relation where relation.oid = 'pharmacy.refill_scans'::regclass)
    || ' | ' || (select format('test md5=%s owner=%s definer=%s volatile=%s cost=%s language=%s config=%s acl=%s',
                   md5(proc.prosrc), proc.proowner = owner_oid, proc.prosecdef, proc.provolatile, proc.procost,
                   language_row.lanname, proc.proconfig,
                   (select string_agg(case when acl.grantee = 0 then 'PUBLIC' else 'role' end || ':' || acl.privilege_type,
                             ',') from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                     where acl.grantee <> proc.proowner))
                   from pg_proc proc join pg_language language_row on language_row.oid = proc.prolang
                  where proc.oid = 'pharmacy.refill_scan_open()'::regprocedure)
    || ' | ' || (select format('policy cmd=%s permissive=%s roles=%s qual=%s check=%s', policy_row.polcmd,
                   policy_row.polpermissive, policy_row.polroles = array[0::oid],
                   md5(pg_get_expr(policy_row.polqual, policy_row.polrelid)), policy_row.polwithcheck is not null)
                   from pg_policy policy_row
                  where policy_row.polrelid = 'ehr.prescriptions'::regclass
                    and policy_row.polname = 'prescriptions_scan_refills')
    || ' | read policies after it=' || (select count(*) from pg_policy policy_row
                                         where policy_row.polrelid = 'ehr.prescriptions'::regclass
                                           and policy_row.polpermissive and policy_row.polcmd in ('r', '*')
                                           and policy_row.polname::text collate "C" > 'prescriptions_scan_refills')
    || ' | the two last by name=' || (select string_agg(last_two.polname, ',' order by last_two.polname collate "C")
                                       from (select policy_row.polname::text as polname from pg_policy policy_row
                                              where policy_row.polrelid = 'ehr.prescriptions'::regclass
                                                and policy_row.polpermissive and policy_row.polcmd in ('r', '*')
                                              order by policy_row.polname::text collate "C" desc limit 2) last_two)
    || ' | hid_ members of the owner=' || (select count(*) from pg_roles role_row
                                             where role_row.rolname like 'hid\_%' and role_row.oid <> owner_oid
                                               and pg_has_role(role_row.oid, owner_oid, 'MEMBER')),
    'table owner=t rls=f columns=backend_pid integer, transaction_started_at timestamp with time zone '
    || 'key=PRIMARY KEY (backend_pid, transaction_started_at) grants=0 | test md5=c06a06f770a690e456409803cc51b309 '
    || 'owner=t definer=t volatile=s cost=1 language=sql config={"search_path=pg_catalog, pg_temp"} '
    || 'acl=PUBLIC:EXECUTE | policy cmd=r permissive=t roles=t qual=98487317d1007ee3de2a0b8b5055f317 check=f | '
    || 'read policies after it=0 | the two last by name=prescriptions_scan_my_orders,prescriptions_scan_refills | '
    || 'hid_ members of the owner=0');
  -- 1m. R7's comment gives its cost for both kinds of session that may read
  -- the work items (the review of 24 November 2026, fifth round): one on the
  -- own-work basis (a pharmacist, about 0.15 ms per live refill
  -- prescription) and one that may read only on consent (a clinician or a
  -- nurse, which pays the consent test, about 1.5 to 3.9 ms per live refill
  -- prescription, measured in 0154's header); the first figure alone was
  -- given for both before.
  perform pg_temp.expect('1m R7''s comment gives its cost for own-work sessions and for sessions on consent alone',
    (select format('own-work=%s consent=%s',
              (position('For a session on the own-work basis (a pharmacist) about 0.15 ms per live refill prescription'
                        in description) > 0)::text,
              (position('A session that may read only on consent (a clinician or a nurse: pharmacy.work-item.read '
                        || 'without pharmacy.order-route.receive) pays the consent test instead' in description) > 0)::text)
       from obj_description('pharmacy.open_refill_work_items()'::regprocedure, 'pg_proc') description),
    'own-work=true consent=true');
end $$;

-- Fixtures. Organization O (e1520000...01) with facility F1 "Refills Test
-- Hospital" (e1520001...01, its own pharmacy); an outside pharmacy,
-- organization O4 "Refills Outside Pharmacy Ltd" (a governed, approved
-- pharmacy) with facility F4 (...04). Members (account e1520002...n, staff
-- e1520003...n, membership e1520004...n, role e1520005...n): 1 DR doctor F1
-- (write grants), 2 PH pharmacist F1 (no grant), 3 P4 pharmacist F4, 4 PG
-- pharmacist F1 (write grants, for case 13's consent test).
-- Patients (e1520006...n): 1 Ada (an active account, so an order route can
-- reach her), 2 Bisi.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'refills-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1520000-0000-4000-8000-000000000001', 'Refills Test Organization', 'refills-test-organization'),
  ('e1520000-0000-4000-8000-000000000004', 'Refills Outside Pharmacy Ltd', 'refills-outside-pharmacy');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1520001-0000-4000-8000-000000000001', 'e1520000-0000-4000-8000-000000000001', 'Refills Test Hospital',
   'REFILLS-1', 'Africa/Lagos', true, 'verified'),
  ('e1520001-0000-4000-8000-000000000004', 'e1520000-0000-4000-8000-000000000004', 'Refills Outside Pharmacy',
   'REFILLS-4', 'Africa/Lagos', true, 'verified');
create temporary table refills_members (n integer primary key, code text, role_code text, site integer,
  organization integer) on commit drop;
insert into refills_members values (1, 'dr', 'doctor', 1, 1), (2, 'ph', 'pharmacist', 1, 1), (3, 'p4', 'pharmacist', 4, 4),
  (4, 'pg', 'pharmacist', 1, 1);
grant select on refills_members to public;
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1520002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:refills-' || code,
       'refills-' || code || '@example.invalid', 'Refills ' || upper(code), 'active'
  from refills_members
union all
select 'e1520015-0000-4000-8000-000000000001', 'synthetic:refills-patient-ada', 'refills-ada@example.invalid',
       'Ada Refill', 'active';
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1520003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1520002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'Refills ' || upper(code),
       'refills-' || code || '@example.invalid', 'verified', role_code
  from refills_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1520004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1520003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1520002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1520000-0000-4000-8000-00000000000' || organization)::uuid,
       ('e1520001-0000-4000-8000-00000000000' || site)::uuid, role_code, role_code, true, true
  from refills_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1520005-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1520002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
       ('e1520004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1520001-0000-4000-8000-00000000000' || site)::uuid, 'Refills suite role'
  from refills_members;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1520006-0000-4000-8000-000000000001', 'e1520015-0000-4000-8000-000000000001', 'HID-RFLAAA2', 'Ada', 'Refill',
   'Ada Refill', 'female', '1990-04-05', 'active'),
  ('e1520006-0000-4000-8000-000000000002', null, 'HID-RFLBBB3', 'Bisi', 'Refill', 'Bisi Refill', 'female',
   '1985-01-02', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select gen_random_uuid(), ('e1520006-0000-4000-8000-00000000000' || patient)::uuid,
       ('e1520003-0000-4000-8000-00000000000' || member)::uuid, ('e1520002-0000-4000-8000-00000000000' || member)::uuid,
       ('e1520004-0000-4000-8000-00000000000' || member)::uuid, 'e1520001-0000-4000-8000-000000000001', 'write_records',
       'direct-care', 'active', 'Synthetic refills consent', clock_timestamp() - interval '1 hour',
       clock_timestamp() + interval '30 days'
  from generate_series(1, 2) patient cross join (values (1), (4)) granted(member);
-- The outside pharmacy (as 0133's, 0144's and 0148's suites): its governed
-- approval and product, and orders between facilities switched on
-- (control_settings readable by a non-superuser owner).
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
values ('e1520013-0000-4000-8000-000000000004', 'pharmacy', 'Refills Outside Pharmacy Ltd', 'pharmacy', 'RC9915204',
  'Refills Outside Admin', 'admin@refills-outside.invalid', 'approved', 'verified', '915204', clock_timestamp(),
  'e1520000-0000-4000-8000-000000000004', 'e1520001-0000-4000-8000-000000000004', 'e1520002-0000-4000-8000-000000000001',
  'Governed approval for the refills suite', clock_timestamp(), 'Refills Outside Pharmacy Ltd',
  'Private Company Limited by Shares', '2019-05-01', '9 Outside Road, Ikeja, Lagos', 'active');
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
values ('e1520000-0000-4000-8000-000000000004', 'pharmacy', 'e1520001-0000-4000-8000-000000000004', 'active',
  'e1520013-0000-4000-8000-000000000004');
set local session_replication_role = origin;
do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;
set local session_replication_role = replica;
update platform.control_settings set enabled = true
 where control_key in ('cross_facility_orders_enabled', 'cross_facility_route_access_enabled');
set local session_replication_role = origin;
select set_config('refills.attestation', (select text_row.version from ehr.order_route_attestation_texts text_row
  where text_row.kind = 'prescription' order by text_row.created_at desc, text_row.version desc limit 1), true);
-- The Lagos day, as 0154's validator computes it.
select set_config('refills.lagos_today', ((clock_timestamp() at time zone 'Africa/Lagos')::date)::text, true);

-- The session the services set (DatabaseService.withTransaction), with the
-- new images' own-work switch.
create function pg_temp.as_member(member integer) returns void language sql as $f$
  select set_config('app.own_facility_work', '0133', true),
         set_config('app.actor_subject', 'synthetic:refills-' || (select code from refills_members where n = member), true),
         set_config('app.facility_id', 'e1520001-0000-4000-8000-00000000000'
           || (select refills_members.site from refills_members where n = member), true),
         set_config('app.correlation_id', 'refills-' || substr(md5(random()::text), 1, 12), true),
         set_config('app.membership_id', 'e1520004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'), true),
         set_config('app.purpose_of_use', 'direct-care', true);
$f$;
create function pg_temp.rx(n integer) returns uuid language sql immutable as $f$
  select ('e1520007-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
create function pg_temp.account(member integer) returns uuid language sql immutable as $f$
  select ('e1520002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid
$f$;
create function pg_temp.membership(member integer) returns uuid language sql immutable as $f$
  select ('e1520004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid
$f$;
-- Owner reads (the suite runner's).
create function pg_temp.work_item_of(prescription uuid) returns uuid language sql security definer as $f$
  select id from pharmacy.work_items where source_ehr_prescription_id = prescription and order_route_id is null
$f$;
create function pg_temp.routed_item_of(prescription uuid) returns uuid language sql security definer as $f$
  select id from pharmacy.work_items where source_ehr_prescription_id = prescription and order_route_id is not null
$f$;
create function pg_temp.current_rx(n integer) returns ehr.prescriptions language sql security definer as $f$
  select * from ehr.prescriptions where id = pg_temp.rx(n)
$f$;
create function pg_temp.lagos_day(offset_days integer) returns date language sql stable as $f$
  select current_setting('refills.lagos_today')::date + offset_days
$f$;
-- The fills of a prescription's item: 'fill:reversed' each, by fill number,
-- and the claim (owner read).
create function pg_temp.fills(work_item uuid) returns text language sql security definer as $f$
  select coalesce(string_agg(dispensing.fill_number || case when reversal.id is null then '' else 'r' end, ' '
           order by dispensing.fill_number), 'none')
    from pharmacy.dispensings dispensing
    left join pharmacy.dispensing_reversals reversal on reversal.dispensing_id = dispensing.id
   where dispensing.work_item_id = work_item
$f$;
create function pg_temp.claim_is_first_fill(work_item uuid) returns text language sql security definer as $f$
  select (claim.dispensed_at = (select dispensing.dispensed_at from pharmacy.dispensings dispensing
                                 where dispensing.work_item_id = claim.work_item_id and dispensing.fill_number = 1))::text
    from pharmacy.prescription_item_claims claim where claim.work_item_id = work_item
$f$;
-- ehr-api's create (PrescriptionsService.create, an active prescription),
-- with refills_allowed as the new ehr-api names it while
-- PRESCRIPTION_REFILLS_ENABLED is on, and 0125's duration (30 days unless
-- the case names another, or none: null): 'ok' or the error.
create function pg_temp.prescribe_sql(n integer, patient integer, refills integer, ends_on date,
  duration_value integer default 30, duration_unit text default 'day') returns text
language sql as $f$
  select format($i$insert into ehr.prescriptions (
        id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
        medication_code_system, medication_code, medication_display, dose_quantity, dose_unit,
        route_code, frequency, instructions, starts_on, ends_on, status, refills_allowed, duration_value, duration_unit
      ) values (%L, %L, %L, 'e1520001-0000-4000-8000-000000000001', %L, %L, 'http://www.whocc.no/atc', 'J01CA04',
        %L, 1, 'capsule', 'oral', 'Every 8 hours', 'Take after food for 30 days', %L, %L, 'active', %s, %s, %L)$i$,
    pg_temp.rx(n), ('e1520008-0000-4000-8000-00000000000' || patient)::uuid,
    ('e1520006-0000-4000-8000-00000000000' || patient)::uuid, pg_temp.account(1), pg_temp.membership(1),
    'Amoxicillin 500 mg capsule (' || n || ')', least(pg_temp.lagos_day(-10), ends_on), ends_on,
    coalesce(refills::text, 'null'), coalesce(duration_value::text, 'null'),
    case when duration_value is null then null else duration_unit end)
$f$;
-- ehr-api's change of a prescription (PrescriptionsService.update, its exact
-- SET and WHERE), with the version the caller holds, as DR through the EHR
-- runtime: 'ok', 'no row', or the error.
create function pg_temp.dr(n integer, new_status text default null, new_frequency text default null,
  new_instructions text default null, new_ends_on text default null) returns text language plpgsql as $f$
declare
  current_row ehr.prescriptions := pg_temp.current_rx(n);
  changed_id text;
  answer text;
begin
  set local role hid_ehr_api_runtime;
  perform pg_temp.as_member(1);
  perform set_config('app.change_reason', 'Changed by the prescriber', true);
  begin
    execute 'update ehr.prescriptions set
               status = coalesce($1, status), frequency = coalesce($2, frequency),
               instructions = coalesce($3, instructions), ends_on = coalesce($4::date, ends_on)
             where id = $5 and encounter_id = $6 and patient_id = $7 and facility_id = $8 and row_version = $9
             returning id::text'
      into changed_id
      using new_status, new_frequency, new_instructions, new_ends_on, current_row.id, current_row.encounter_id,
        current_row.patient_id, current_row.facility_id, current_row.row_version;
    answer := case when changed_id is null then 'no row' else 'ok' end;
  exception when others then
    answer := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  return answer;
end
$f$;
-- 0133 D7's send, as ehr-api calls it after an active create: its answer.
create function pg_temp.send(n integer) returns text language plpgsql as $f$
declare answer text;
begin
  select string_agg(sent.outcome || case when sent.work_item_id is null then '' else ':item' end, ',') into answer
    from ehr.send_prescription_to_own_pharmacy(pg_temp.rx(n), (pg_temp.current_rx(n)).row_version) sent;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- pharmacy-api's dispensing INSERT (PharmacyService.dispense) by the
-- session's member; with a fill number, the new pharmacy-api's (fill_number
-- named); without one, today's (the column left to its default, 1, and
-- dispensed_at to its default, now). The suite's clock: 0154 opens a refill
-- 3/4 of the prescription's duration after the latest fill not reversed
-- (the Lagos day), so a fill with a number is recorded as of `as_of`, or else
-- 40 x (12 - its number) days ago: fill 1 440 days ago, fill 2 400 ... fill
-- 12 today, 40 days apart, after every interval of cases 2-14 (30 days: 23
-- days), as if the patient came back for each refill when due. pharmacy-api
-- never names dispensed_at (its default, the time of the INSERT); the
-- validator reads it only to find the latest fill's Lagos day, and compares
-- with today, never with the new row's time.
create function pg_temp.dispense_sql(work_item uuid, member integer, fill integer default null,
  as_of timestamptz default null) returns text
language sql security definer as $f$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id%s
      ) values (%L,%L,1,%L,%L,%L,%L,%L,30,'capsule',%L,%L,'Dispensed to the patient',%L,%L,%L%s)$i$,
    case when fill is null then '' else ',dispensed_at,fill_number' end,
    gen_random_uuid(), w.id, w.patient_id, w.facility_id, w.medication_code_system, w.medication_code,
    w.medication_display, pg_temp.account(member), pg_temp.membership(member),
    'refills-dispense-' || replace(gen_random_uuid()::text, '-', ''), repeat('d', 64),
    current_setting('app.correlation_id', true),
    case when fill is null then ''
         else ',' || quote_literal(coalesce(as_of, clock_timestamp() - make_interval(days => 40 * (12 - fill)))) || ','
              || fill end)
  from pharmacy.work_items w where w.id = work_item
$f$;
-- A fill of prescription n's own item (or its route-backed item) by a
-- member, through the Pharmacy runtime in that member's session (as of
-- `as_of`, or the suite's clock).
create function pg_temp.fill(n integer, fill integer, member integer default 2, routed boolean default false,
  as_of timestamptz default null)
returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(member);
  answer := pg_temp.try(pg_temp.dispense_sql(case when routed then pg_temp.routed_item_of(pg_temp.rx(n))
    else pg_temp.work_item_of(pg_temp.rx(n)) end, member, fill, as_of));
  reset role;
  return answer;
end
$f$;
-- A Lagos day and time as a timestamptz: noon by default.
create function pg_temp.lagos_at(offset_days integer, at_time time default time '12:00') returns timestamptz
language sql stable as $f$
  select (pg_temp.lagos_day(offset_days) + at_time) at time zone 'Africa/Lagos'
$f$;
-- Fills from..to of prescription n's own item by PH: each answer, joined.
create function pg_temp.fills_from(n integer, first_fill integer, last_fill integer) returns text language sql as $f$
  select string_agg(pg_temp.fill(n, fill_number), ',' order by fill_number)
    from generate_series(first_fill, last_fill) fill_number
$f$;
-- pharmacy-api's reversal INSERT (PharmacyService.reverse) of one fill of
-- prescription n's own item, by PH.
create function pg_temp.reverse_sql(n integer, fill integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,%L,%L,'Returned unopened by the patient',%L,%L,%L)$i$,
    gen_random_uuid(), d.id, d.work_item_id, d.patient_id, d.facility_id, pg_temp.account(2), pg_temp.membership(2),
    'refills-reverse-' || replace(gen_random_uuid()::text, '-', ''), repeat('e', 64),
    current_setting('app.correlation_id', true))
  from pharmacy.dispensings d where d.work_item_id = pg_temp.work_item_of(pg_temp.rx(n)) and d.fill_number = fill
$f$;
create function pg_temp.reverse(n integer, fill integer) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  answer := pg_temp.try(pg_temp.reverse_sql(n, fill));
  reset role;
  return answer;
end
$f$;
-- 0144's acceptance INSERT (pharmacy-api's accept) of prescription n's own
-- item by PH.
create function pg_temp.acceptance_sql(n integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.work_item_acceptances (work_item_id, patient_id, facility_id, accepted_by,
        accepted_by_membership_id, accepted_with, idempotency_key, request_sha256, correlation_id)
      values (%L, %L, %L, %L, %L, 'accept', %L, %L, %L)$i$,
    w.id, w.patient_id, w.facility_id, pg_temp.account(2), pg_temp.membership(2),
    'refills-accept-' || replace(gen_random_uuid()::text, '-', ''), repeat('c', 64),
    current_setting('app.correlation_id', true))
  from pharmacy.work_items w where w.id = pg_temp.work_item_of(pg_temp.rx(n))
$f$;
-- DR's order-route send of prescription n to F4's pharmacy, as the new
-- ehr-api calls it (the switch set): 'sent', or the error.
create function pg_temp.route_send(n integer) returns text language plpgsql as $f$
declare
  source ehr.prescriptions;
  sent record;
  key text := 'refills-route-' || replace(gen_random_uuid()::text, '-', '');
begin
  set local role hid_ehr_api_runtime;
  perform pg_temp.as_member(1);
  source := pg_temp.current_rx(n);
  select * into sent from ehr.send_order_route(gen_random_uuid(), 'prescription', source.patient_id, source.id,
    source.encounter_id, source.row_version, 'e1520001-0000-4000-8000-000000000004',
    current_setting('refills.attestation'), key, encode(sha256(key::bytea), 'hex'));
  perform set_config('refills.route_' || n, sent.route_id::text, true);
  reset role;
  return 'sent';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- A route's version (owner read).
create function pg_temp.route_version(n integer) returns bigint language sql security definer as $f$
  select route.row_version from ehr.order_routes route where route.id = current_setting('refills.route_' || n)::uuid
$f$;
-- P4's acceptance of prescription n's route at F4 (pharmacy-api's call).
create function pg_temp.route_accept(n integer) returns text language plpgsql as $f$
declare accepted record;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(3);
  select * into accepted from pharmacy.accept_order_route(current_setting('refills.route_' || n)::uuid,
    pg_temp.route_version(n),
    'health_id', 'HID-RFLAAA2', 'Patient collected the prescription',
    'refills-route-accept-' || n || '-' || substr(md5(random()::text), 1, 8), repeat('a', 64));
  reset role;
  return accepted.result;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- 0148's reader as PH, for prescriptions' own items: 'rxN:change/count'.
create function pg_temp.ph_reads(prescriptions integer[]) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  select coalesce(string_agg(format('rx%s:%s/%s', p, coalesce(reader.change, '-'), reader.change_count), ' ' order by p),
           'none')
    into answer
    from unnest(prescriptions) p
    join pharmacy.work_item_changes_after_dispensing(array(select pg_temp.work_item_of(pg_temp.rx(q))
           from unnest(prescriptions) q)) reader on reader.work_item_id = pg_temp.work_item_of(pg_temp.rx(p));
  reset role;
  return answer;
end
$f$;
-- 0148's fingerprint of a prescription as it stands: as 0148's recorder
-- computes it, and as it computed it before 0154 added the column (the row
-- as jsonb had no refills_allowed key at all).
create function pg_temp.fingerprints(n integer) returns text language sql security definer as $f$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_strip_nulls(pg_catalog.to_jsonb(p)
           - array['status', 'row_version', 'created_at', 'updated_at']::text[])::text, 'UTF8')), 'hex') || ' '
         || encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_strip_nulls(pg_catalog.to_jsonb(p)
           - array['status', 'row_version', 'created_at', 'updated_at', 'refills_allowed']::text[])::text, 'UTF8')), 'hex')
    from ehr.prescriptions p where p.id = pg_temp.rx(n)
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', proc.signature);
  end loop;
end $$;

-- The EHR rows, through the EHR runtime with ehr-api's statements, as DR at
-- F1: encounters E1 (Ada) and E2 (Bisi); prescriptions, each written active
-- and sent to F1's own pharmacy (0133 D7) as ehr-api does:
--   rx1 refills 0, rx2 1, rx3 2, rx4 11, rx5 null (case 2);
--   rx6 refills 2 ending today (Lagos), rx7 refills 2 ended yesterday (3);
--   rx8 and rx9 refills 2, sent to F4 (4);
--   rx10, rx11, rx12 refills 2 (5);
--   rx13 refills 2 (6); rx14 refills null, never dispensed (7);
--   rx15 refills 1 (8); rx16 refills null, rx17 refills 2, rx18 refills 2 (9);
--   rx19 refills 1 (12); rx20 refills 2, rx21 refills 2 ending today
--   (Lagos), rx22 refills 2, rx23 refills 1 (13).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e1520008-0000-4000-8000-00000000000' || n)::uuid, ('e1520006-0000-4000-8000-00000000000' || n)::uuid,
       'e1520001-0000-4000-8000-000000000001', pg_temp.account(1), pg_temp.membership(1), 'ambulatory', 'in_progress',
       clock_timestamp()
  from generate_series(1, 2) n;
create temporary table refills_prescriptions (n integer primary key, patient integer, refills integer, ends_on date)
  on commit drop;
insert into refills_prescriptions values
  (1, 2, 0, null), (2, 2, 1, null), (3, 2, 2, null), (4, 2, 11, null), (5, 2, null, null),
  (6, 2, 2, pg_temp.lagos_day(0)), (7, 2, 2, pg_temp.lagos_day(-1)), (8, 1, 2, null), (9, 1, 2, null),
  (10, 2, 2, null), (11, 2, 2, null), (12, 2, 2, null), (13, 2, 2, null), (14, 2, null, null), (15, 2, 1, null),
  (16, 2, null, null), (17, 2, 2, null), (18, 2, 2, null), (19, 2, 1, null), (20, 2, 2, null),
  (21, 2, 2, pg_temp.lagos_day(0)), (22, 2, 2, null), (23, 2, 1, null);
grant select on refills_prescriptions to public;
select pg_temp.expect('fixtures: DR writes the prescriptions (active, refills_allowed as given) and D7 sends each',
  (select string_agg(distinct pg_temp.try(pg_temp.prescribe_sql(n, patient, refills,
     coalesce(ends_on, pg_temp.lagos_day(30)))) || ' ' || pg_temp.send(n), ',') from refills_prescriptions), 'ok sent:item');
reset role;
select pg_temp.expect('fixtures: refills_allowed as written; each own item at version 1',
  (select string_agg(format('%s:%s', p.n, coalesce(prescription.refills_allowed::text, 'null')), ' ' order by p.n)
     from refills_prescriptions p join ehr.prescriptions prescription on prescription.id = pg_temp.rx(p.n))
  || ' | ' || (select count(*) from pharmacy.work_items item join refills_prescriptions p
                 on item.source_ehr_prescription_id = pg_temp.rx(p.n)
               where item.order_route_id is null and item.source_ehr_prescription_version = 1),
  '1:0 2:1 3:2 4:11 5:null 6:2 7:2 8:2 9:2 10:2 11:2 12:2 13:2 14:null 15:1 16:null 17:2 18:2 19:1 20:2 21:2 22:2 '
  || '23:1 | 23');

-- 2. Fills 1 to 1 + N, then N + 2 refused, through the Pharmacy runtime as
-- PH (no grant, own work).
select pg_temp.expect('2a N=0 (rx1): fill 1 passes, fill 2 is refused NO_REFILLS_LEFT',
  pg_temp.fills_from(1, 1, 2), 'ok,23514 NO_REFILLS_LEFT / -');
select pg_temp.expect('2b N=1 (rx2): fills 1-2 pass, fill 3 is refused',
  pg_temp.fills_from(2, 1, 3), 'ok,ok,23514 NO_REFILLS_LEFT / -');
select pg_temp.expect('2c N=2 (rx3): fills 1-3 pass, fill 4 is refused',
  pg_temp.fills_from(3, 1, 4), 'ok,ok,ok,23514 NO_REFILLS_LEFT / -');
select pg_temp.expect('2d N=11 (rx4): fills 1-12 pass, fill 13 is refused (the validator answers before the CHECK)',
  pg_temp.fills_from(4, 1, 13), 'ok,ok,ok,ok,ok,ok,ok,ok,ok,ok,ok,ok,23514 NO_REFILLS_LEFT / -');
select pg_temp.expect('2e null refills_allowed (rx5): one fill',
  pg_temp.fills_from(5, 1, 2), 'ok,23514 NO_REFILLS_LEFT / -');
select pg_temp.expect('2f the fills recorded, and each claim''s dispensed_at is still the first fill''s',
  (select string_agg(format('rx%s:%s:%s', n, pg_temp.fills(pg_temp.work_item_of(pg_temp.rx(n))),
     pg_temp.claim_is_first_fill(pg_temp.work_item_of(pg_temp.rx(n)))), ' ' order by n) from generate_series(1, 5) n),
  'rx1:1:true rx2:1 2:true rx3:1 2 3:true rx4:1 2 3 4 5 6 7 8 9 10 11 12:true rx5:1:true');

-- 3. The end date (rx6 ends today, rx7 ended yesterday, both Lagos days;
-- the refills' last day, R8, is ends_on for both: they were written today).
-- The refusal's DETAIL is that last day (D9).
select pg_temp.expect('3a rx7 ended yesterday: its first fill still passes, a refill is refused REFILL_PRESCRIPTION_ENDED',
  pg_temp.fills_from(7, 1, 2), 'ok,23514 REFILL_PRESCRIPTION_ENDED / ' || to_char(pg_temp.lagos_day(-1), 'YYYY-MM-DD'));
select pg_temp.expect('3b rx6 ends today (the last day counts): fills 1 and 2 pass', pg_temp.fills_from(6, 1, 2), 'ok,ok');
-- The Lagos day whatever the session's time zone: at any hour, one of
-- these two zones is on another calendar day than Lagos.
set local timezone = 'Pacific/Kiritimati';
select pg_temp.expect('3c under TimeZone Pacific/Kiritimati (UTC+14): rx6''s fill 3 passes, rx7''s refill is refused',
  pg_temp.fill(6, 3) || ',' || pg_temp.fill(7, 2),
  'ok,23514 REFILL_PRESCRIPTION_ENDED / ' || to_char(pg_temp.lagos_day(-1), 'YYYY-MM-DD'));
set local timezone = 'Etc/GMT+12';
select pg_temp.expect('3d under TimeZone Etc/GMT+12 (UTC-12): rx7''s refill is still refused, rx6 has no refill left',
  pg_temp.fill(7, 2) || ',' || pg_temp.fill(6, 4),
  '23514 REFILL_PRESCRIPTION_ENDED / ' || to_char(pg_temp.lagos_day(-1), 'YYYY-MM-DD') || ',23514 NO_REFILLS_LEFT / -');
reset timezone;

-- 4. Route-backed items: rx8 and rx9 (refills 2) are sent to F4 before F1's
-- pharmacy dispenses them (their own items released) and P4 accepts both.
select pg_temp.expect('4 fixtures: rx8 and rx9 sent to F4 and accepted there',
  pg_temp.route_send(8) || ' ' || pg_temp.route_send(9) || ' ' || pg_temp.route_accept(8) || ' ' || pg_temp.route_accept(9),
  'sent sent accepted accepted');
select pg_temp.expect('4a rx8 at F4: fill 1 passes; fill 2 is refused (the first fill completed the route)',
  pg_temp.fill(8, 1, 3, true) || ',' || pg_temp.fill(8, 2, 3, true), 'ok,23514 ORDER_ROUTE_CLOSED / -');
select pg_temp.expect('4b rx9 at F4, its route still accepted: a fill 2 as its first is refused NO_REFILLS_LEFT',
  pg_temp.fill(9, 2, 3, true), '23514 NO_REFILLS_LEFT / -');
select pg_temp.expect('4c rx8''s own item at F1 (released by the route): a first fill and a refill are refused by the '
    || 'claim, sent elsewhere',
  pg_temp.fill(8, 1) || ',' || pg_temp.fill(8, 2), '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / sent_elsewhere,'
  || '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / sent_elsewhere');

-- 5. Any change after the first fill ends the refills (0101's check of the
-- version and the status).
select pg_temp.expect('5a rx10: fill 1, an edit by DR, then a refill is refused',
  pg_temp.fill(10, 1) || ' ' || pg_temp.dr(10, new_instructions => 'Take after food for 20 days') || ' '
  || pg_temp.fill(10, 2), 'ok ok 23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / -');
select pg_temp.expect('5b rx11: fill 1, held and resumed, then a refill is refused',
  pg_temp.fill(11, 1) || ' ' || pg_temp.dr(11, 'on_hold') || ' ' || pg_temp.dr(11, 'active') || ' ' || pg_temp.fill(11, 2),
  'ok ok ok 23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / -');
select pg_temp.expect('5c rx12: fill 1, completed, then a refill is refused',
  pg_temp.fill(12, 1) || ' ' || pg_temp.dr(12, 'completed') || ' ' || pg_temp.fill(12, 2),
  'ok ok 23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / -');

-- 6. Double dispensing on rx13 (refills 2). Two refills recorded at once
-- both pass the validator (its FOR SHARE does not wait for another FOR
-- SHARE) and carry the same fill number (both counted one fill); the
-- second meets the key (PostgreSQL leaves the key's values out of the
-- message under row-level security). Today's pharmacy-api (no fill number)
-- records fill 1 again: the key too.
select pg_temp.expect('6a rx13: fill 1, then two refills numbered 2: the second meets the key',
  pg_temp.fill(13, 1) || ' ' || pg_temp.fill(13, 2) || ' ' || pg_temp.fill(13, 2),
  'ok ok 23505 duplicate key value violates unique constraint "dispensings_work_item_fill_number_key" / -');
select pg_temp.expect('6b rx13: today''s pharmacy-api INSERT (no fill number) is fill 1 again: the key',
  split_part(pg_temp.fill(13, null), ' / ', 1), '23505 duplicate key value violates unique constraint "dispensings_work_item_fill_number_key"');
select pg_temp.expect('6c a fill number of 0, or null: the CHECK and NOT NULL',
  split_part(pg_temp.fill(13, 0), ' / ', 1) || ' | ' || left(pg_temp.try(replace(pg_temp.dispense_sql(
    pg_temp.work_item_of(pg_temp.rx(13)), 2, 3), ',3)', ',null)')), 5),
  '23514 new row for relation "dispensings" violates check constraint "dispensings_fill_number_ck" | 23502');
select pg_temp.expect('6d rx13 holds fills 1 and 2', pg_temp.fills(pg_temp.work_item_of(pg_temp.rx(13))), '1 2');

-- 7. Replica mode: the validator (origin mode) does not fire; 0133's claim
-- (always) does, and so do the CHECK and the key. Each in a savepoint.
savepoint refills_replica;
set local session_replication_role = replica;
select pg_temp.expect('7a replica: a refill of rx8''s route-backed item (dispensed at F4) is refused by the claim',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.routed_item_of(pg_temp.rx(8)), 3, 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / not_claimed');
select pg_temp.expect('7b replica: a refill of rx8''s own item (sent elsewhere) is refused by the claim',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(8)), 2, 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / sent_elsewhere');
select pg_temp.expect('7c replica: a refill of rx14 (never dispensed) is refused by the claim',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(14)), 2, 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / not_claimed');
select pg_temp.expect('7d replica: fill 13 meets the CHECK, a fill number taken meets the key',
  split_part(pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2, 13)), ' / ', 1) || ' | '
  || left(pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2, 1)), 5),
  '23514 new row for relation "dispensings" violates check constraint "dispensings_fill_number_ck" | 23505');
select pg_temp.expect('7e replica (stated limit): the refill count and the end date are not enforced; rx1 (no refills) '
    || 'and rx7 (ended) take a refill',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2, 2)) || ' '
  || pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(7)), 2, 2)), 'ok ok');
set local session_replication_role = origin;
rollback to savepoint refills_replica;

-- 8. A reversed fill still counts (rx15, refills 1).
select pg_temp.expect('8a rx15: fill 1, reversed; fill 2 passes; fill 3 is refused',
  pg_temp.fill(15, 1) || ' ' || pg_temp.reverse(15, 1) || ' ' || pg_temp.fill(15, 2) || ' ' || pg_temp.fill(15, 3),
  'ok ok ok 23514 NO_REFILLS_LEFT / -');
select pg_temp.expect('8b rx15: fill 2 reversed too; still no fill 3; a reversed fill number is not taken again',
  pg_temp.reverse(15, 2) || ' ' || pg_temp.fill(15, 3) || ' ' || left(pg_temp.fill(15, 2), 5) || ' '
  || pg_temp.fills(pg_temp.work_item_of(pg_temp.rx(15))), 'ok 23514 NO_REFILLS_LEFT / - 23505 1r 2r');

-- 9. 0148's fingerprints (its recorder is not replaced). 9a: rx16 (null
-- refills_allowed) fingerprints as it did before 0154 added the column (the
-- row as jsonb then had no refills_allowed key; jsonb_strip_nulls removes a
-- null one now); rx17 (2) does not, and needs no such equality: every row
-- recorded for it is from after 0154.
select pg_temp.expect('9a a null refills_allowed changes no fingerprint; a set one is part of it',
  (select (split_part(pg_temp.fingerprints(16), ' ', 1) = split_part(pg_temp.fingerprints(16), ' ', 2))::text || ' '
     || (split_part(pg_temp.fingerprints(17), ' ', 1) = split_part(pg_temp.fingerprints(17), ' ', 2))::text),
  'true false');
-- 9b: a hold of rx16 recorded before 0154 (written here by the owner exactly
-- as 0148's recorder wrote it then: the next version, active to on_hold,
-- both fingerprints of the row without a refills_allowed key), then DR's
-- hold (0148's recorder finds that version recorded: on conflict nothing)
-- and DR's resume after 0154: 'resumed', as before.
select pg_temp.expect('9b fixtures: rx16 dispensed', pg_temp.fill(16, 1), 'ok');
insert into pharmacy.prescription_changes_after_dispensing (work_item_id, facility_id, prescription_version, status_before,
  status_after, prior_content_sha256, content_sha256, changed_at)
select claim.work_item_id, claim.facility_id, prescription.row_version + 1, 'active', 'on_hold',
       decode(split_part(pg_temp.fingerprints(16), ' ', 2), 'hex'), decode(split_part(pg_temp.fingerprints(16), ' ', 2), 'hex'),
       clock_timestamp()
  from pharmacy.prescription_item_claims claim join ehr.prescriptions prescription on prescription.id = claim.prescription_id
 where claim.prescription_id = pg_temp.rx(16) and claim.dispensed_at is not null;
select pg_temp.expect('9b rx16: a hold recorded before 0154, then held and resumed after it: resumed',
  pg_temp.dr(16, 'on_hold') || ' ' || pg_temp.dr(16, 'active') || ' ' || pg_temp.ph_reads(array[16]), 'ok ok rx16:resumed/2');
-- 9c: rx17 (refills 2), dispensed, held and resumed after 0154: the value is
-- on both sides of the comparison: 'resumed'.
select pg_temp.expect('9c rx17 (refills 2): dispensed, held, resumed: resumed',
  pg_temp.fill(17, 1) || ' ' || pg_temp.dr(17, 'on_hold') || ' ' || pg_temp.dr(17, 'active') || ' '
  || pg_temp.ph_reads(array[17]), 'ok ok ok rx17:resumed/2');
-- 9d: rx18 (refills 2), dispensed; the owner repairs refills_allowed in DR's
-- session (ehr-api never changes it): the pharmacy is shown 'edited', and
-- the change of version ends the refills.
select pg_temp.expect('9d fixtures: rx18 dispensed', pg_temp.fill(18, 1), 'ok');
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Corrected the number of refills', true);
update ehr.prescriptions set refills_allowed = 3 where id = pg_temp.rx(18);
select pg_temp.expect('9d an owner repair of refills_allowed after dispensing reads edited, and the next refill is refused',
  pg_temp.ph_reads(array[18]) || ' ' || pg_temp.fill(18, 2), 'rx18:edited/1 23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / -');

-- 10. Release A's and B's shapes after refills (rx3 holds three fills).
-- 0144: no acceptance after a fill (refills need none); 0133's states and
-- 0144's steps readers: one row per item, not withdrawn.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('10a an acceptance of rx3''s item after its refills is refused, not claimed',
  pg_temp.try(pg_temp.acceptance_sql(3)), '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / not_claimed');
select pg_temp.expect('10b 0133''s states and 0144''s steps readers: one row per item, not withdrawn',
  (select count(*) || ':' || bool_or(state.withdrawn)
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(3)), pg_temp.work_item_of(pg_temp.rx(4))]) state)
  || ' ' || (select count(*) || ':' || bool_or(step.withdrawn)
     from pharmacy.own_work_item_steps(array[pg_temp.work_item_of(pg_temp.rx(3)), pg_temp.work_item_of(pg_temp.rx(4))]) step),
  '2:false 2:false');
reset role;

-- 11. refills_allowed's CHECK, on ehr-api's create and on an owner UPDATE
-- (each undone).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
savepoint refills_check;
select pg_temp.expect('11a 0, 11 and null pass on create; -1 and 12 are refused',
  pg_temp.try(pg_temp.prescribe_sql(40, 2, 0, pg_temp.lagos_day(30))) || ' '
  || pg_temp.try(pg_temp.prescribe_sql(41, 2, 11, pg_temp.lagos_day(30))) || ' '
  || pg_temp.try(pg_temp.prescribe_sql(42, 2, null, pg_temp.lagos_day(30))) || ' | '
  || split_part(pg_temp.try(pg_temp.prescribe_sql(43, 2, -1, pg_temp.lagos_day(30))), ' / ', 1) || ' | '
  || left(pg_temp.try(pg_temp.prescribe_sql(44, 2, 12, pg_temp.lagos_day(30))), 5),
  'ok ok ok | 23514 new row for relation "prescriptions" violates check constraint "prescriptions_refills_allowed_ck" | '
  || '23514');
rollback to savepoint refills_check;
reset role;
savepoint refills_check;
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Corrected the number of refills', true);
select pg_temp.expect('11b an UPDATE to 12 is refused',
  left(pg_temp.try(format('update ehr.prescriptions set refills_allowed = 12 where id = %L', pg_temp.rx(14))), 5), '23514');
rollback to savepoint refills_check;

-- 12. The undo of 0154's header, step 1: 0101's and 0133's bodies put back
-- (no table lock). Every refill is then refused by 0133's claim (any image),
-- a first fill still passes, and fill numbers stay as recorded.
savepoint refills_undo;
create or replace function pharmacy.validate_dispensing()
returns trigger language plpgsql security definer
set search_path = pharmacy, platform, pg_temp as $$
declare
  parent_row pharmacy.work_items%rowtype;
  route_row ehr.order_routes%rowtype;
  session_facility_id uuid := platform.current_facility_id();
  session_account_id uuid := platform.current_account_id();
  session_membership_id uuid := platform.current_membership_id();
  source_row ehr.prescriptions%rowtype;
begin
  select * into parent_row from pharmacy.work_items where id = new.work_item_id;
  if parent_row.order_route_id is not null then
    select route.* into route_row from ehr.order_routes route where route.id = parent_row.order_route_id for update;
    if route_row.id is null or route_row.state is distinct from 'accepted'
       or not coalesce(clock_timestamp() < route_row.writes_end_at, false) then
      raise exception using errcode = '23514', message = 'ORDER_ROUTE_CLOSED';
    end if;
  end if;
  if parent_row.id is null
     or session_facility_id is null
     or session_account_id is null
     or session_membership_id is null
     or parent_row.patient_id is distinct from new.patient_id
     or parent_row.facility_id is distinct from new.facility_id
     or parent_row.row_version is distinct from new.work_item_version
     or parent_row.medication_code_system is distinct from new.medication_code_system
     or parent_row.medication_code is distinct from new.medication_code
     or parent_row.medication_display is distinct from new.medication_display
     or new.facility_id is distinct from session_facility_id
     or new.dispensed_by is distinct from session_account_id
     or new.dispensed_by_membership_id is distinct from session_membership_id then
    raise exception using errcode = '23514',
      message = 'Dispensing does not match its eligible Pharmacy work item and actor context';
  end if;
  -- Same facility: dispensable only while the EHR prescription the work item
  -- names is still active, at the version Pharmacy accepted, for its patient,
  -- facility and encounter. Read FOR SHARE until commit, so the EHR cannot
  -- cancel or change it under the dispensing. Read as this function's owner:
  -- under production's forced row-level security only a prescription the
  -- session may read and write is found, and any other is not dispensable.
  if parent_row.order_route_id is null then
    select prescription.* into source_row
      from ehr.prescriptions prescription
     where prescription.id = parent_row.source_ehr_prescription_id
       for share;
    if source_row.id is null
       or source_row.patient_id is distinct from parent_row.patient_id
       or source_row.facility_id is distinct from parent_row.facility_id
       or source_row.encounter_id is distinct from parent_row.source_encounter_id
       or source_row.status is distinct from 'active'
       or source_row.row_version is distinct from parent_row.source_ehr_prescription_version then
      raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE';
    end if;
  end if;
  return new;
end
$$;
create or replace function pharmacy.claim_prescription_dispensing()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update pharmacy.prescription_item_claims claim
     set dispensed_at = new.dispensed_at
   where claim.work_item_id = new.work_item_id and claim.released_at is null and claim.dispensed_at is null;
  if not found then
    raise exception using errcode = '23514', message = 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE',
      detail = case when exists (select 1 from pharmacy.prescription_item_claims claim
                                  where claim.work_item_id = new.work_item_id and claim.released_at is not null)
                    then 'sent_elsewhere' else 'not_claimed' end;
  end if;
  return null;
end;
$$;
select pg_temp.expect('12 undo step 1: the bodies are 0101''s and 0133''s; rx19''s first fill passes, its refill is '
    || 'refused, rx3 keeps its fills',
  (select string_agg(md5(proc.prosrc), ' ' order by proc.proname) from pg_proc proc
    where proc.oid in ('pharmacy.validate_dispensing()'::regprocedure,
            'pharmacy.claim_prescription_dispensing()'::regprocedure)) || ' '
  || pg_temp.fill(19, 1) || ' ' || pg_temp.fill(19, 2) || ' ' || pg_temp.fills(pg_temp.work_item_of(pg_temp.rx(3))),
  '2c7f20d7c0df7c582bccc0291f452fdd 17f7e8897bd2ab240332e4d2c9f757b7 ok '
  || '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / not_claimed 1 2 3');
rollback to savepoint refills_undo;
select pg_temp.expect('12 after the undo''s savepoint: 0154''s bodies again, and rx19 takes fills 1 and 2',
  (select string_agg(md5(proc.prosrc), ' ' order by proc.proname) from pg_proc proc
    where proc.oid in ('pharmacy.validate_dispensing()'::regprocedure,
            'pharmacy.claim_prescription_dispensing()'::regprocedure)) || ' ' || pg_temp.fills_from(19, 1, 3),
  '1a50612f5330a36c9b64d0d831c77812 06be902c41bcd4ee65f7f840c120db8f ok,ok,23514 NO_REFILLS_LEFT / -');

-- 13. The reader, pharmacy.work_item_refills (0154's R6), through the
-- Pharmacy runtime as the services call it. 'rxN:allowed/recorded/open/
-- reason/next' for each row it answers ('-' for no reason; next is
-- next_fill_on in days from today in Lagos, '-' for none), by
-- prescription; the prescriptions' own items are asked for (route-backed
-- ones with routed). With the suite's clock, fill k was recorded 40 x
-- (12 - k) days ago and every prescription lasts 30 days (a 23-day
-- interval), so after fill 1 the next fill opened 417 days ago, after fill
-- 2 377 days ago.
-- The suite runs under a superuser owner and under a NOSUPERUSER
-- NOBYPASSRLS one with the same expectations, so both answer alike.
create function pg_temp.item_of(n integer, routed boolean) returns uuid language sql as $f$
  select case when routed then pg_temp.routed_item_of(pg_temp.rx(n)) else pg_temp.work_item_of(pg_temp.rx(n)) end
$f$;
create function pg_temp.session_of(member integer, own_work boolean) returns void language plpgsql as $f$
begin
  perform pg_temp.as_member(member);
  if not own_work then
    perform set_config('app.own_facility_work', '', true);
  end if;
end
$f$;
create function pg_temp.refills(member integer, prescriptions integer[], own_work boolean default true,
  routed boolean default false) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.session_of(member, own_work);
  select coalesce(string_agg(format('rx%s:%s/%s/%s/%s/%s', p, reader.refills_allowed, reader.fills_recorded,
           reader.refill_open::text, coalesce(reader.closed_reason, '-'),
           coalesce((reader.next_fill_on - pg_temp.lagos_day(0))::text, '-')), ' ' order by p), 'none')
    into answer
    from unnest(prescriptions) p
    join pharmacy.work_item_refills(array(select pg_temp.item_of(q, routed) from unnest(prescriptions) q)) reader
      on reader.work_item_id = pg_temp.item_of(p, routed);
  reset role;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- What the Pharmacy runtime itself may select in that session (row-level
-- security on pharmacy.work_items and pharmacy.dispensings): 'rxN:fills'
-- for each own item it may read.
create function pg_temp.runtime_sees(member integer, prescriptions integer[], own_work boolean default true)
returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.session_of(member, own_work);
  select coalesce(string_agg(format('rx%s:%s', p, (select count(*) from pharmacy.dispensings dispensing
                                                    where dispensing.work_item_id = item.id)), ' ' order by p), 'none')
    into answer
    from unnest(prescriptions) p
    join pharmacy.work_items item on item.id = pg_temp.work_item_of(pg_temp.rx(p)) and item.order_route_id is null;
  reset role;
  return answer;
end
$f$;
-- The reader's ids as given, as PH: 'rows=N' or the error.
create function pg_temp.refills_of_ids(ids uuid[]) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  select 'rows=' || count(*) into answer from pharmacy.work_item_refills(ids);
  reset role;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- Whether the reader's refill_open (as PH) is what the next fill (fills
-- recorded + 1, by PH, undone at once) does: 'rxN:open=ok' or
-- 'rxN:closed=refused', else the disagreement.
create function pg_temp.next_fill_agrees(n integer) returns text language plpgsql as $f$
declare
  reader record;
  outcome text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  select * into reader from pharmacy.work_item_refills(array[pg_temp.work_item_of(pg_temp.rx(n))]);
  reset role;
  begin
    outcome := pg_temp.fill(n, reader.fills_recorded + 1);
    raise exception using errcode = 'P0001', message = 'refills: undo the next fill';
  exception when raise_exception then
    null;
  end;
  return format('rx%s:%s', n, case when reader.refill_open and outcome = 'ok' then 'open=ok'
                                   when not reader.refill_open and outcome <> 'ok' then 'closed=refused'
                                   else 'open=' || reader.refill_open || ' but ' || outcome end);
end
$f$;
grant execute on function pg_temp.item_of(integer, boolean), pg_temp.session_of(integer, boolean),
  pg_temp.refills(integer, integer[], boolean, boolean), pg_temp.runtime_sees(integer, integer[], boolean),
  pg_temp.refills_of_ids(uuid[]), pg_temp.next_fill_agrees(integer) to public;

-- 13a. Every item of cases 2-12, as those cases left it (case 7's and 11's
-- and 12's undone parts aside), as PH (no grant, the own-work switch).
select pg_temp.expect('13a the items of cases 2-12: allowed (null as 0), fills recorded, open, closed reason',
  pg_temp.refills(2, array(select generate_series(1, 19))),
  'rx1:0/1/false/none_left/- rx2:1/2/false/none_left/- rx3:2/3/false/none_left/- rx4:11/12/false/none_left/- '
  || 'rx5:0/1/false/none_left/- rx6:2/3/false/none_left/- rx7:2/1/false/ended/- rx8:2/0/false/-/- rx9:2/0/false/-/- '
  || 'rx10:2/1/false/changed/- rx11:2/1/false/changed/- rx12:2/1/false/stopped/- rx13:2/2/true/-/-377 '
  || 'rx14:0/0/false/-/- rx15:1/2/false/none_left/- rx16:0/1/false/none_left/- rx17:2/1/false/changed/- '
  || 'rx18:3/1/false/changed/- rx19:1/2/false/none_left/-');
-- 13b. One item through its fills (rx22, refills 2): no fill (closed, no
-- reason), fill 1 and fill 2 (open), fill 3 (none left).
select pg_temp.expect('13b rx22: no fill, fill 1, fill 2, fill 3',
  pg_temp.refills(2, array[22]) || ' ' || pg_temp.fill(22, 1) || ' ' || pg_temp.refills(2, array[22]) || ' '
  || pg_temp.fill(22, 2) || ' ' || pg_temp.refills(2, array[22]) || ' ' || pg_temp.fill(22, 3) || ' '
  || pg_temp.refills(2, array[22]),
  'rx22:2/0/false/-/- ok rx22:2/1/true/-/-417 ok rx22:2/2/true/-/-377 ok rx22:2/3/false/none_left/-');
-- 13c. rx20 (refills 2): fill 1 (open); DR holds it (stopped); DR resumes
-- it (changed: a new version).
select pg_temp.expect('13c rx20: open after fill 1, stopped while held, changed once resumed',
  pg_temp.fill(20, 1) || ' ' || pg_temp.refills(2, array[20]) || ' ' || pg_temp.dr(20, 'on_hold') || ' '
  || pg_temp.refills(2, array[20]) || ' ' || pg_temp.dr(20, 'active') || ' ' || pg_temp.refills(2, array[20]),
  'ok rx20:2/1/true/-/-417 ok rx20:2/1/false/stopped/- ok rx20:2/1/false/changed/-');
-- 13d. rx23 (refills 1): fill 1, then DR cancels it: stopped.
select pg_temp.expect('13d rx23: cancelled after fill 1: stopped',
  pg_temp.fill(23, 1) || ' ' || pg_temp.dr(23, 'cancelled') || ' ' || pg_temp.refills(2, array[23]),
  'ok ok rx23:1/1/false/stopped/-');
-- 13e. The Lagos day: rx21 ends today (open after fill 1), rx7 ended
-- yesterday (ended), whatever the session's time zone (at any hour, one of
-- the two far zones is on another calendar day than Lagos).
select pg_temp.expect('13e rx21 ends today: open after fill 1; rx7 ended yesterday',
  pg_temp.fill(21, 1) || ' ' || pg_temp.refills(2, array[7, 21]), 'ok rx7:2/1/false/ended/- rx21:2/1/true/-/-417');
set local timezone = 'Pacific/Kiritimati';
select pg_temp.expect('13e under TimeZone Pacific/Kiritimati (UTC+14): the same',
  pg_temp.refills(2, array[7, 21]), 'rx7:2/1/false/ended/- rx21:2/1/true/-/-417');
set local timezone = 'Etc/GMT+12';
select pg_temp.expect('13e under TimeZone Etc/GMT+12 (UTC-12): the same',
  pg_temp.refills(2, array[7, 21]), 'rx7:2/1/false/ended/- rx21:2/1/true/-/-417');
reset timezone;
-- 13f. refill_open is true exactly when the next fill would be recorded
-- (each next fill tried by PH and undone): every own item with a fill.
select pg_temp.expect('13f refill_open agrees with the next fill, for every own item with a fill',
  (select string_agg(pg_temp.next_fill_agrees(n), ' ' order by n)
     from generate_series(1, 23) n where n not in (8, 9, 14)),
  'rx1:closed=refused rx2:closed=refused rx3:closed=refused rx4:closed=refused rx5:closed=refused '
  || 'rx6:closed=refused rx7:closed=refused rx10:closed=refused rx11:closed=refused rx12:closed=refused '
  || 'rx13:open=ok rx15:closed=refused rx16:closed=refused rx17:closed=refused rx18:closed=refused '
  || 'rx19:closed=refused rx20:closed=refused rx21:open=ok rx22:closed=refused rx23:closed=refused');
-- 13g. Own items only: rx8's and rx9's route-backed items give no row, at
-- F4 (where P4 reads them) or at F1; their released own items read no fill.
select pg_temp.expect('13g route-backed items give no row; their own items read no fill',
  pg_temp.refills(3, array[8, 9], true, true) || ' | ' || pg_temp.refills(2, array[8, 9], true, true) || ' | '
  || pg_temp.refills(2, array[8, 9]),
  'none | none | rx8:2/0/false/-/- rx9:2/0/false/-/-');
-- 13h. The session's facility: P4 (F4) asking for F1's items, none.
select pg_temp.expect('13h another facility''s items give no row', pg_temp.refills(3, array[13, 21, 22]), 'none');
-- 13i. pharmacy.work-item.read: DR (a doctor, with consent grants that let
-- the Pharmacy runtime select the items, but no pharmacy.work-item.read)
-- gets none.
select pg_temp.expect('13i without pharmacy.work-item.read, none (though the runtime may select the items)',
  pg_temp.refills(1, array[13, 21]) || ' | ' || pg_temp.runtime_sees(1, array[13, 21]), 'none | rx13:2 rx21:1');
-- 13j. The work items' two read policies, each alone: PH (no grant) with
-- the own-work switch (0133's own-work half); PG (grants) without it (the
-- consent test); PH without it (neither: none). Each time the reader
-- answers exactly the items and fills the Pharmacy runtime itself may
-- select in that session.
select pg_temp.expect('13j the own-work half alone (PH): the reader and the runtime''s own reads',
  pg_temp.refills(2, array[13, 21, 22]) || ' | ' || pg_temp.runtime_sees(2, array[13, 21, 22]),
  'rx13:2/2/true/-/-377 rx21:2/1/true/-/-417 rx22:2/3/false/none_left/- | rx13:2 rx21:1 rx22:3');
select pg_temp.expect('13j the consent test alone (PG without the own-work switch): the same',
  pg_temp.refills(4, array[13, 21, 22], false) || ' | ' || pg_temp.runtime_sees(4, array[13, 21, 22], false),
  'rx13:2/2/true/-/-377 rx21:2/1/true/-/-417 rx22:2/3/false/none_left/- | rx13:2 rx21:1 rx22:3');
select pg_temp.expect('13j neither (PH without the own-work switch): none, and the runtime selects none',
  pg_temp.refills(2, array[13, 21, 22], false) || ' | ' || pg_temp.runtime_sees(2, array[13, 21, 22], false),
  'none | none');
-- 13k. At most 200 ids: 200 unknown ids and an empty array answer no row;
-- 201 ids and a null array are refused before anything is read.
select pg_temp.expect('13k 200 ids, an empty array, 201 ids, a null array',
  pg_temp.refills_of_ids(array(select gen_random_uuid() from generate_series(1, 200))) || ' | '
  || pg_temp.refills_of_ids(array[]::uuid[]) || ' | '
  || pg_temp.refills_of_ids(array(select gen_random_uuid() from generate_series(1, 201))) || ' | '
  || pg_temp.refills_of_ids(null),
  'rows=0 | rows=0 | 22023 WORK_ITEM_REFILLS_INVALID | 22023 WORK_ITEM_REFILLS_INVALID');
-- 13l. Nothing for ids that are not work items (prescription ids), or in
-- a session without a facility (PH's, the facility setting cleared).
create function pg_temp.refills_without_facility(n integer) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  perform set_config('app.facility_id', '', true);
  select 'rows=' || count(*) into answer from pharmacy.work_item_refills(array[pg_temp.work_item_of(pg_temp.rx(n))]);
  reset role;
  return answer;
end
$f$;
grant execute on function pg_temp.refills_without_facility(integer) to public;
select pg_temp.expect('13l prescription ids give no row; no session facility, no row',
  pg_temp.refills_of_ids(array[pg_temp.rx(13), pg_temp.rx(21)]) || ' | ' || pg_temp.refills_without_facility(13),
  'rows=0 | rows=0');

-- 14. The open refills, pharmacy.open_refill_work_items (0154's R7),
-- through the Pharmacy runtime as pharmacy-api's work list calls it (no
-- ids). Fixtures, as the suite runner in replica mode, as the services
-- would leave them (pg_temp.install_bulk): at F1, for Bisi, each an active
-- prescription with its own work item accepted at its version and its
-- fills; 'bN' (N = 1..210) allow no refill and were filled N minutes ago,
-- after every fill below; 'd29', 'd23', 'd22' and 'd10' allow 2 refills,
-- last 30 days (a 23-day interval) and were filled once 29, 23, 22 and 10
-- days ago (the refill opened 6 days ago, opens today, tomorrow, in 13
-- days); 'dE' allows 2, was filled 40 days ago and ended yesterday; 'dN'
-- allows 1 and was filled twice (none left). Labels name what a reader
-- answered, in its order (rxN for the prescriptions of cases 2-13: rx21's
-- refill opened 417 days ago, rx13's 377 days ago).
create temporary table refills_bulk (label text primary key, n integer unique, refills integer, ends_on date,
  fill_ages interval[], prescription uuid, item uuid, fill_at timestamptz) on commit drop;
grant select on refills_bulk to public;
insert into refills_bulk (label, n, refills, ends_on, fill_ages)
select 'b' || n, n, null, null, array[make_interval(mins => n)] from generate_series(1, 210) n;
insert into refills_bulk (label, n, refills, ends_on, fill_ages) values
  ('d29', 901, 2, null, array[interval '29 days']), ('d23', 902, 2, null, array[interval '23 days']),
  ('d22', 903, 2, null, array[interval '22 days']), ('d10', 904, 2, null, array[interval '10 days']),
  ('dE', 905, 2, pg_temp.lagos_day(-1), array[interval '40 days']),
  ('dN', 906, 1, null, array[interval '30 days', interval '25 days']);
create function pg_temp.install_bulk(first_n integer, last_n integer) returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  update refills_bulk set prescription = ('e1520017-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         item = ('e1520018-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
   where n between first_n and last_n;
  insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, ends_on, status, row_version, refills_allowed, duration_value, duration_unit)
  select bulk.prescription, 'e1520008-0000-4000-8000-000000000002', 'e1520006-0000-4000-8000-000000000002',
         'e1520001-0000-4000-8000-000000000001', pg_temp.account(1), pg_temp.membership(1), 'http://www.whocc.no/atc',
         'J01CA04', 'Amoxicillin 500 mg capsule (' || bulk.label || ')', 1, 'capsule', 'oral', 'Every 8 hours',
         'Take after food', pg_temp.lagos_day(-60), bulk.ends_on, 'active', 1, bulk.refills, 30, 'day'
    from refills_bulk bulk where bulk.n between first_n and last_n;
  insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
    source_ehr_prescription_version, source_encounter_id, source_status, medication_code_system, medication_code,
    medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, starts_on, ends_on, prescribed_by,
    prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key, request_sha256,
    correlation_id)
  select bulk.item, 'e1520006-0000-4000-8000-000000000002', 'e1520001-0000-4000-8000-000000000001',
         'e1520001-0000-4000-8000-000000000001', bulk.prescription, 1, 'e1520008-0000-4000-8000-000000000002', 'active',
         'http://www.whocc.no/atc', 'J01CA04', 'Amoxicillin 500 mg capsule (' || bulk.label || ')', 1, 'capsule',
         'oral', 'Every 8 hours', 'Take after food', pg_temp.lagos_day(-60), bulk.ends_on, pg_temp.account(1),
         clock_timestamp() - interval '60 days', pg_temp.account(1), pg_temp.membership(1),
         'Sent automatically when the prescription was activated', 'refills-bulk-item-' || bulk.n, repeat('a', 64),
         'refills-bulk'
    from refills_bulk bulk where bulk.n between first_n and last_n;
  -- Fill 1 of each, then the second fills (0133's claim, enabled always,
  -- turns the claim dispensed at fill 1 and lets fill 2 of an own item in).
  -- fill_at, when given, is fill 1's time.
  for fill_number in 1..2 loop
    insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id,
      medication_code_system, medication_code, medication_display, quantity_dispensed, quantity_unit, dispensed_by,
      dispensed_by_membership_id, dispensed_at, reason, idempotency_key, request_sha256, correlation_id, fill_number)
    select gen_random_uuid(), bulk.item, 1, 'e1520006-0000-4000-8000-000000000002',
           'e1520001-0000-4000-8000-000000000001', 'http://www.whocc.no/atc', 'J01CA04',
           'Amoxicillin 500 mg capsule (' || bulk.label || ')', 30, 'capsule', pg_temp.account(2),
           pg_temp.membership(2), coalesce(bulk.fill_at, clock_timestamp() - bulk.fill_ages[fill_number]),
           'Dispensed to the patient', 'refills-bulk-fill-' || bulk.n || '-' || fill_number, repeat('d', 64),
           'refills-bulk', fill_number
      from refills_bulk bulk
     where bulk.n between first_n and last_n and cardinality(bulk.fill_ages) >= fill_number;
  end loop;
  set local session_replication_role = origin;
end
$f$;
select pg_temp.install_bulk(1, 999);
-- R7 as a member ('none' for no row; own_work false clears the own-work
-- switch; no_facility clears the session's facility): its ids, in order.
create function pg_temp.open_refills(member integer, own_work boolean default true, no_facility boolean default false)
returns uuid[] language plpgsql as $f$
declare answer uuid[];
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.session_of(member, own_work);
  if no_facility then
    perform set_config('app.facility_id', '', true);
  end if;
  select coalesce(array_agg(opened.work_item_id order by opened.position), '{}') into answer
    from pharmacy.open_refill_work_items() with ordinality opened(work_item_id, position);
  reset role;
  return answer;
end
$f$;
-- The labels of work item ids, in their order (owner read).
create function pg_temp.labels(ids uuid[]) returns text language sql security definer as $f$
  select coalesce(string_agg(coalesce(
           (select 'rx' || ltrim(right(item.source_ehr_prescription_id::text, 2), '0')
              from pharmacy.work_items item
             where item.id = given.id and item.source_ehr_prescription_id::text like 'e1520007-%'),
           (select bulk.label from refills_bulk bulk where bulk.item = given.id), 'other'), ' ' order by given.position),
         'none')
    from unnest(ids) with ordinality given(id, position)
$f$;
-- pharmacy-api's candidates statement before this fix (ORD-12's first
-- services build), verbatim, as PH: how many it gives, and whether each
-- of the two items with a refill open is among them.
create function pg_temp.earlier_candidates() returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  with candidates as (
    select w.id::text as work_item_id
      from pharmacy.work_items w
      cross join lateral (select count(*)::integer as fills, max(df.dispensed_at) as last_filled_at
        from pharmacy.dispensings df where df.work_item_id=w.id) f
      where w.order_route_id is null and f.fills between 1 and 11
        and (w.ends_on is null or w.ends_on >= (now() at time zone 'Africa/Lagos')::date)
      order by f.last_filled_at desc, w.id desc limit 200)
  select format('candidates=%s d29=%s d23=%s', count(*),
           bool_or(candidates.work_item_id = (select bulk.item::text from refills_bulk bulk where bulk.label = 'd29'))::text,
           bool_or(candidates.work_item_id = (select bulk.item::text from refills_bulk bulk where bulk.label = 'd23'))::text)
    into answer
    from candidates;
  reset role;
  return answer;
end
$f$;
-- R6 as PH for the given items: the labels it says have a refill open, by
-- label.
create function pg_temp.open_by_reader(ids uuid[]) returns text language plpgsql as $f$
declare answer uuid[];
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  select coalesce(array_agg(reader.work_item_id), '{}') into answer
    from pharmacy.work_item_refills(ids) reader where reader.refill_open;
  reset role;
  return (select string_agg(label, ' ' order by label)
            from regexp_split_to_table(pg_temp.labels(answer), ' ') label);
end
$f$;
-- R6 as PH for the given items: whether their next_fill_on, in R7's order,
-- never goes back (R7 orders by the day the refill opened).
create function pg_temp.in_opening_order(ids uuid[]) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  select coalesce(bool_and(ordered.next_fill_on >= ordered.before_it or ordered.before_it is null)::text, 'none')
    into answer
    from (select reader.next_fill_on, lag(reader.next_fill_on) over (order by given.position) as before_it
            from unnest(ids) with ordinality given(id, position)
            join pharmacy.work_item_refills(ids) reader on reader.work_item_id = given.id) ordered;
  reset role;
  return answer;
end
$f$;
grant execute on function pg_temp.open_refills(integer, boolean, boolean), pg_temp.earlier_candidates(),
  pg_temp.open_by_reader(uuid[]), pg_temp.in_opening_order(uuid[]) to public;

-- 14a. As PH (no grant, the own-work switch): the items whose refill is
-- open now, the one that opened first first: rx21 (417 days ago), rx13
-- (377), d29 (6), d23 (today); never d22 or d10 (the refill interval has not
-- passed), an item without refills, the ended one or the one with none
-- left. The earlier candidates statement gave the 200 most recently filled
-- items and neither d29 nor d23.
select pg_temp.expect('14a the open refills, the earliest opened first, however many items were filled after them',
  pg_temp.labels(pg_temp.open_refills(2)) || ' | ' || pg_temp.earlier_candidates(),
  'rx21 rx13 d29 d23 | candidates=200 d29=false d23=false');
-- 14b. Exactly the items the per-item reader (R6) says have a refill open:
-- every item of cases 2-13 and the six 'd' items, asked of R6 at once.
select pg_temp.expect('14b R7 answers exactly the items R6 calls open',
  pg_temp.open_by_reader(array(select pg_temp.work_item_of(pg_temp.rx(n)) from generate_series(1, 23) n
                               where pg_temp.work_item_of(pg_temp.rx(n)) is not null)
                         || array(select bulk.item from refills_bulk bulk where bulk.label like 'd%'))
  || ' | ' || (select string_agg(label, ' ' order by label)
                 from regexp_split_to_table(pg_temp.labels(pg_temp.open_refills(2)), ' ') label),
  'd23 d29 rx13 rx21 | d23 d29 rx13 rx21');
-- 14c. Who gets an answer, as R6 decides it: PG (grants) without the
-- own-work switch, the consent test alone, the same; PH without the switch
-- (neither policy), DR (no pharmacy.work-item.read), P4 (another
-- facility) and PH without a session facility, none.
select pg_temp.expect('14c the consent test alone; neither policy, no permission, another facility, no facility',
  pg_temp.labels(pg_temp.open_refills(4, false)) || ' | ' || pg_temp.labels(pg_temp.open_refills(2, false)) || ' | '
  || pg_temp.labels(pg_temp.open_refills(1)) || ' | ' || pg_temp.labels(pg_temp.open_refills(3)) || ' | '
  || pg_temp.labels(pg_temp.open_refills(2, true, true)),
  'rx21 rx13 d29 d23 | none | none | none | none');
-- 14d. At most 200, the earliest opened first, then by id: 200 more items
-- with a refill open, 'o1' to 'o200', filled at noon Lagos 450 days ago (so
-- all opened 427 days ago) come before every item above, by id; the 200 are
-- exactly they. Undone afterwards.
savepoint refills_two_hundred;
insert into refills_bulk (label, n, refills, ends_on, fill_ages, fill_at)
select 'o' || n, 1000 + n, 2, null, array[interval '450 days'], pg_temp.lagos_at(-450) + make_interval(secs => n)
  from generate_series(1, 200) n;
select pg_temp.install_bulk(1001, 1200);
select pg_temp.expect('14d 200 at most, the earliest opened first, then by id',
  pg_temp.labels(pg_temp.open_refills(2)),
  (select string_agg('o' || n, ' ' order by n) from generate_series(1, 200) n));
-- 14e. R7 asks the work items' two read policies, repeated, only of the due
-- items it answers, in its order, and stops at 200 (the review of
-- 24 November 2026: asked of every due item first, R7 grew about 2 ms a
-- refill open at once under a NOSUPERUSER NOBYPASSRLS owner), the own-work
-- half first (the consent test, pharmacy.work_item_allows, costs about 2
-- ms a call; the own-work half about 0.1 ms): with the 204 due here, PH's
-- call never asks the consent test (no table policy asks it of PH either:
-- the work items' and the fills' own-work policies come first and hold), and,
-- under an owner that bypasses row-level security (no table policy asked),
-- asks the own-work half exactly 200 times; under a NOSUPERUSER NOBYPASSRLS
-- owner the tables' own policies ask it on every row they read as well, so
-- that count is checked on the superuser build only.
set local track_functions = 'all';
create function pg_temp.calls_during(statement text, counted regprocedure) returns bigint language plpgsql as $f$
declare before_calls bigint := coalesce(pg_stat_get_xact_function_calls(counted), 0);
begin
  execute statement;
  return coalesce(pg_stat_get_xact_function_calls(counted), 0) - before_calls;
end
$f$;
create function pg_temp.r7_access_calls() returns text language plpgsql as $f$
declare
  consent_calls bigint;
  own_work_calls bigint;
  r7_rows integer;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  consent_calls := pg_temp.calls_during('select count(*) from pharmacy.open_refill_work_items()',
    'pharmacy.work_item_allows(uuid, uuid, uuid, text)'::regprocedure);
  own_work_calls := pg_temp.calls_during('select count(*) from pharmacy.open_refill_work_items()',
    'identity.pharmacy_work_patient_allows(uuid, uuid, uuid, text)'::regprocedure);
  select count(*) into r7_rows from pharmacy.open_refill_work_items();
  reset role;
  return format('rows %s, consent test %s, own-work half %s', r7_rows, consent_calls,
    case when (select role_row.rolsuper or role_row.rolbypassrls from pg_roles role_row
                join pg_class relation on relation.relowner = role_row.oid
               where relation.oid = 'ehr.prescriptions'::regclass) then own_work_calls::text
         else 'not counted' end);
end
$f$;
grant execute on function pg_temp.calls_during(text, regprocedure) to public;
select pg_temp.expect('14e R7 asks the read policies of the due items it answers only, own-work first, 200 at most',
  pg_temp.r7_access_calls() || ' (due ' || (select count(*) from refills_bulk bulk where bulk.label like 'o%')
    + cardinality(array['rx13', 'rx21', 'd29', 'd23']) || ')',
  'rows 200, consent test 0, own-work half '
  || case when (select role_row.rolsuper or role_row.rolbypassrls from pg_roles role_row
                 join pg_class relation on relation.relowner = role_row.oid
                where relation.oid = 'ehr.prescriptions'::regclass) then '200' else 'not counted' end || ' (due 204)');
rollback to savepoint refills_two_hundred;

-- 15. The refill interval (the clinical owner's decision, 24 November
-- 2026): a refill opens on the Lagos day of the latest fill not reversed
-- plus 3/4 of the prescription's duration in days (days 1, weeks 7, months
-- 30), rounded up, at least 1. Before that day the validator refuses it
-- (23514 REFILL_TOO_SOON, DETAIL the day it opens, YYYY-MM-DD), the reader
-- answers refill_open false, closed_reason not_yet and next_fill_on that
-- day, and the open refills leave the item out; from that day it is open.
-- Prescriptions written by DR and sent by D7 as ehr-api does; each first
-- fill recorded as of a Lagos day and time, by PH:
--   rx25 and rx26: 10 days (8): fill 1 at 23:59 on day -8 (opens today) and
--   at 00:01 on day -7 (opens tomorrow): the Lagos day counts, not 24 hours;
--   rx27 and rx28: 2 weeks (14 days: 11): fill 1 on days -10 and -11;
--   rx29 and rx30: 1 month (30 days: 23): fill 1 on days -22 and -23;
--   rx31: 1 day (1): fill 1 today; rx34: 3 days (3): fill 1 on day -2;
--   rx32: 10 days (8): fills 1 and 2 on days -20 and -3; fill 2 reversed;
--   rx33: 10 days (8): fill 1 today, reversed (no fill standing: no wait).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('15 fixtures: DR writes rx25-rx34 with their durations and D7 sends each',
  (select string_agg(pg_temp.try(pg_temp.prescribe_sql(fixture.n, 2, fixture.refills, null, fixture.duration_value,
     fixture.duration_unit)) || ' ' || pg_temp.send(fixture.n), ',' order by fixture.n)
     from (values (25, 2, 10, 'day'), (26, 2, 10, 'day'), (27, 2, 2, 'week'), (28, 2, 2, 'week'),
                  (29, 1, 1, 'month'), (30, 1, 1, 'month'), (31, 2, 1, 'day'), (32, 2, 10, 'day'),
                  (33, 1, 10, 'day'), (34, 2, 3, 'day')) fixture(n, refills, duration_value, duration_unit)),
  (select string_agg('ok sent:item', ',') from generate_series(25, 34)));
reset role;
select pg_temp.expect('15 fixtures: each first fill as of its Lagos day and time',
  pg_temp.fill(25, 1, as_of => pg_temp.lagos_at(-8, time '23:59')) || ' '
  || pg_temp.fill(26, 1, as_of => pg_temp.lagos_at(-7, time '00:01')) || ' '
  || pg_temp.fill(27, 1, as_of => pg_temp.lagos_at(-10)) || ' ' || pg_temp.fill(28, 1, as_of => pg_temp.lagos_at(-11)) || ' '
  || pg_temp.fill(29, 1, as_of => pg_temp.lagos_at(-22)) || ' ' || pg_temp.fill(30, 1, as_of => pg_temp.lagos_at(-23)) || ' '
  || pg_temp.fill(31, 1, as_of => clock_timestamp()) || ' ' || pg_temp.fill(34, 1, as_of => pg_temp.lagos_at(-2)) || ' '
  || pg_temp.fill(32, 1, as_of => pg_temp.lagos_at(-20)) || ' ' || pg_temp.fill(33, 1, as_of => clock_timestamp()),
  'ok ok ok ok ok ok ok ok ok ok');
-- 15a. The reader before any refill: open from today (next 0) on the day,
-- not yet (next 1, tomorrow) the day before; rx31's one-day interval and
-- rx34's three-day one likewise.
select pg_temp.expect('15a the reader: open on the day, not_yet the day before (days, weeks, months)',
  pg_temp.refills(2, array[25, 26, 27, 28, 29, 30, 31, 34]),
  'rx25:2/1/true/-/0 rx26:2/1/false/not_yet/1 rx27:2/1/false/not_yet/1 rx28:2/1/true/-/0 '
  || 'rx29:1/1/false/not_yet/1 rx30:1/1/true/-/0 rx31:2/1/false/not_yet/1 rx34:2/1/false/not_yet/1');
-- 15b. The validator agrees (each refill tried by PH and undone, as 13f).
select pg_temp.expect('15b refill_open agrees with the next fill at the boundary days',
  (select string_agg(pg_temp.next_fill_agrees(n), ' ' order by n) from unnest(array[25, 26, 27, 28, 29, 30, 31, 34]) n),
  'rx25:open=ok rx26:closed=refused rx27:closed=refused rx28:open=ok rx29:closed=refused rx30:open=ok '
  || 'rx31:closed=refused rx34:closed=refused');
-- 15c. The refusal: 23514 REFILL_TOO_SOON with the day it opens, whatever
-- the session's time zone (the Lagos day; at any hour, one of the two far
-- zones is on another calendar day than Lagos).
select pg_temp.expect('15c too soon: REFILL_TOO_SOON, DETAIL the day it opens',
  pg_temp.fill(26, 2, as_of => clock_timestamp()) || ' | ' || pg_temp.fill(29, 2, as_of => clock_timestamp()),
  '23514 REFILL_TOO_SOON / ' || to_char(pg_temp.lagos_day(1), 'YYYY-MM-DD') || ' | 23514 REFILL_TOO_SOON / '
  || to_char(pg_temp.lagos_day(1), 'YYYY-MM-DD'));
set local timezone = 'Pacific/Kiritimati';
select pg_temp.expect('15c under TimeZone Pacific/Kiritimati (UTC+14): the same, and rx25 open',
  pg_temp.fill(26, 2, as_of => clock_timestamp()) || ' | ' || pg_temp.refills(2, array[25, 26]),
  '23514 REFILL_TOO_SOON / ' || to_char(pg_temp.lagos_day(1), 'YYYY-MM-DD')
  || ' | rx25:2/1/true/-/0 rx26:2/1/false/not_yet/1');
set local timezone = 'Etc/GMT+12';
select pg_temp.expect('15c under TimeZone Etc/GMT+12 (UTC-12): the same, and rx25 open',
  pg_temp.fill(26, 2, as_of => clock_timestamp()) || ' | ' || pg_temp.refills(2, array[25, 26]),
  '23514 REFILL_TOO_SOON / ' || to_char(pg_temp.lagos_day(1), 'YYYY-MM-DD')
  || ' | rx25:2/1/true/-/0 rx26:2/1/false/not_yet/1');
reset timezone;
-- 15d. The open refills: the items whose day has come (rx25, rx28, rx30 on
-- the day; rx32, whose refill opened on day -12), the earliest opened first
-- (the same day in id order, so compared as a set, and the order by
-- next_fill_on), never one waiting (rx26, rx27, rx29, rx31, rx33, rx34).
select pg_temp.expect('15d the open refills leave out the refills not yet open; earliest opened first',
  (select string_agg(label, ' ' order by label)
     from regexp_split_to_table(pg_temp.labels(pg_temp.open_refills(2)), ' ') label
    where label like 'rx%') || ' | ' || pg_temp.in_opening_order(pg_temp.open_refills(2)),
  'rx13 rx21 rx25 rx28 rx30 rx32 | true');
-- 15e. On the day the refill passes (rx25, rx28, rx30: fill 2 now), and the
-- next one waits from fill 2's day: rx25 and rx28 not_yet again (opens in 8
-- and 11 days); rx30 none left.
select pg_temp.expect('15e on the day: fill 2 passes; the next waits from it',
  pg_temp.fill(25, 2, as_of => clock_timestamp()) || ' ' || pg_temp.fill(28, 2, as_of => clock_timestamp()) || ' '
  || pg_temp.fill(30, 2, as_of => clock_timestamp()) || ' | ' || pg_temp.refills(2, array[25, 28, 30]) || ' | '
  || pg_temp.fill(25, 3, as_of => clock_timestamp()),
  'ok ok ok | rx25:2/2/false/not_yet/8 rx28:2/2/false/not_yet/11 rx30:1/2/false/none_left/- | '
  || '23514 REFILL_TOO_SOON / ' || to_char(pg_temp.lagos_day(8), 'YYYY-MM-DD'));
-- 15f. The latest fill NOT reversed (rx32): fill 2 on day -3 (fill 1's day
-- -20 + 8 has passed), then fill 3 waits until day -3 + 8; once fill 2 is
-- reversed, the latest fill standing is fill 1 (day -20): fill 3 passes.
select pg_temp.expect('15f a reversed latest fill: the wait runs from the latest fill standing',
  pg_temp.fill(32, 2, as_of => pg_temp.lagos_at(-3)) || ' | ' || pg_temp.refills(2, array[32]) || ' | '
  || pg_temp.fill(32, 3, as_of => clock_timestamp()) || ' | ' || pg_temp.reverse(32, 2) || ' | '
  || pg_temp.refills(2, array[32]) || ' | ' || pg_temp.fill(32, 3, as_of => clock_timestamp()) || ' | '
  || pg_temp.fills(pg_temp.work_item_of(pg_temp.rx(32))),
  'ok | rx32:2/2/false/not_yet/5 | 23514 REFILL_TOO_SOON / ' || to_char(pg_temp.lagos_day(5), 'YYYY-MM-DD')
  || ' | ok | rx32:2/2/true/-/-12 | ok | 1 2r 3');
-- 15g. Every fill reversed (rx33, refills 1): no fill standing, no wait;
-- the reader's next_fill_on is the reversal's day (today); fill 2 passes.
select pg_temp.expect('15g every fill reversed: no wait',
  pg_temp.reverse(33, 1) || ' | ' || pg_temp.refills(2, array[33]) || ' | ' || pg_temp.fill(33, 2, as_of => clock_timestamp()),
  'ok | rx33:1/1/true/-/0 | ok');
-- 15h. A refill needs a duration (the CHECK, on create, as DR): refills 1
-- without one is refused; refills 0 or none without one pass (undone).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
savepoint refills_duration;
select pg_temp.expect('15h refills without a duration: refused; none or 0 without one: ok',
  split_part(pg_temp.try(pg_temp.prescribe_sql(45, 2, 1, null, null)), ' / ', 1) || ' | '
  || pg_temp.try(pg_temp.prescribe_sql(46, 2, 0, null, null)) || ' '
  || pg_temp.try(pg_temp.prescribe_sql(47, 2, null, null, null)),
  '23514 new row for relation "prescriptions" violates check constraint "prescriptions_refills_allowed_ck" | ok ok');
rollback to savepoint refills_duration;
reset role;

-- 16. The refill scan marker (R9; the clinical owner's decision D8, 24
-- November 2026, 0143 D1's form). Under a NOSUPERUSER NOBYPASSRLS owner
-- (production's kind) every row of ehr.prescriptions R6 and R7 read paid the
-- table's OR'd read policies (about 10 ms a row); now each writes a marker
-- just before its one statement that reads ehr.prescriptions and deletes it
-- just after, and the policy prescriptions_scan_refills, asked first and
-- once per statement, lets the owner read every row while the marker is
-- held. Under a superuser owner (row-level security bypassed) the policy is
-- never asked, so the cases that compare what the owner or the readers see
-- hold there as well, trivially; the NOSUPERUSER NOBYPASSRLS build is the one
-- they test. 'Before' is the same database with the policy dropped (undone
-- at once): what 0154 without the marker would show.
create function pg_temp.owner_name() returns text language sql as $f$
  select pg_get_userbyid(relation.relowner)::text from pg_class relation
   where relation.oid = 'ehr.prescriptions'::regclass
$f$;
create function pg_temp.owner_bypasses() returns boolean language sql as $f$
  select role_row.rolsuper or role_row.rolbypassrls from pg_roles role_row
   where role_row.rolname = pg_temp.owner_name()
$f$;
-- What the owner of ehr.prescriptions reads of it in a member's session
-- (as every owner-run definer function does): 'count:md5 of the ids'.
create function pg_temp.owner_sees(member integer, own_work boolean default true) returns text language plpgsql as $f$
declare answer text;
begin
  execute format('set local role %I', pg_temp.owner_name());
  perform pg_temp.session_of(member, own_work);
  select count(*) || ':' || coalesce(md5(string_agg(prescription.id::text, ',' order by prescription.id)), '-')
    into answer from ehr.prescriptions prescription;
  reset role;
  return answer;
end
$f$;
-- What the EHR API's runtime reads of ehr.prescriptions in a member's
-- session, the same way.
create function pg_temp.ehr_runtime_sees(member integer) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_ehr_api_runtime;
  perform pg_temp.as_member(member);
  select count(*) || ':' || coalesce(md5(string_agg(prescription.id::text, ',' order by prescription.id)), '-')
    into answer from ehr.prescriptions prescription;
  reset role;
  return answer;
end
$f$;
-- A statement's text answer with the marker's policy dropped, undone at once
-- (the answer leaves the rolled-back block as the DETAIL).
create function pg_temp.without_marker_policy(statement text) returns text language plpgsql as $f$
declare answer text;
begin
  begin
    drop policy prescriptions_scan_refills on ehr.prescriptions;
    execute statement into answer;
    raise exception using errcode = 'P0001', message = 'refills: put the marker policy back', detail = answer;
  exception when raise_exception then
    get stacked diagnostics answer = pg_exception_detail;
  end;
  return answer;
end
$f$;
-- R6 for every own item of cases 2-17 and the 'd' items of case 14, and R7,
-- as a member through the Pharmacy runtime: 'rows:md5 | rows:md5'.
create function pg_temp.readers_answer(member integer, own_work boolean) returns text language plpgsql as $f$
declare
  ids uuid[] := array(select pg_temp.work_item_of(pg_temp.rx(n)) from generate_series(1, 48) n
                       where pg_temp.work_item_of(pg_temp.rx(n)) is not null)
                || array(select bulk.item from refills_bulk bulk where bulk.label like 'd%');
  answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.session_of(member, own_work);
  select count(*) || ':' || md5(string_agg(row(reader.*)::text, ',' order by reader.work_item_id)) into answer
    from pharmacy.work_item_refills(ids) reader;
  select answer || ' | ' || count(*) || ':'
         || coalesce(md5(string_agg(opened.work_item_id::text, ',' order by opened.position)), '-') into answer
    from pharmacy.open_refill_work_items() with ordinality opened(work_item_id, position);
  reset role;
  return answer;
end
$f$;
-- A runtime's tries at the marker table and test, in a member's session:
-- each outcome's SQLSTATE, or the answer.
create function pg_temp.marker_tries(runtime text, member integer) returns text language plpgsql as $f$
declare
  answer text;
  marker_open text;
begin
  execute format('set local role %I', runtime);
  perform pg_temp.as_member(member);
  answer := split_part(pg_temp.try('select count(*) from pharmacy.refill_scans'), ' ', 1) || ' '
    || split_part(pg_temp.try('insert into pharmacy.refill_scans values (pg_backend_pid(), transaction_timestamp())'),
         ' ', 1) || ' '
    || split_part(pg_temp.try('delete from pharmacy.refill_scans'), ' ', 1);
  begin
    execute 'select pharmacy.refill_scan_open()::text' into marker_open;
  exception when others then
    marker_open := sqlstate;
  end;
  reset role;
  return answer || ' ' || marker_open;
end
$f$;
-- Marker rows left (the suite runner reads the owner's table).
create function pg_temp.marker_rows() returns text language sql as $f$
  select 'rows ' || count(*) from pharmacy.refill_scans
$f$;
-- R7 as a member: 'ok' or the error.
create function pg_temp.open_refills_try(member integer) returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(member);
  answer := pg_temp.try('select count(*) from pharmacy.open_refill_work_items()');
  reset role;
  return answer;
end
$f$;
-- Times pharmacy.refill_scan_open() ran during a statement (track_functions
-- is 'all' for this transaction).
create function pg_temp.marker_asked(statement text) returns integer language plpgsql as $f$
declare before_calls bigint := coalesce(pg_stat_get_xact_function_calls('pharmacy.refill_scan_open()'::regprocedure), 0);
begin
  execute statement;
  return coalesce(pg_stat_get_xact_function_calls('pharmacy.refill_scan_open()'::regprocedure), 0) - before_calls;
end
$f$;
-- The plan of R7's one statement that reads ehr.prescriptions (its text,
-- with this suite's facility and days for R7's variables), as the owner with
-- a marker held, as R7 runs it (EXPLAIN VERBOSE). Sequential scans off: the
-- suite's table is small, and the case is whether the index can bound the
-- read (the 20,000-row measurement shows the planner choosing it).
create function pg_temp.r7_statement_plan() returns text[] language plpgsql as $f$
declare
  plan text[] := '{}';
  line text;
begin
  execute format('set local role %I', pg_temp.owner_name());
  perform pg_temp.as_member(2);
  insert into pharmacy.refill_scans (backend_pid, transaction_started_at)
  values (pg_backend_pid(), transaction_timestamp());
  set local enable_seqscan = off;
  for line in execute format($q$explain (verbose, costs off)
      select pg_catalog.array_agg(prescription.id)
        from ehr.prescriptions prescription
       where prescription.facility_id = %L::uuid
         and prescription.refills_allowed > 0
         and prescription.created_at >= %L::timestamptz
         and ehr.prescription_refills_end_on(prescription.created_at, prescription.refills_allowed,
               prescription.duration_value, prescription.duration_unit, prescription.ends_on) >= %L::date
         and prescription.status = 'active'$q$, 'e1520001-0000-4000-8000-000000000001',
      (pg_temp.lagos_day(-365)::timestamp at time zone 'Africa/Lagos'), pg_temp.lagos_day(0)) loop
    plan := plan || line;
  end loop;
  reset enable_seqscan;
  delete from pharmacy.refill_scans scan
   where scan.backend_pid = pg_backend_pid() and scan.transaction_started_at = transaction_timestamp();
  reset role;
  return plan;
end
$f$;
grant execute on function pg_temp.owner_sees(integer, boolean), pg_temp.ehr_runtime_sees(integer),
  pg_temp.readers_answer(integer, boolean), pg_temp.marker_tries(text, integer), pg_temp.open_refills_try(integer),
  pg_temp.owner_name(), pg_temp.marker_asked(text) to public;
set local track_functions = 'all';

-- 16a. No runtime role may read or write the marker table, by any
-- privilege; the Pharmacy runtime's and the EHR runtime's tries are refused
-- (42501; the EHR runtime has no schema pharmacy at all); the marker test
-- answers the Pharmacy runtime false (it tells a session only about its own
-- transaction, which no runtime can mark).
select pg_temp.expect('16a the runtimes can neither read nor write the marker table',
  coalesce((select string_agg(format('%s %s', role_row.rolname, wanted.privilege), ', ' order by role_row.rolname)
              from pg_roles role_row
             cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
                   wanted(privilege)
             where role_row.rolname ~ '^hid_'
               and has_table_privilege(role_row.oid, 'pharmacy.refill_scans', wanted.privilege)), 'no privilege')
  || ' | ' || pg_temp.marker_tries('hid_pharmacy_api_runtime', 2)
  || ' | ' || pg_temp.marker_tries('hid_ehr_api_runtime', 1),
  'no privilege | 42501 42501 42501 false | 42501 42501 42501 42501');
-- 16b. The owner with a session but no marker reads what it read before
-- (PH on the own-work basis, PG on consent, DR the prescriber, P4 another
-- facility's pharmacist), and so does the EHR runtime; under a NOSUPERUSER
-- NOBYPASSRLS owner the owner's reads in P4's session still see less than
-- the whole table (the table's own policies still decide them).
select pg_temp.expect('16b without a marker the owner and the EHR runtime read what they read before',
  (select string_agg(format('%s:%s', checked.label,
            case when pg_temp.owner_sees(checked.member, checked.own_work)
                      = pg_temp.without_marker_policy(format('select pg_temp.owner_sees(%s, %L)', checked.member,
                          checked.own_work))
                 then 'same' else 'differs' end), ' ' order by checked.label)
     from (values ('PH', 2, true), ('PG', 4, false), ('DR', 1, true), ('P4', 3, true)) checked(label, member, own_work))
  || ' ehr-DR:' || case when pg_temp.ehr_runtime_sees(1)
                             = pg_temp.without_marker_policy('select pg_temp.ehr_runtime_sees(1)')
                        then 'same' else 'differs' end
  || ' | P4''s owner-run reads are bounded: '
  || (pg_temp.owner_bypasses()
      or split_part(pg_temp.owner_sees(3), ':', 1)::bigint < (select count(*) from ehr.prescriptions))::text,
  'DR:same P4:same PG:same PH:same ehr-DR:same | P4''s owner-run reads are bounded: true');
-- 16c. No marker row survives a return (R6 and R7 as PH) or an error: R8
-- replaced (undone at once) by one that fails, saying whether the marker is
-- held, makes R6's and R7's statement fail while the marker is held; the
-- error leaves no row, and the owner's marker test answers false after
-- each. (Index scans are off for R7's failing call, so its statement asks R8
-- on each row under either owner kind.)
create function pg_temp.readers_failing() returns text language plpgsql as $f$
declare answer text;
begin
  begin
    create or replace function ehr.prescription_refills_end_on(written_at timestamptz, refills_allowed smallint,
      duration_value integer, duration_unit text, ends_on date)
    returns date language plpgsql immutable set search_path = pg_catalog, pg_temp as $r$
    begin
      raise exception using errcode = '22000',
        message = 'refills suite: R8 fails on purpose; the marker is held: ' || pharmacy.refill_scan_open()::text;
    end
    $r$;
    answer := 'R6 ' || pg_temp.refills(2, array[13, 21]) || ' ' || pg_temp.marker_rows();
    set local enable_indexscan = off;
    set local enable_bitmapscan = off;
    answer := answer || ' | R7 ' || pg_temp.open_refills_try(2) || ' ' || pg_temp.marker_rows();
    raise exception using errcode = 'P0001', message = 'refills: put R8 back', detail = answer;
  exception when raise_exception then
    get stacked diagnostics answer = pg_exception_detail;
  end;
  return answer;
end
$f$;
create function pg_temp.owner_marker_open() returns text language plpgsql as $f$
declare answer text;
begin
  execute format('set local role %I', pg_temp.owner_name());
  answer := pharmacy.refill_scan_open()::text;
  reset role;
  return answer;
end
$f$;
select pg_temp.expect('16c no marker row after R6 and R7 return or fail',
  'R6 ' || split_part(pg_temp.refills(2, array[13, 21]), ' ', 1) || ' ' || pg_temp.marker_rows()
  || ' | R7 ' || cardinality(pg_temp.open_refills(2))::text || ' ' || pg_temp.marker_rows()
  || ' | ' || pg_temp.readers_failing() || ' | ' || pg_temp.marker_rows() || ' open=' || pg_temp.owner_marker_open(),
  'R6 rx13:2/2/true/-/-377 rows 0 | R7 ' || cardinality(pg_temp.open_refills(2))::text || ' rows 0 | '
  || 'R6 22000 refills suite: R8 fails on purpose; the marker is held: true rows 0 | '
  || 'R7 22000 refills suite: R8 fails on purpose; the marker is held: true / - rows 0 | rows 0 open=false');
-- 16d. R6 and R7 answer exactly as before, for every own item of cases
-- 2-15 and the 'd' items, as PH (own work) and as PG (consent): the same
-- rows with the marker's policy as without it.
select pg_temp.expect('16d R6 and R7 answer as they did without the marker',
  (select string_agg(format('%s:%s', checked.label,
            case when pg_temp.readers_answer(checked.member, checked.own_work)
                      = pg_temp.without_marker_policy(format('select pg_temp.readers_answer(%s, %L)', checked.member,
                          checked.own_work))
                 then 'same' else 'differs' end), ' ' order by checked.label)
     from (values ('PG', 4, false), ('PH', 2, true)) checked(label, member, own_work))
  || ' | rows ' || split_part(pg_temp.readers_answer(2, true), ':', 1),
  'PG:same PH:same | rows ' || (select count(*) from generate_series(1, 48) n
                                  where pg_temp.work_item_of(pg_temp.rx(n)) is not null)
                               + (select count(*) from refills_bulk bulk where bulk.label like 'd%'));
-- 16e. A later statement in the same transaction that reads
-- ehr.prescriptions sees what it saw before: the owner in PH's session (who
-- reads every row on the own-work basis), the owner in P4's session
-- (another facility's pharmacist: under a NOSUPERUSER NOBYPASSRLS owner its
-- owner-run reads see none of F1's rows, so a marker left behind shows
-- there) and the EHR runtime, before and after R6 and R7 ran in this
-- transaction, and as without the marker's policy; no marker row is left,
-- and the owner's marker test answers false. Then the case's own check: with
-- R7 replaced (undone at once) by its own text without the DELETE of its
-- marker, the same function sees the leak (rows 1, open=true, and P4's
-- owner-run read differs under a NOSUPERUSER NOBYPASSRLS owner).
create function pg_temp.after_readers() returns text language plpgsql as $f$
declare
  owner_before text := pg_temp.owner_sees(2);
  bounded_before text := pg_temp.owner_sees(3);
  runtime_before text := pg_temp.ehr_runtime_sees(1);
begin
  perform pg_temp.readers_answer(2, true);
  return format('owner %s bounded %s runtime %s | %s open=%s', (pg_temp.owner_sees(2) = owner_before
           and owner_before = pg_temp.without_marker_policy('select pg_temp.owner_sees(2)'))::text,
         (pg_temp.owner_sees(3) = bounded_before
           and bounded_before = pg_temp.without_marker_policy('select pg_temp.owner_sees(3)'))::text,
         (pg_temp.ehr_runtime_sees(1) = runtime_before
           and runtime_before = pg_temp.without_marker_policy('select pg_temp.ehr_runtime_sees(1)'))::text,
         pg_temp.marker_rows(), pg_temp.owner_marker_open());
end
$f$;
create function pg_temp.after_leaking_reader() returns text language plpgsql as $f$
declare
  leaking text := pg_get_functiondef('pharmacy.open_refill_work_items()'::regprocedure);
  answer text;
begin
  if leaking !~ 'delete from pharmacy\.refill_scans scan\s+where [^;]+;' then
    return 'R7 has no DELETE of its marker to take out';
  end if;
  begin
    execute regexp_replace(leaking, 'delete from pharmacy\.refill_scans scan\s+where [^;]+;', 'null;');
    answer := pg_temp.after_readers();
    raise exception using errcode = 'P0001', message = 'refills: put R7 back', detail = answer;
  exception when raise_exception then
    get stacked diagnostics answer = pg_exception_detail;
  end;
  return answer;
end
$f$;
select pg_temp.expect('16e after R6 and R7, later reads of ehr.prescriptions in the transaction see what they saw',
  pg_temp.after_readers(), 'owner true bounded true runtime true | rows 0 open=false');
select pg_temp.expect('16e the case sees a marker left behind (an R7 without its DELETE, undone)',
  pg_temp.after_leaking_reader() || ' | then ' || pg_temp.marker_rows(),
  format('owner true bounded %s runtime true | rows 1 open=true | then rows 0', pg_temp.owner_bypasses()::text));
-- 16f. The policy is asked once per statement: pharmacy.refill_scan_open()
-- runs once for R6's statement and once for R7's (several prescriptions
-- read; none under a superuser owner, which never asks a policy), and in
-- the plan of R7's statement (as the owner, NOSUPERUSER NOBYPASSRLS) it is
-- the one InitPlan whose answer is the first arm of the read policies' OR.
create function pg_temp.policy_once() returns text language plpgsql as $f$
declare
  plan text[] := pg_temp.r7_statement_plan();
  marker_line integer;
  marker_param text;
  filter_line text;
  r6_calls integer := pg_temp.marker_asked(format('select pg_temp.refills(2, array[%s])',
    (select string_agg(n::text, ', ') from generate_series(1, 23) n)));
  r7_calls integer := pg_temp.marker_asked('select pg_temp.open_refills(2)');
begin
  if pg_temp.owner_bypasses() then
    return format('calls %s/%s, plan bypass', r6_calls, r7_calls)
      || case when r6_calls = 0 and r7_calls = 0
                   and not exists (select 1 from unnest(plan) line where line like '%refill_scan_open%')
              then ' (as asked once)' else ' (asked, under a bypass)' end;
  end if;
  select position into marker_line from unnest(plan) with ordinality planned(line, position)
   where line like '%THEN pharmacy.refill_scan_open()%';
  select substring(planned.line from 'InitPlan [0-9]+ \(returns (\$[0-9]+)\)') into marker_param
    from unnest(plan[1:marker_line]) with ordinality planned(line, position)
   where planned.line ~ 'InitPlan [0-9]+ \(returns'
   order by planned.position desc limit 1;
  select line into filter_line from unnest(plan) line where line ~ '^ *Filter: .* OR ' limit 1;
  return format('calls %s/%s, plan ', r6_calls, r7_calls)
    || case when r6_calls = 1 and r7_calls = 1
                 and (select count(*) from unnest(plan) line where line like '%refill_scan_open%') = 1
                 and position('(' || marker_param || ' OR ' in filter_line) > 0
            then '(as asked once)' else 'not as asked: ' || array_to_string(plan, E'\n') end;
end
$f$;
select pg_temp.expect('16f the marker''s policy is asked once per statement, first (an InitPlan)',
  regexp_replace(pg_temp.policy_once(), '^calls [01]/[01], plan (bypass )?', ''), '(as asked once)');

-- 17. The refills' last day (R8; the clinical owner's decision D9, 24
-- November 2026): refills end on the earliest of (a) ends_on, (b) the Lagos
-- day the prescription was written (created_at) plus (refills_allowed + 2)
-- fills' durations (a day 1, a week 7, a month 30) and (c) that day plus
-- 365; after that day R6 says 'ended', R4 refuses REFILL_PRESCRIPTION_ENDED
-- (DETAIL the day) and R7 leaves the item out. Fixtures as the suite runner
-- in replica mode, as the services would leave them (the prescription
-- written at the time given, its own work item accepted at version 1, fill
-- 1 recorded long enough ago for the refill interval to have passed), at
-- F1 for Bisi; each boundary in pairs, written at 00:00 Lagos ('0': the
-- last day is today) and one microsecond before ('1': it was yesterday):
--   a0, a1: refills 2 of 10 days, written now, ends_on today / yesterday;
--   b0, b1: refills 1 of 10 days (b: 30 days), written on day -30;
--   bw0, bw1: refills 1 of 1 week (b: 21 days), written on day -21;
--   bm0, bm1: refills 2 of 2 months (b: 240 days), written on day -240;
--   c0, c1: refills 11 of 1 month (b: 390 days, so c: 365), written on day
--   -365.
create temporary table refills_written (label text primary key, n integer unique, written_at timestamptz,
  refills integer, duration_value integer, duration_unit text, ends_on date, fill_at timestamptz, prescription uuid,
  item uuid) on commit drop;
grant select on refills_written to public;
insert into refills_written (label, n, written_at, refills, duration_value, duration_unit, ends_on, fill_at)
select fixture.label, fixture.n,
       case when fixture.written_day is null then clock_timestamp()
            else pg_temp.lagos_at(fixture.written_day, time '00:00') - fixture.before end,
       fixture.refills, fixture.duration_value, fixture.duration_unit, fixture.ends_on, pg_temp.lagos_at(fixture.fill_day)
  from (values ('a0', 1, null::integer, interval '0', 2, 10, 'day', pg_temp.lagos_day(0), -20),
               ('a1', 2, null, interval '0', 2, 10, 'day', pg_temp.lagos_day(-1), -20),
               ('b0', 3, -30, interval '0', 1, 10, 'day', null::date, -20),
               ('b1', 4, -30, interval '1 microsecond', 1, 10, 'day', null, -20),
               ('bw0', 5, -21, interval '0', 1, 1, 'week', null, -20),
               ('bw1', 6, -21, interval '1 microsecond', 1, 1, 'week', null, -20),
               ('bm0', 7, -240, interval '0', 2, 2, 'month', null, -200),
               ('bm1', 8, -240, interval '1 microsecond', 2, 2, 'month', null, -200),
               ('c0', 9, -365, interval '0', 11, 1, 'month', null, -300),
               ('c1', 10, -365, interval '1 microsecond', 11, 1, 'month', null, -300))
       fixture(label, n, written_day, before, refills, duration_value, duration_unit, ends_on, fill_day);
update refills_written set prescription = ('e1520019-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       item = ('e152001a-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
set local session_replication_role = replica;
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
  instructions, starts_on, ends_on, status, row_version, created_at, updated_at, refills_allowed, duration_value,
  duration_unit)
select written.prescription, 'e1520008-0000-4000-8000-000000000002', 'e1520006-0000-4000-8000-000000000002',
       'e1520001-0000-4000-8000-000000000001', pg_temp.account(1), pg_temp.membership(1), 'http://www.whocc.no/atc',
       'J01CA04', 'Amoxicillin 500 mg capsule (' || written.label || ')', 1, 'capsule', 'oral', 'Every 8 hours',
       'Take after food', null, written.ends_on, 'active', 1, written.written_at, written.written_at, written.refills,
       written.duration_value, written.duration_unit
  from refills_written written;
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, medication_code_system, medication_code,
  medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, starts_on, ends_on, prescribed_by,
  prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key, request_sha256,
  correlation_id)
select written.item, 'e1520006-0000-4000-8000-000000000002', 'e1520001-0000-4000-8000-000000000001',
       'e1520001-0000-4000-8000-000000000001', written.prescription, 1, 'e1520008-0000-4000-8000-000000000002', 'active',
       'http://www.whocc.no/atc', 'J01CA04', 'Amoxicillin 500 mg capsule (' || written.label || ')', 1, 'capsule',
       'oral', 'Every 8 hours', 'Take after food', null, written.ends_on, pg_temp.account(1), written.written_at,
       pg_temp.account(1), pg_temp.membership(1), 'Sent automatically when the prescription was activated',
       'refills-written-item-' || written.n, repeat('a', 64), 'refills-written'
  from refills_written written;
insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id,
  medication_code_system, medication_code, medication_display, quantity_dispensed, quantity_unit, dispensed_by,
  dispensed_by_membership_id, dispensed_at, reason, idempotency_key, request_sha256, correlation_id, fill_number)
select gen_random_uuid(), written.item, 1, 'e1520006-0000-4000-8000-000000000002',
       'e1520001-0000-4000-8000-000000000001', 'http://www.whocc.no/atc', 'J01CA04',
       'Amoxicillin 500 mg capsule (' || written.label || ')', 30, 'capsule', pg_temp.account(2), pg_temp.membership(2),
       written.fill_at, 'Dispensed to the patient', 'refills-written-fill-' || written.n, repeat('d', 64),
       'refills-written', 1
  from refills_written written;
set local session_replication_role = origin;
-- R6 for these items as PH: 'label:open/reason/last day' (the last day in
-- days from today in Lagos).
create function pg_temp.written_refills() returns text language plpgsql as $f$
declare answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  select string_agg(format('%s:%s/%s/%s', written.label, reader.refill_open::text, coalesce(reader.closed_reason, '-'),
           coalesce((reader.refills_end_on - pg_temp.lagos_day(0))::text, '-')), ' ' order by written.n)
    into answer
    from refills_written written
    join pharmacy.work_item_refills(array(select item from refills_written)) reader on reader.work_item_id = written.item;
  reset role;
  return answer;
end
$f$;
-- R4 on each item's fill 2 as PH (now; undone at once): 'label:ok' or
-- 'label:error / DETAIL'; and whether it agrees with R6's refill_open.
create function pg_temp.written_fill_two() returns text language plpgsql as $f$
declare
  written record;
  reader record;
  outcome text;
  answer text := '';
begin
  for written in select * from refills_written order by n loop
    set local role hid_pharmacy_api_runtime;
    perform pg_temp.as_member(2);
    select * into reader from pharmacy.work_item_refills(array[written.item]);
    begin
      outcome := pg_temp.try(pg_temp.dispense_sql(written.item, 2, 2, clock_timestamp()));
      raise exception using errcode = 'P0001', message = 'refills: undo the fill';
    exception when raise_exception then
      null;
    end;
    reset role;
    answer := answer || case when answer = '' then '' else ' ' end || written.label || ':'
      || case when outcome = 'ok' then 'ok' else replace(outcome, '23514 REFILL_PRESCRIPTION_ENDED / ', 'ended ') end
      || case when reader.refill_open = (outcome = 'ok') then '' else '(R6 disagrees)' end;
  end loop;
  return answer;
end
$f$;
-- R7 as PH: these items' labels, in R7's order.
create function pg_temp.written_open() returns text language sql as $f$
  select coalesce(string_agg(written.label, ' ' order by opened.position), 'none')
    from unnest(pg_temp.open_refills(2)) with ordinality opened(id, position)
    join refills_written written on written.item = opened.id
$f$;
-- R8 on each fixture's values, in days from today in Lagos.
create function pg_temp.written_days() returns text language sql as $f$
  select string_agg(written.label || ':' || coalesce((ehr.prescription_refills_end_on(written.written_at,
           written.refills::smallint, written.duration_value, written.duration_unit, written.ends_on)
           - pg_temp.lagos_day(0))::text, '-'), ' ' order by written.n)
    from refills_written written
$f$;
grant execute on function pg_temp.written_refills(), pg_temp.written_fill_two(), pg_temp.written_open(),
  pg_temp.written_days() to public;

-- 17a. R8 on its own: 0 (today) for each '0', -1 for each '1', whatever the
-- session's time zone (the Lagos day: at any hour one of the two far zones
-- is on another calendar day than Lagos); null without refills (0 or
-- null); a later ends_on never lengthens (b) or (c), an earlier one wins.
select pg_temp.expect('17a R8: the last day at Lagos midnight, under any session time zone',
  pg_temp.written_days() || ' | ' || coalesce(ehr.prescription_refills_end_on(now(), 0::smallint, 10, 'day', null)::text, '-')
  || ' ' || coalesce(ehr.prescription_refills_end_on(now(), null, 10, 'day', null)::text, '-') || ' '
  || (ehr.prescription_refills_end_on(pg_temp.lagos_at(0), 2::smallint, 30, 'day', pg_temp.lagos_day(400))
      - pg_temp.lagos_day(0)) || ' '
  || (ehr.prescription_refills_end_on(pg_temp.lagos_at(0), 2::smallint, 30, 'day', pg_temp.lagos_day(5))
      - pg_temp.lagos_day(0)),
  'a0:0 a1:-1 b0:0 b1:-1 bw0:0 bw1:-1 bm0:0 bm1:-1 c0:0 c1:-1 | - - 120 5');
set local timezone = 'Pacific/Kiritimati';
select pg_temp.expect('17a under TimeZone Pacific/Kiritimati (UTC+14): the same', pg_temp.written_days(),
  'a0:0 a1:-1 b0:0 b1:-1 bw0:0 bw1:-1 bm0:0 bm1:-1 c0:0 c1:-1');
set local timezone = 'Etc/GMT+12';
select pg_temp.expect('17a under TimeZone Etc/GMT+12 (UTC-12): the same', pg_temp.written_days(),
  'a0:0 a1:-1 b0:0 b1:-1 bw0:0 bw1:-1 bm0:0 bm1:-1 c0:0 c1:-1');
reset timezone;
-- 17b. R6: each '0' open on its last day (refills_end_on today), each '1'
-- closed 'ended' (refills_end_on yesterday); the same under the far zones.
select pg_temp.expect('17b R6: open on the last day, ended the day after, with refills_end_on',
  pg_temp.written_refills(),
  'a0:true/-/0 a1:false/ended/-1 b0:true/-/0 b1:false/ended/-1 bw0:true/-/0 bw1:false/ended/-1 bm0:true/-/0 '
  || 'bm1:false/ended/-1 c0:true/-/0 c1:false/ended/-1');
set local timezone = 'Pacific/Kiritimati';
select pg_temp.expect('17b under TimeZone Pacific/Kiritimati (UTC+14): the same', pg_temp.written_refills(),
  'a0:true/-/0 a1:false/ended/-1 b0:true/-/0 b1:false/ended/-1 bw0:true/-/0 bw1:false/ended/-1 bm0:true/-/0 '
  || 'bm1:false/ended/-1 c0:true/-/0 c1:false/ended/-1');
set local timezone = 'Etc/GMT+12';
select pg_temp.expect('17b under TimeZone Etc/GMT+12 (UTC-12): the same', pg_temp.written_refills(),
  'a0:true/-/0 a1:false/ended/-1 b0:true/-/0 b1:false/ended/-1 bw0:true/-/0 bw1:false/ended/-1 bm0:true/-/0 '
  || 'bm1:false/ended/-1 c0:true/-/0 c1:false/ended/-1');
reset timezone;
-- 17c. R4 agrees: fill 2 of each '0' passes, of each '1' is refused 23514
-- REFILL_PRESCRIPTION_ENDED with the last day (yesterday) as DETAIL; R6's
-- refill_open says the same for each (no '(R6 disagrees)'); the same under
-- the far zones. An expired prescription is not fillable.
select pg_temp.expect('17c R4: the refill passes on the last day, is refused ENDED (DETAIL the day) after it',
  pg_temp.written_fill_two(),
  replace('a0:ok a1:ended D b0:ok b1:ended D bw0:ok bw1:ended D bm0:ok bm1:ended D c0:ok c1:ended D', 'D',
    to_char(pg_temp.lagos_day(-1), 'YYYY-MM-DD')));
set local timezone = 'Pacific/Kiritimati';
select pg_temp.expect('17c under TimeZone Pacific/Kiritimati (UTC+14): the same', pg_temp.written_fill_two(),
  replace('a0:ok a1:ended D b0:ok b1:ended D bw0:ok bw1:ended D bm0:ok bm1:ended D c0:ok c1:ended D', 'D',
    to_char(pg_temp.lagos_day(-1), 'YYYY-MM-DD')));
set local timezone = 'Etc/GMT+12';
select pg_temp.expect('17c under TimeZone Etc/GMT+12 (UTC-12): the same', pg_temp.written_fill_two(),
  replace('a0:ok a1:ended D b0:ok b1:ended D bw0:ok bw1:ended D bm0:ok bm1:ended D c0:ok c1:ended D', 'D',
    to_char(pg_temp.lagos_day(-1), 'YYYY-MM-DD')));
reset timezone;
-- 17d. R7 agrees: it lists each '0' (the refill that opened first first:
-- c0, bm0, bw0, then a0 and b0, which opened the same day, by id) and no
-- '1'. An expired prescription is not listed.
select pg_temp.expect('17d R7 lists the refills whose last day is today, not those that ended yesterday',
  pg_temp.written_open(), 'c0 bm0 bw0 a0 b0');
set local timezone = 'Pacific/Kiritimati';
select pg_temp.expect('17d under TimeZone Pacific/Kiritimati (UTC+14): the same', pg_temp.written_open(),
  'c0 bm0 bw0 a0 b0');
set local timezone = 'Etc/GMT+12';
select pg_temp.expect('17d under TimeZone Etc/GMT+12 (UTC-12): the same', pg_temp.written_open(), 'c0 bm0 bw0 a0 b0');
reset timezone;
-- 17e. A change does not move the day: rx48 (refills 2 of 30 days, written
-- today by DR and sent by D7: its last day is today + 120, rule b), filled
-- once; then an edit of its instructions, a hold and a resume, and an end
-- date set 400 days on, each through ehr-api's own UPDATE: created_at, R8 on
-- the row and R6's refills_end_on stay today + 120 (R6 says changed: any
-- change ends the refills, 0101's check). Only an earlier ends_on (rule a)
-- would bring the day forward, and that is a change too.
create function pg_temp.rx48_day() returns text language plpgsql as $f$
declare
  current_row ehr.prescriptions := pg_temp.current_rx(48);
  reader text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  select format('%s/%s', coalesce(refills.closed_reason, '-'), refills.refills_end_on - pg_temp.lagos_day(0))
    into reader from pharmacy.work_item_refills(array[pg_temp.work_item_of(pg_temp.rx(48))]) refills;
  reset role;
  return format('v%s written=%s R8=%s R6=%s', current_row.row_version,
    (current_row.created_at = current_setting('refills.rx48_written')::timestamptz)::text,
    ehr.prescription_refills_end_on(current_row.created_at, current_row.refills_allowed, current_row.duration_value,
      current_row.duration_unit, current_row.ends_on) - pg_temp.lagos_day(0), reader);
end
$f$;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('17e fixtures: DR writes rx48 (refills 2 of 30 days), D7 sends it',
  pg_temp.try(pg_temp.prescribe_sql(48, 2, 2, null)) || ' ' || pg_temp.send(48), 'ok sent:item');
reset role;
select set_config('refills.rx48_written', (pg_temp.current_rx(48)).created_at::text, true);
select pg_temp.expect('17e an edit, a hold and resume and a later end date do not move the last day',
  pg_temp.fill(48, 1, as_of => pg_temp.lagos_at(-1)) || ' | ' || pg_temp.rx48_day() || ' | '
  || pg_temp.dr(48, new_instructions => 'Take after food, with water') || ' ' || pg_temp.rx48_day() || ' | '
  || pg_temp.dr(48, new_status => 'on_hold') || ' ' || pg_temp.dr(48, new_status => 'active') || ' '
  || pg_temp.rx48_day() || ' | ' || pg_temp.dr(48, new_ends_on => pg_temp.lagos_day(400)::text) || ' '
  || pg_temp.rx48_day(),
  'ok | v1 written=true R8=120 R6=not_yet/120 | ok v2 written=true R8=120 R6=changed/120 | ok ok v4 written=true R8=120 '
  || 'R6=changed/120 | ok v5 written=true R8=120 R6=changed/120');
-- 17f. R7's index can bound the read: the plan of R7's statement (as the
-- owner, marker held), with sequential scans off (the suite's table is
-- small, so unforced the planner reads it whole; this case shows the index
-- can serve the statement, not that the planner picks it: the 20,000-row
-- measurement in 0154's header shows it picked, unforced, under both owner
-- kinds), range-scans ehr.prescriptions_refills_facility_idx by the
-- facility and the time written (rule c as a leakproof range, so under
-- either owner kind); under an owner that bypasses row-level security R8's
-- day is a condition on the index too, and under a NOSUPERUSER NOBYPASSRLS
-- owner it is not (R8 is not leakproof), so there every refill prescription
-- of the facility written in the last 365 Lagos days is read.
select pg_temp.expect('17f R7''s statement can range-scan its index by facility and time written (seqscan off)',
  (select (bool_or(line ~ ('Index (Only )?Scan using prescriptions_refills_facility_idx|Bitmap Index Scan on '
                             || 'prescriptions_refills_facility_idx'))
           and bool_or(line ~ 'Index Cond: \(\(prescription\.facility_id = .*\) AND \(prescription\.created_at >= ')
           and pg_temp.owner_bypasses() = bool_or(line ~ 'Index Cond: .*ehr\.prescription_refills_end_on\('))::text
     from unnest(pg_temp.r7_statement_plan()) line),
  'true');

-- 17g. A late fill (the review of 24 November 2026): a refill
-- whose day, R4's interval after the latest fill, would fall after the
-- refills' last day can never be collected, so the refills are closed as
-- ended at once (R6 'ended', next_fill_on null; R4 REFILL_PRESCRIPTION_ENDED,
-- DETAIL the last day; R7 does not list it), not 'not_yet' with a day on
-- which R4 would refuse it. On the boundary, in pairs, at F1 for Bisi: both
-- allow 2 refills of 30 days (a refill opens 23 days after the latest fill),
-- written on Lagos day -110 (R8 rule (b): day -110 + 4 x 30 = day +10);
-- L0's fill 1 at 23:59:59.999999 Lagos on day -13 (its refill opens on day
-- +10, the last day itself: not_yet until then), L1's at 00:00 Lagos on day
-- -12 (it would open on day +11, after the last day: ended now, ten days
-- before the last day). The same under the far session time zones.
create temporary table refills_late (label text primary key, n integer unique, fill_at timestamptz,
  prescription uuid, item uuid) on commit drop;
grant select on refills_late to public;
insert into refills_late (label, n, fill_at)
values ('L0', 1, pg_temp.lagos_at(-12, time '00:00') - interval '1 microsecond'),
       ('L1', 2, pg_temp.lagos_at(-12, time '00:00'));
update refills_late set prescription = ('e152001b-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       item = ('e152001c-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
set local session_replication_role = replica;
insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
  instructions, starts_on, ends_on, status, row_version, created_at, updated_at, refills_allowed, duration_value,
  duration_unit)
select late.prescription, 'e1520008-0000-4000-8000-000000000002', 'e1520006-0000-4000-8000-000000000002',
       'e1520001-0000-4000-8000-000000000001', pg_temp.account(1), pg_temp.membership(1), 'http://www.whocc.no/atc',
       'J01CA04', 'Amoxicillin 500 mg capsule (' || late.label || ')', 1, 'capsule', 'oral', 'Every 8 hours',
       'Take after food', null, null, 'active', 1, pg_temp.lagos_at(-110), pg_temp.lagos_at(-110), 2, 30, 'day'
  from refills_late late;
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_prescription_id,
  source_ehr_prescription_version, source_encounter_id, source_status, medication_code_system, medication_code,
  medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, starts_on, ends_on, prescribed_by,
  prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason, idempotency_key, request_sha256,
  correlation_id)
select late.item, 'e1520006-0000-4000-8000-000000000002', 'e1520001-0000-4000-8000-000000000001',
       'e1520001-0000-4000-8000-000000000001', late.prescription, 1, 'e1520008-0000-4000-8000-000000000002', 'active',
       'http://www.whocc.no/atc', 'J01CA04', 'Amoxicillin 500 mg capsule (' || late.label || ')', 1, 'capsule',
       'oral', 'Every 8 hours', 'Take after food', null, null, pg_temp.account(1), pg_temp.lagos_at(-110),
       pg_temp.account(1), pg_temp.membership(1), 'Sent automatically when the prescription was activated',
       'refills-late-item-' || late.n, repeat('a', 64), 'refills-late'
  from refills_late late;
insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id,
  medication_code_system, medication_code, medication_display, quantity_dispensed, quantity_unit, dispensed_by,
  dispensed_by_membership_id, dispensed_at, reason, idempotency_key, request_sha256, correlation_id, fill_number)
select gen_random_uuid(), late.item, 1, 'e1520006-0000-4000-8000-000000000002',
       'e1520001-0000-4000-8000-000000000001', 'http://www.whocc.no/atc', 'J01CA04',
       'Amoxicillin 500 mg capsule (' || late.label || ')', 30, 'capsule', pg_temp.account(2), pg_temp.membership(2),
       late.fill_at, 'Dispensed to the patient', 'refills-late-fill-' || late.n, repeat('d', 64), 'refills-late', 1
  from refills_late late;
set local session_replication_role = origin;
-- R6, R4 (fill 2 now, undone at once) and R7 on L0 and L1 as PH:
-- 'label:open/reason/next/last day' (days from today in Lagos), then
-- 'label:R4's outcome' (the DETAIL as days from today), then R7's labels.
create function pg_temp.late_fill() returns text language plpgsql as $f$
declare
  late_row record;
  outcome text;
  answer text;
begin
  set local role hid_pharmacy_api_runtime;
  perform pg_temp.as_member(2);
  select string_agg(format('%s:%s/%s/%s/%s', late.label, reader.refill_open::text, coalesce(reader.closed_reason, '-'),
           coalesce((reader.next_fill_on - pg_temp.lagos_day(0))::text, '-'),
           coalesce((reader.refills_end_on - pg_temp.lagos_day(0))::text, '-')), ' ' order by late.n)
    into answer
    from refills_late late
    join pharmacy.work_item_refills(array(select item from refills_late)) reader on reader.work_item_id = late.item;
  answer := answer || ' |';
  for late_row in select * from refills_late order by n loop
    begin
      outcome := pg_temp.try(pg_temp.dispense_sql(late_row.item, 2, 2, clock_timestamp()));
      raise exception using errcode = 'P0001', message = 'refills: undo the fill';
    exception when raise_exception then
      null;
    end;
    answer := answer || ' ' || late_row.label || ':'
      || case when outcome ~ '[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              then regexp_replace(outcome, '[0-9]{4}-[0-9]{2}-[0-9]{2}$',
                     ((substring(outcome from '[0-9]{4}-[0-9]{2}-[0-9]{2}$'))::date - pg_temp.lagos_day(0))::text)
              else outcome end;
  end loop;
  answer := answer || ' | R7 ' || coalesce((select string_agg(late.label, ' ' order by late.n)
                                              from refills_late late
                                             where late.item = any (array(select opened.work_item_id
                                                                            from pharmacy.open_refill_work_items() opened))),
                                           'none');
  reset role;
  return answer;
end
$f$;
select pg_temp.expect('17g a late fill: a refill that would open after the last day is ended now; on the last day, not_yet',
  pg_temp.late_fill(),
  'L0:false/not_yet/10/10 L1:false/ended/-/10 | L0:23514 REFILL_TOO_SOON / 10 '
  || 'L1:23514 REFILL_PRESCRIPTION_ENDED / 10 | R7 none');
set local timezone = 'Pacific/Kiritimati';
select pg_temp.expect('17g under TimeZone Pacific/Kiritimati (UTC+14): the same', pg_temp.late_fill(),
  'L0:false/not_yet/10/10 L1:false/ended/-/10 | L0:23514 REFILL_TOO_SOON / 10 '
  || 'L1:23514 REFILL_PRESCRIPTION_ENDED / 10 | R7 none');
set local timezone = 'Etc/GMT+12';
select pg_temp.expect('17g under TimeZone Etc/GMT+12 (UTC-12): the same', pg_temp.late_fill(),
  'L0:false/not_yet/10/10 L1:false/ended/-/10 | L0:23514 REFILL_TOO_SOON / 10 '
  || 'L1:23514 REFILL_PRESCRIPTION_ENDED / 10 | R7 none');
reset timezone;

do $$ begin raise notice 'prescription refills: every case passed'; end $$;
rollback;
