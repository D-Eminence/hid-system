// Owner decision 33.3 (migration 0111): a switch-off of One-person lab and a self-check exclude each other. The
// governance trigger holds identity.facility_lab_check_current FOR SHARE and the setter takes it FOR UPDATE; this
// script proves, with two sessions, the three outcomes that the single-session suite
// (test/database/lab-one-person-check.integration.sql) cannot:
//   1. an open self-check blocks a switch-off (55P03 under lock_timeout), which succeeds once the check commits;
//   2. a SERIALIZABLE self-check whose snapshot predates a committed switch-off fails 40001, and its retry (as the
//      Lab API retries) is refused 23514 LAB_RESULT_SECOND_CHECK_REQUIRED;
//   3. a READ COMMITTED self-check waiting on an open switch-off is refused 23514 LAB_RESULT_SECOND_CHECK_REQUIRED
//      when the switch-off commits.
//
// It COMMITS synthetic rows (the suite's fixture, then append-only settings and a verification), so it runs only
// against a disposable database that has 0001-0111 and the runtime roles (bootstrap-database-roles.mjs) and has never
// run it: LAB_ONE_PERSON_RACE_DATABASE_URL names it and LAB_ONE_PERSON_RACE_DISPOSABLE=true confirms it may be
// written. Connect as the database owner (the fixture sets session_replication_role and switches to the runtime
// roles). Nothing it prints carries a reason or patient data beyond the synthetic fixture's ids.
//
//   LAB_ONE_PERSON_RACE_DISPOSABLE=true LAB_ONE_PERSON_RACE_DATABASE_URL=postgresql://... \
//     node services/ehr-api/scripts/lab-one-person-race-checks.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const FACILITY = 'b1100000-0000-4000-8000-000000000011';
const PATIENT = 'b1150000-0000-4000-8000-000000000001';
const SUITE = new URL('../test/database/lab-one-person-check.integration.sql', import.meta.url);
const MEMBERS = { ADM: ['adm', 1], A: ['a', 2] };

/** The suite's fixture: from its `begin;` to the end of its replica block, committed here. */
export async function suiteFixture() {
  const text = await readFile(SUITE, 'utf8');
  const start = text.indexOf('\nbegin;\n');
  const endMarker = 'set local session_replication_role = origin;\n';
  const end = text.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, 'the suite fixture markers were not found');
  return text.slice(start + '\nbegin;\n'.length, end + endMarker.length);
}

const session = (client, member, purpose) => client.query(`select set_config('app.actor_subject', $1, true),
  set_config('app.facility_id', $2, true), set_config('app.correlation_id', 'onepl-race-correlation-0001', true),
  set_config('app.membership_id', $3, true), set_config('app.purpose_of_use', $4, true)`,
[`synthetic:onepl-${MEMBERS[member][0]}`, FACILITY, `b1130000-0000-4000-8000-00000000000${MEMBERS[member][1]}`, purpose]);

/** The Lab API's verification insert for chain n (A entered version 1), as a self-check. */
const selfCheck = (client, chain, key) => client.query(`insert into lab.result_verifications(result_id, execution_id,
  patient_id, facility_id, result_version, verified_by, verified_by_membership_id, verified_at, reason, idempotency_key,
  request_sha256, correlation_id, self_check) values ($1, $2, $3, $4, 1, 'b1110000-0000-4000-8000-000000000002',
  'b1130000-0000-4000-8000-000000000002', clock_timestamp(), 'I am the only scientist at this lab', $5, repeat('b', 64),
  'onepl-race-correlation-0001', true)`,
[`b11c0000-0000-4000-8000-00000000001${chain}`, `b11c0000-0000-4000-8000-00000000000${chain}`, PATIENT, FACILITY, key]);

const beginLab = async (client, isolation) => {
  await client.query(`begin isolation level ${isolation}`);
  await client.query('set local role hid_lab_api_runtime');
  await session(client, 'A', 'direct-care');
};
const beginSwitch = async (client) => {
  await client.query('begin');
  await client.query('set local role hid_identity_api_runtime');
  await session(client, 'ADM', 'healthcare-operations');
};
const setSwitch = (client, enabled, reason) =>
  client.query('select * from identity.set_facility_one_person_lab($1, $2)', [enabled, reason]);
const switchCommitted = async (client, enabled, reason) => {
  await beginSwitch(client); await setSwitch(client, enabled, reason); await client.query('commit');
};
const outcome = (promise) => promise.then(() => 'ok', (error) => `${error.code} ${error.message}`);

