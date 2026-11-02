// Called by the disposable full-schema rehearsal (test-patient-evidence-runtime.mjs) after the schema fixture is
// loaded. All records are synthetic copies of the fixture's Lab chain.
//
// The Lab work list (GET /api/v1/lab/work-items, WORK_LIST_QUERY) for a busy laboratory, read exactly as lab-api
// reads it: a restricted login of hid_lab_api_runtime under row-level security, the staff context of the fixture's
// consent-backed clinician, and the lab-api pool's 15-second statement timeout (database.service.ts). Every row the
// query reads from a Lab table pays its own row-level security check, whose cost is mostly the member's consent check
// (identity.has_active_consent_grant), so the number of consent checks is the machine-independent measure of the
// query's cost, and the time is the measure against the limit.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WORK_LIST_QUERY } = require('../../lab-api/dist/lab/lab-work-items.service.js');

const FACILITY = '10000000-0000-4000-8000-000000000002';
const OTHER_FACILITY = '10000000-0000-4000-8000-000000000003';
const FIXTURE_WORK_ITEM = 'f1000000-0000-4000-8000-000000000002';
/** Work items with every test released at its current version (done). */
const DONE_WORK_ITEMS = 1040;
const OPEN_STATES = ['no_test', 'test_only', 'accession_only', 'specimen_only', 'executed', 'result_entered',
  'released_then_amended', 'released_then_entered_in_error'];
const DONE_STATES = ['amended_and_released_again'];
const OTHER_FACILITY_STATES = ['other_facility_released', 'other_facility_open'];

