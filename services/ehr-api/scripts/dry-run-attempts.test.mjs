import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DRY_RUN_ATTEMPTS, DRY_RUN_PAUSE_MS, DRY_RUN_WINDOW_MS, dryRunAttemptOptions, isBusyRefusal, MigrationFileError,
  withDryRunAttempts,
} from './dry-run-attempts.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const tail = 'run the release again at a quieter time';
const databaseError = (code, message) => Object.assign(new Error(message), { code });
const busy = (version = '0131_own_facility_patient_access.sql') => new MigrationFileError(version, databaseError('55P03',
  `${version.slice(0, 4)}: identity.consent_grants or ehr.encounters is busy, and this transaction already holds an `
  + `earlier migration's locks, so it does not wait; nothing applied; ${tail}`));

function clock(stepMs = 0) {
  let time = 1_000_000;
  return { now: () => time, advance: (ms) => { time += ms; }, step: () => { time += stepMs; } };
}

test('a file\'s own busy refusals are retried, in each wording the files use', () => {
  assert.equal(isBusyRefusal(busy()), true);
  assert.equal(isBusyRefusal(new MigrationFileError('0133_own_facility_pharmacy_and_lab_work.sql', databaseError('55P03',
    `0133: a table 0133 locks (or auth.accounts' indexes) stayed busy for 5 seconds; nothing applied; ${tail}`))), true);
  // 0128 is first in Release A and has no one-attempt branch; its wording has no "nothing applied".
  assert.equal(isBusyRefusal(new MigrationFileError('0128_patient_access_pin_notice_and_named_requester.sql',
    databaseError('55P03', `0128: identity.outbox_events stayed busy for 5 seconds; ${tail}`))), true);
});

// Q132 A (0148, number provisional): the file's own busy refusals, read from the file itself, each with
// PostgreSQL's lock message where a post-check probe puts sqlerrm. Every 55P03 the file raises is read here, so a new
// one, or a reworded one, meets this test.
test('0148\'s own busy refusals, read from the file, are each retried', async () => {
  const directory = path.join(scripts, '..', 'database', 'migrations');
  const [file, ...others] = (await readdir(directory)).filter(name => /^\d{4}_prescription_changes_after_dispensing\.sql$/.test(name));
  assert.ok(file, 'the migration file of Q132 A');
  assert.deepEqual(others, []);
  const sql = await readFile(path.join(directory, file), 'utf8');
  const sqlerrm = 'could not obtain lock on relation "work_items"';
  const literal = "'(?:[^']|'')*'";
  const raises = [...sql.matchAll(new RegExp(`errcode = '55P03',\\s*message = ((?:${literal}|sqlerrm)(?:\\s*\\|\\|\\s*(?:${literal}|sqlerrm))*);`, 'g'))];
  assert.equal(raises.length, (sql.match(/'55P03'/g) ?? []).length, 'every 55P03 the file raises has a message read here');
  // Section 1 (the 5-second bound and the one-attempt branch) and the three post-check probes.
  assert.equal(raises.length, 5);
  const texts = raises.map(([, expression]) => expression.split(/\s*\|\|\s*/)
    .map(part => (part === 'sqlerrm' ? sqlerrm : part.slice(1, -1).replaceAll("''", "'"))).join(''));
  assert.equal(texts.filter(text => text.includes(sqlerrm)).length, 3, 'the three probes name the lock they met');
  for (const text of texts) {
    assert.ok(text.startsWith(`${file.slice(0, 4)}: `), text);
    assert.equal(isBusyRefusal(new MigrationFileError(file, databaseError('55P03', text))), true, text);
    // The same words under another SQLSTATE are not a busy refusal.
    assert.equal(isBusyRefusal(new MigrationFileError(file, databaseError('55000', text))), false, text);
  }
});