async function waitForLock(monitor, pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await monitor.query(`select wait_event_type from pg_stat_activity where pid = $1`, [pid]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.fail('the self-check never waited on the switch-off');
}

export async function labOnePersonRaceChecks(connectionString) {
  const connect = async () => { const client = new pg.Client({ connectionString, application_name: 'lab-one-person-race' });
    await client.connect(); return client; };
  const owner = await connect(); const lab = await connect(); const admin = await connect(); const monitor = await connect();
  const results = [];
  try {
    const used = await owner.query(`select count(*)::int as n from identity.facility_lab_check_settings where facility_id = $1`, [FACILITY]);
    assert.equal(used.rows[0].n, 0, 'the race checks already ran on this database: use a fresh disposable database');
    await owner.query('begin'); await owner.query(await suiteFixture()); await owner.query('commit');
    await switchCommitted(admin, true, 'Only one scientist works here');

    // 1. An open self-check blocks a switch-off; once it commits, the switch-off goes through.
    await beginLab(lab, 'serializable');
    await selfCheck(lab, 1, 'onepl-race-check-1');
    await beginSwitch(admin);
    await admin.query(`set local lock_timeout = '300ms'`);
    const blocked = await outcome(setSwitch(admin, false, 'A second scientist has joined'));
    await admin.query('rollback');
    assert.match(blocked, /^55P03 /, `1: a switch-off during an open self-check answered ${blocked}`);
    await lab.query('commit');
    const recorded = await owner.query(`select self_check, one_person_setting_id is not null as has_setting
      from lab.result_verifications where result_id = 'b11c0000-0000-4000-8000-000000000011'`);
    assert.deepEqual(recorded.rows, [{ self_check: true, has_setting: true }], '1: the self-check was not recorded');
    await switchCommitted(admin, false, 'A second scientist has joined');
    results.push('1 an open self-check blocks a switch-off (55P03), which succeeds after it commits');

    // 2. A SERIALIZABLE self-check whose snapshot predates a committed switch-off.
    await switchCommitted(admin, true, 'The second scientist left again');
    await beginLab(lab, 'serializable');
    // The Lab API's first statement, which takes the snapshot.
    await lab.query(`select 1 from lab.results where id = 'b11c0000-0000-4000-8000-000000000012' for update`);
    await switchCommitted(admin, false, 'A second scientist joined again');
    const stale = await outcome(selfCheck(lab, 2, 'onepl-race-check-2'));
    await lab.query('rollback');
    assert.match(stale, /^40001 /, `2: a stale self-check answered ${stale}`);
    await beginLab(lab, 'serializable');
    const retried = await outcome(selfCheck(lab, 2, 'onepl-race-check-2'));
    await lab.query('rollback');
    assert.equal(retried, '23514 LAB_RESULT_SECOND_CHECK_REQUIRED', `2: the retry answered ${retried}`);
    results.push('2 a stale SERIALIZABLE self-check fails 40001; its retry is LAB_RESULT_SECOND_CHECK_REQUIRED');

    // 3. A READ COMMITTED self-check waiting on an open switch-off.
    await switchCommitted(admin, true, 'The second scientist left once more');
    await beginSwitch(admin); await setSwitch(admin, false, 'The second scientist is back');
    await beginLab(lab, 'read committed');
    const waiting = outcome(selfCheck(lab, 3, 'onepl-race-check-3'));
    await waitForLock(monitor, lab.processID);
    await admin.query('commit');
    const answered = await waiting;
    await lab.query('rollback');
    assert.equal(answered, '23514 LAB_RESULT_SECOND_CHECK_REQUIRED', `3: the waiting self-check answered ${answered}`);
    results.push('3 a READ COMMITTED self-check waiting on a switch-off is LAB_RESULT_SECOND_CHECK_REQUIRED');
    return results;
  } finally {
    for (const client of [lab, admin, owner, monitor]) await client.end().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const connectionString = process.env.LAB_ONE_PERSON_RACE_DATABASE_URL;
  if (!connectionString || process.env.LAB_ONE_PERSON_RACE_DISPOSABLE !== 'true') {
    console.error('Set LAB_ONE_PERSON_RACE_DATABASE_URL to a disposable database and LAB_ONE_PERSON_RACE_DISPOSABLE=true');
    process.exit(2);
  }
  try {
    for (const line of await labOnePersonRaceChecks(connectionString)) console.log(`ok ${line}`);
  } catch (error) {
    console.error(`lab one-person race checks failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