const id = (prefix, n) => `${prefix}000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * Copies the fixture's chain (work item, requested test, accession, received specimen, completed execution, result at
 * version 2 with its two revisions) with session_replication_role = replica, so the copies keep the fixture's
 * patient, members and keys apart from their own ids and idempotency keys.
 */
const COPY_CHAIN = `
create or replace function pg_temp.work_list_copy(tbl regclass, src jsonb, o jsonb) returns void language plpgsql as $f$
begin execute format('insert into %s select (jsonb_populate_record(null::%s, $1)).*', tbl, tbl) using src || o; end $f$;
create or replace function pg_temp.work_list_id(p text, k int) returns uuid language sql immutable as
$f$ select (p || '000000-0000-4000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $f$;
do $do$
declare
  w jsonb := (select to_jsonb(x) from lab.work_items x where id='${FIXTURE_WORK_ITEM}');
  t jsonb := (select to_jsonb(x) from lab.work_item_requested_tests x where id='f1000000-0000-4000-8000-000000000006');
  a jsonb := (select to_jsonb(x) from lab.accessions x where id='f1000000-0000-4000-8000-000000000003');
  s jsonb := (select to_jsonb(x) from lab.specimens x where id='f1000000-0000-4000-8000-000000000005');
  e jsonb := (select to_jsonb(x) from lab.test_executions x where id='f2000000-0000-4000-8000-000000000001');
  r jsonb := (select to_jsonb(x) from lab.results x where id='f2000000-0000-4000-8000-000000000002');
  rv1 jsonb := (select to_jsonb(x) from lab.result_revisions x where result_id='f2000000-0000-4000-8000-000000000002' and version=1);
  rv2 jsonb := (select to_jsonb(x) from lab.result_revisions x where result_id='f2000000-0000-4000-8000-000000000002' and version=2);
  plan jsonb := current_setting('lab_work_list.plan')::jsonb;
  item jsonb; k int; st text; key text; at timestamptz; fac uuid; current_version int;
begin
  for item in select * from jsonb_array_elements(plan) loop
    k := (item->>'n')::int; st := item->>'state'; at := (item->>'at')::timestamptz; key := 'work-list-check-' || lpad(k::text, 8, '0');
    fac := case when st like 'other_facility%' then '${OTHER_FACILITY}'::uuid else '${FACILITY}'::uuid end;
    perform pg_temp.work_list_copy('lab.work_items', w, jsonb_build_object('id', pg_temp.work_list_id('c1', k),
      'source_ehr_order_id', pg_temp.work_list_id('c2', k), 'idempotency_key', key, 'accepted_at', at, 'created_at', at,
      'facility_id', fac, 'ordering_facility_id', fac, 'test_name', st));
    continue when st = 'no_test';
    perform pg_temp.work_list_copy('lab.work_item_requested_tests', t, jsonb_build_object('id', pg_temp.work_list_id('c3', k),
      'work_item_id', pg_temp.work_list_id('c1', k), 'facility_id', fac));
    continue when st = 'test_only';
    perform pg_temp.work_list_copy('lab.accessions', a, jsonb_build_object('id', pg_temp.work_list_id('c4', k),
      'work_item_id', pg_temp.work_list_id('c1', k), 'accession_number', 'WLC-' || lpad(k::text, 10, '0'),
      'idempotency_key', key, 'created_at', at, 'facility_id', fac));
    continue when st = 'accession_only';
    perform pg_temp.work_list_copy('lab.specimens', s, jsonb_build_object('id', pg_temp.work_list_id('c6', k),
      'accession_id', pg_temp.work_list_id('c4', k), 'requirement_id', pg_temp.work_list_id('c5', k),
      'specimen_identifier', 'WLC-S-' || lpad(k::text, 10, '0'), 'created_at', at, 'facility_id', fac));
    continue when st = 'specimen_only';
    perform pg_temp.work_list_copy('lab.test_executions', e, jsonb_build_object('id', pg_temp.work_list_id('c7', k),
      'accession_id', pg_temp.work_list_id('c4', k), 'specimen_id', pg_temp.work_list_id('c6', k),
      'requested_test_id', pg_temp.work_list_id('c3', k), 'idempotency_key', key, 'completed_idempotency_key', key || '-c',
      'facility_id', fac));
    continue when st = 'executed';
    current_version := case when st in ('released_then_amended', 'amended_and_released_again') then 3 else 2 end;
    perform pg_temp.work_list_copy('lab.results', r, jsonb_build_object('id', pg_temp.work_list_id('c8', k),
      'execution_id', pg_temp.work_list_id('c7', k), 'current_version', current_version, 'facility_id', fac));
    perform pg_temp.work_list_copy('lab.result_revisions', rv1, jsonb_build_object('id', pg_temp.work_list_id('c9', k),
      'result_id', pg_temp.work_list_id('c8', k), 'execution_id', pg_temp.work_list_id('c7', k), 'idempotency_key', key || '-r1',
      'facility_id', fac));
    perform pg_temp.work_list_copy('lab.result_revisions', rv2, jsonb_build_object('id', pg_temp.work_list_id('ca', k),
      'result_id', pg_temp.work_list_id('c8', k), 'execution_id', pg_temp.work_list_id('c7', k), 'idempotency_key', key || '-r2',
      'facility_id', fac));
    continue when st in ('result_entered', 'other_facility_open');
    for v in 2..(case when st = 'amended_and_released_again' then 3 else 2 end) loop
      insert into lab.result_verifications(id,result_id,execution_id,patient_id,facility_id,result_version,verified_by,
        verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,correlation_id)
      values (pg_temp.work_list_id(case v when 2 then 'cb' else 'eb' end, k), pg_temp.work_list_id('c8', k), pg_temp.work_list_id('c7', k),
        (r->>'patient_id')::uuid, fac, v, (r->>'created_by')::uuid, (r->>'created_by_membership_id')::uuid, at,
        'Synthetic work-list verification', key || '-v' || v, repeat('c', 64), 'synthetic-work-list-check');
      insert into lab.result_releases(id,verification_id,result_id,execution_id,patient_id,facility_id,result_version,released_by,
        released_by_membership_id,released_at,reason,idempotency_key,request_sha256,correlation_id)
      values (pg_temp.work_list_id(case v when 2 then 'cc' else 'ec' end, k), pg_temp.work_list_id(case v when 2 then 'cb' else 'eb' end, k),
        pg_temp.work_list_id('c8', k),
        pg_temp.work_list_id('c7', k), (r->>'patient_id')::uuid, fac, v, (r->>'created_by')::uuid,
        (r->>'created_by_membership_id')::uuid, at, 'Synthetic work-list release', key || '-l' || v, repeat('d', 64),
        'synthetic-work-list-check');
    end loop;
    if st = 'released_then_entered_in_error' then
      insert into lab.result_invalidations(id,result_id,execution_id,patient_id,facility_id,result_version,disposition,actor_id,
        actor_membership_id,reason,idempotency_key,request_sha256,correlation_id)
      values (pg_temp.work_list_id('cd', k), pg_temp.work_list_id('c8', k), pg_temp.work_list_id('c7', k), (r->>'patient_id')::uuid,
        fac, 2, 'entered_in_error', (r->>'created_by')::uuid, (r->>'created_by_membership_id')::uuid,
        'Synthetic work-list entered in error', key || '-i', repeat('e', 64), 'synthetic-work-list-check');
    end if;
  end loop;
end $do$;`;

export async function labWorkListRuntimeChecks({ admin, connect, password }) {
  // Done work, oldest first in time; open work both older and newer than all of it; another facility's work.
  const minutes = (base, n) => new Date(Date.parse(base) + n * 60000).toISOString();
  const plan = [
    ...Array.from({ length: DONE_WORK_ITEMS }, (_, i) => ({ n: i + 1, state: 'released', at: minutes('2026-01-01T00:00:00Z', i) })),
    ...OPEN_STATES.map((state, i) => ({ n: 2001 + i, state, at: minutes(i % 2 ? '2025-12-01T00:00:00Z' : '2026-06-01T00:00:00Z', i) })),
    ...DONE_STATES.map((state, i) => ({ n: 2101 + i, state, at: minutes('2026-05-01T00:00:00Z', i) })),
    ...OTHER_FACILITY_STATES.map((state, i) => ({ n: 3001 + i, state, at: minutes('2026-07-01T00:00:00Z', i) })),
  ];
  await admin.query('begin');
  try {
    await admin.query("set local session_replication_role = replica");
    await admin.query("select set_config('lab_work_list.plan',$1,true)", [JSON.stringify(plan)]);
    await admin.query(COPY_CHAIN);
    await admin.query('commit');
  } catch (error) { await admin.query('rollback'); throw error; }
  await admin.query('analyze lab.work_items, lab.work_item_requested_tests, lab.accessions, lab.specimens, lab.test_executions, lab.results, lab.result_releases, lab.result_invalidations');
  await admin.query(`create role lab_work_list_test login inherit nosuperuser nobypassrls password '${password}';
    grant hid_lab_api_runtime to lab_work_list_test; alter role lab_work_list_test set track_functions = 'all';`);
  const visible = Number((await admin.query('select count(*) n from lab.work_items where facility_id=$1', [FACILITY])).rows[0].n);
  const releases = Number((await admin.query('select count(*) n from lab.result_releases where facility_id=$1', [FACILITY])).rows[0].n);
  assert.ok(visible > 1000, 'More than 1,000 work items at the laboratory');
  const lab = await connect('lab_work_list_test');
  let rows, ms, consentChecks;
  try {
    await lab.query('begin');
    await lab.query(`select set_config('app.actor_subject','staff:test-clinician',true),set_config('app.facility_id',$1,true),
      set_config('app.membership_id','40000000-0000-4000-8000-000000000001',true),set_config('app.purpose_of_use','direct-care',true),
      set_config('app.correlation_id','synthetic-work-list-check',true),set_config('app.patient_id','',true),
      set_config('app.self_authorized_until','',true),set_config('statement_timeout','15000',true)`, [FACILITY]);
    const started = performance.now();
    // As LabWorkItemsService.list runs it; a 57014 here is the busy laboratory's error page.
    rows = (await lab.query(WORK_LIST_QUERY, [FACILITY])).rows;
    ms = Math.round(performance.now() - started);
    consentChecks = Number((await lab.query(`select pg_stat_get_xact_function_calls(
      'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure) n`)).rows[0].n);
  } finally { await lab.query('rollback').catch(() => {}); await lab.end(); }
  assert.equal(rows.length, 200, 'The work list answers 200 rows');
  assert.ok(rows.every((row) => row.facility_id === FACILITY), 'Another facility\'s work is never shown');
  // Each work item and its requested test once, each release and its result and execution once, and the accession
  // and specimens of the rows answered: no Lab table is read again per work item (the first open-first query read
  // about 10 rows a work item and timed out here; the oldest-200 query read 3).
  const bound = 2 * visible + 3 * releases + 2 * rows.length + 100;
  assert.ok(consentChecks > 0 && consentChecks <= bound,
    `Row-level security checks: ${consentChecks} for ${visible} work items (at most ${bound})`);
  // Open work first, oldest first, in every open state; then done work, newest first. The fixture's own work item is
  // left out of the comparison (its state is whatever the checks run before this one left).
  const mine = rows.filter((row) => row.id !== FIXTURE_WORK_ITEM);
  const byTime = (x, y) => x.at.localeCompare(y.at) || x.n - y.n;
  const openPlan = plan.filter((item) => OPEN_STATES.includes(item.state)).sort(byTime);
  const donePlan = plan.filter((item) => item.state === 'released' || DONE_STATES.includes(item.state)).sort(byTime).reverse();
  assert.deepEqual(mine.slice(0, openPlan.length).map((row) => row.id), openPlan.map((item) => id('c1', item.n)),
    'Every open state comes first, oldest first');
  assert.deepEqual(mine.slice(openPlan.length).map((row) => row.id),
    donePlan.slice(0, mine.length - openPlan.length).map((item) => id('c1', item.n)), 'Done work fills the rest, newest first');
  return { workItems: visible, ms, consentChecks, consentChecksPerWorkItem: Number((consentChecks / visible).toFixed(2)),
    statementTimeoutMs: 15000 };
}