/** A migration file's own 55P03 refusals, as the server raises them: its quoted parts joined, '' read as '. */
async function busyRefusalsOf(file) {
  const sql = await readFile(path.join(scripts, '../database/migrations', file), 'utf8');
  return [...sql.matchAll(/errcode = '55P03',\s*message = ((?:'(?:[^']|'')*'\s*(?:\|\|\s*)?)+);/g)]
    .map(([, literals]) => [...literals.matchAll(/'((?:[^']|'')*)'/g)].map(([, part]) => part.replaceAll("''", "'")).join(''));
}

// Rahman, #320 finding 1; and his re-review's finding 2: the attempt also takes ACCESS SHARE on both of 0149's lists
// (the status's body check reads them), so both refusals name the three tables and are still retried.
test('0152\'s two busy refusals, read from the file, name the versions table and both lists, and are retried', async () => {
  const file = '0152_catalog_diagnoses.sql';
  const refusals = await busyRefusalsOf(file);
  const tables = 'ehr.catalog_versions (a catalogue search or load), ehr.catalog_medicines or ehr.catalog_lab_tests';
  assert.deepEqual(refusals, [
    `0152: ${tables} is busy and this transaction already holds an earlier migration's locks, so it does not wait; `
      + `nothing applied; ${tail}`,
    `0152: ${tables} stayed busy for 5 seconds; nothing applied; ${tail}`,
  ]);
  for (const message of refusals) {
    assert.match(message, /ehr\.catalog_medicines/);
    assert.match(message, /ehr\.catalog_lab_tests/);
    assert.equal(isBusyRefusal(new MigrationFileError(file, databaseError('55P03', message))), true, message);
  }
  // The lists are locked in the same NOWAIT attempt as the versions table, before the status is replaced.
  const sql = await readFile(path.join(scripts, '../database/migrations', file), 'utf8');
  const attempt = sql.indexOf('lock table ehr.catalog_versions in access exclusive mode nowait;');
  const lists = sql.indexOf('lock table ehr.catalog_medicines, ehr.catalog_lab_tests in access share mode nowait;');
  const handler = sql.indexOf('exception when lock_not_available then', attempt);
  assert.ok(attempt > 0 && lists > attempt && lists < handler, 'the lists are locked inside the attempt');
  assert.ok(lists < sql.indexOf('create or replace function ehr.catalog_status()'), 'before the status is replaced');
});

test('anything else is not retried', () => {
  const file = '0131_own_facility_patient_access.sql';
  for (const error of [
    // The server's lock_timeout, not the file's own refusal.
    new MigrationFileError(file, databaseError('55P03', 'canceling statement due to lock timeout')),
    // Another file's wording inside this file's failure.
    new MigrationFileError(file, databaseError('55P03', `0130: identity.facilities stayed busy for 5 seconds; nothing applied; ${tail}`)),
    // The right words under another SQLSTATE.
    new MigrationFileError(file, databaseError('57014', `0131: x is busy, and this transaction already holds an earlier migration's locks, so it does not wait; nothing applied; ${tail}`)),
    // 0136's stop for real staff (owner Q113 A) is a decision, not a busy table.
    new MigrationFileError('0136_role_permission_changes.sql', databaseError('P0001', '0136 stopped, nothing was changed: real staff would be affected')),
    new MigrationFileError(file, databaseError('40P01', 'deadlock detected')),
    // Not a migration file's failure at all.
    Object.assign(new Error(`0131: x so it does not wait; nothing applied; ${tail}`), { code: '55P03' }),
  ]) {
    assert.equal(isBusyRefusal(error), false, error.message);
  }
});

test('busy on the first attempt and free on the second: the dry run passes, with one line for the refusal', async () => {
  const lines = [];
  const pauses = [];
  const time = clock();
  const answers = [busy(), 'ok'];
  let calls = 0;
  const result = await withDryRunAttempts(async (number) => {
    calls += 1;
    assert.equal(number, calls);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  }, { log: (line) => lines.push(line), sleep: async (ms) => { pauses.push(ms); time.advance(ms); }, now: time.now, random: () => 0.5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal(pauses.length, 1);
  assert.ok(pauses[0] >= DRY_RUN_PAUSE_MS.min && pauses[0] <= DRY_RUN_PAUSE_MS.max);
  assert.deepEqual(lines, [`Dry run attempt 1 of ${DRY_RUN_ATTEMPTS}: 0131_own_facility_patient_access.sql was busy; `
    + `rolled back, trying again in ${pauses[0]} ms\n`]);
});

test('never free: it stops after the bound with the file\'s own refusal, unchanged', async () => {
  const lines = [];
  const time = clock();
  let calls = 0;
  const last = busy();
  const failure = await withDryRunAttempts(async () => {
    calls += 1;
    throw calls === DRY_RUN_ATTEMPTS ? last : busy();
  }, { log: (line) => lines.push(line), sleep: async (ms) => time.advance(ms), now: time.now, random: () => 0 })
    .catch((error) => error);
  assert.equal(failure, last);
  assert.equal(failure.message, `Migration 0131_own_facility_patient_access.sql: ${last.cause.message}`);
  assert.equal(calls, DRY_RUN_ATTEMPTS);
  assert.equal(lines.length, DRY_RUN_ATTEMPTS);
  assert.match(lines.at(-1), new RegExp(`^Dry run attempt ${DRY_RUN_ATTEMPTS} of ${DRY_RUN_ATTEMPTS}: 0131_own_facility_patient_access\\.sql was busy; no attempt left\\n$`));
});

test('never past the window: a slow attempt ends the retries before the attempt bound', async () => {
  const time = clock();
  let calls = 0;
  const failure = await withDryRunAttempts(async () => {
    calls += 1;
    time.advance(70_000);
    throw busy();
  }, { log: () => {}, sleep: async (ms) => time.advance(ms), now: time.now, random: () => 1 }).catch((error) => error);
  assert.ok(isBusyRefusal(failure));
  // 70 s per attempt plus a 6 s pause: the fourth attempt ends at 298 s, and a fifth could not start in time.
  assert.equal(calls, 4);
  assert.ok(time.now() - 1_000_000 < DRY_RUN_WINDOW_MS);
});

test('any other error stops at once, with no retry and no attempt line', async () => {
  const lines = [];
  let calls = 0;
  const error = new MigrationFileError('0136_role_permission_changes.sql',
    databaseError('P0001', '0136 stopped, nothing was changed: real staff would be affected'));
  const failure = await withDryRunAttempts(async () => { calls += 1; throw error; },
    { log: (line) => lines.push(line), sleep: async () => assert.fail('no pause') }).catch((value) => value);
  assert.equal(failure, error);
  assert.equal(calls, 1);
  assert.deepEqual(lines, []);
});

test('the pause is random within its bounds', async () => {
  for (const [random, expected] of [[0, DRY_RUN_PAUSE_MS.min], [0.999999, DRY_RUN_PAUSE_MS.max]]) {
    const pauses = [];
    const answers = [busy(), 'ok'];
    await withDryRunAttempts(async () => {
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    }, { log: () => {}, sleep: async (ms) => pauses.push(ms), random: () => random });
    assert.deepEqual(pauses, [expected]);
  }
});

test('the test-only bounds are refused outside tests and checked', () => {
  assert.deepEqual(dryRunAttemptOptions({}), {});
  assert.throws(() => dryRunAttemptOptions({ NODE_ENV: 'production', HID_TEST_DRY_RUN_ATTEMPTS: '3' }), /test-only/);
  assert.deepEqual(dryRunAttemptOptions({ NODE_ENV: 'test', HID_TEST_DRY_RUN_ATTEMPTS: '3', HID_TEST_DRY_RUN_PAUSE_MS: '200' }),
    { attempts: 3, pauseMs: { min: 200, max: 200 } });
  for (const value of ['0', '21', 'x', '3.5']) {
    assert.throws(() => dryRunAttemptOptions({ NODE_ENV: 'test', HID_TEST_DRY_RUN_ATTEMPTS: value }), /1-20/);
  }
  assert.throws(() => dryRunAttemptOptions({ NODE_ENV: 'test', HID_TEST_DRY_RUN_PAUSE_MS: '7000' }), /0-6000/);
});

test('the runner retries only its dry run; --plan and the apply are as before', async () => {
  const runner = await readFile(path.join(scripts, 'apply-migrations.mjs'), 'utf8');
  assert.match(runner, /import \{ dryRunAttemptOptions, MigrationFileError, withDryRunAttempts \} from '\.\/dry-run-attempts\.mjs';/);
  assert.equal((runner.match(/withDryRunAttempts\(/g) ?? []).length, 1);
  const dryRunBlock = runner.slice(runner.indexOf('if (dryRun) {'), runner.indexOf("process.stdout.write('Dry run succeeded"));
  assert.match(dryRunBlock, /await withDryRunAttempts\(async \(attempt\) => \{/);
  assert.match(dryRunBlock, /throw new MigrationFileError\(migration\.version, error\);/);
  // The apply: one transaction per file, no retry.
  const applyBlock = runner.slice(runner.indexOf("process.stdout.write('Dry run succeeded"));
  assert.doesNotMatch(applyBlock, /withDryRunAttempts|MigrationFileError/);
  assert.match(applyBlock, /await client\.query\('begin'\);\n\s+await client\.query\("set local lock_timeout = '5s'"\);/);
});

test('0154\'s two busy refusals, read from the file, are ones the dry run retries', async () => {
  const file = '0154_prescription_refills.sql';
  const sql = await readFile(path.join(scripts, '../database/migrations', file), 'utf8');
  // Each 55P03 the file raises: the SQL string literals joined by || after "message =".
  const messages = [];
  for (const raised of sql.split("errcode = '55P03',").slice(1)) {
    const literals = /^\s*message\s*=\s*((?:'(?:[^']|'')*'\s*(?:\|\|\s*)?)+)/.exec(raised);
    assert.ok(literals, `a 55P03 in ${file} has no literal message`);
    messages.push([...literals[1].matchAll(/'((?:[^']|'')*)'/g)].map((part) => part[1].replaceAll("''", "'")).join(''));
  }
  const tables = 'pharmacy.dispensings, ehr.prescriptions or a table 0154 reads (the Pharmacy work items, the order '
    + 'routes, 0133\'s claims or the dispensing reversals)';
  assert.deepEqual(messages, [
    `0154: ${tables} is busy, and this transaction already holds an earlier migration's locks, so it does not wait; `
      + `nothing applied; ${tail}`,
    `0154: ${tables} stayed busy for 5 seconds; nothing applied; ${tail}`,
  ]);
  for (const message of messages) {
    assert.equal(isBusyRefusal(new MigrationFileError(file, databaseError('55P03', message))), true, message);
    // Under another file's name, or another SQLSTATE, it is not this file's busy refusal.
    assert.equal(isBusyRefusal(new MigrationFileError('0153_clinician_recent_diagnoses.sql', databaseError('55P03', message))), false);
    assert.equal(isBusyRefusal(new MigrationFileError(file, databaseError('57014', message))), false);
  }
});

test('0154 locks, NOWAIT and before it prints them, every table whose policies or keys it prints', async () => {
  // pg_get_expr and pg_get_constraintdef open the table they print for, so a table section 3 prints and section 2
  // does not lock waits behind DDL for the runner's lock_timeout, with the two ACCESS EXCLUSIVE locks held, and
  // fails with the server's message, which the dry run does not retry (Rahman's review of #331, 25 November 2026:
  // pharmacy.dispensing_reversals' policies).
  const sql = await readFile(path.join(scripts, '../database/migrations/0154_prescription_refills.sql'), 'utf8');
  const section2 = sql.slice(sql.indexOf('\n-- 2. Locks (see Locks)'), sql.indexOf('\n-- 3. Under the locks:'));
  const shared = /lock table ([^;]+?) in access share mode nowait;/.exec(section2);
  const exclusive = /lock table ([^;]+?) in access exclusive mode nowait;/.exec(section2);
  assert.ok(shared && exclusive, 'section 2 takes ACCESS SHARE and then ACCESS EXCLUSIVE, NOWAIT');
  assert.ok(section2.indexOf(shared[0]) < section2.indexOf(exclusive[0]), 'the weak locks first');
  const listed = (statement) => statement.split(',').map((name) => name.trim());
  assert.deepEqual(listed(shared[1]), ['pharmacy.work_items', 'ehr.order_routes', 'pharmacy.prescription_item_claims',
    'pharmacy.dispensing_reversals']);
  assert.deepEqual(listed(exclusive[1]), ['pharmacy.dispensings', 'ehr.prescriptions']);
  const locked = new Set([...listed(shared[1]), ...listed(exclusive[1])]);
  // Section 3's policy check names the tables whose policies it prints; its CHECK and key checks name theirs.
  const section3 = sql.slice(sql.indexOf('\n-- 3. Under the locks:'), sql.indexOf('\n-- 4. R8, '));
  const printed = new Set([...section3.matchAll(/'([a-z_]+\.[a-z_]+)'::regclass/g)].map((found) => found[1]));
  assert.ok(printed.has('pharmacy.dispensing_reversals'));
  for (const table of printed) assert.ok(locked.has(table), `section 3 prints for ${table}, which section 2 does not lock`);
});

// ORD-11 (0159, number booked; the final number is given at integration): the file's two busy refusals, read from the
// file itself, are ones the dry run retries.
test('0159\'s two busy refusals, read from the file, are ones the dry run retries', async () => {
  const file = '0159_order_notices.sql';
  const sql = await readFile(path.join(scripts, '../database/migrations', file), 'utf8');
  const messages = [];
  for (const raised of sql.split("errcode = '55P03',").slice(1)) {
    const literals = /^\s*message\s*=\s*((?:'(?:[^']|'')*'\s*(?:\|\|\s*)?)+)/.exec(raised);
    assert.ok(literals, `a 55P03 in ${file} has no literal message`);
    messages.push([...literals[1].matchAll(/'((?:[^']|'')*)'/g)].map((part) => part[1].replaceAll("''", "'")).join(''));
  }
  const tables = 'a lab result, dispensing or patient table, or a table 0159 reads (the order routes, their reports, '
    + 'the permissions or the legal holds)';
  assert.deepEqual(messages, [
    `0159: ${tables}, is busy, and this transaction already holds an earlier migration's locks, so it does not wait; `
      + `nothing applied; ${tail}`,
    `0159: ${tables}, stayed busy for 5 seconds; nothing applied; ${tail}`,
  ]);
  for (const message of messages) {
    assert.equal(isBusyRefusal(new MigrationFileError(file, databaseError('55P03', message))), true, message);
    assert.equal(isBusyRefusal(new MigrationFileError('0154_prescription_refills.sql', databaseError('55P03', message))), false);
    assert.equal(isBusyRefusal(new MigrationFileError(file, databaseError('57014', message))), false);
  }
});
