import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('0152\'s two busy refusals, read from the file, are ones the dry run retries', async () => {
  const file = '0152_prescription_refills.sql';
  const sql = await readFile(path.join(scripts, '../database/migrations', file), 'utf8');
  // Each 55P03 the file raises: the SQL string literals joined by || after "message =".
  const messages = [];
  for (const raised of sql.split("errcode = '55P03',").slice(1)) {
    const literals = /^\s*message\s*=\s*((?:'(?:[^']|'')*'\s*(?:\|\|\s*)?)+)/.exec(raised);
    assert.ok(literals, `a 55P03 in ${file} has no literal message`);
    messages.push([...literals[1].matchAll(/'((?:[^']|'')*)'/g)].map((part) => part[1].replaceAll("''", "'")).join(''));
  }
  const tables = 'pharmacy.dispensings, ehr.prescriptions, pharmacy.work_items or ehr.order_routes';
  assert.deepEqual(messages, [
    `0152: ${tables} is busy, and this transaction already holds an earlier migration's locks, so it does not wait; `
      + `nothing applied; ${tail}`,
    `0152: ${tables} stayed busy for 5 seconds; nothing applied; ${tail}`,
  ]);
  for (const message of messages) {
    assert.equal(isBusyRefusal(new MigrationFileError(file, databaseError('55P03', message))), true, message);
    // Under another file's name, or another SQLSTATE, it is not this file's busy refusal.
    assert.equal(isBusyRefusal(new MigrationFileError('0151_recent_diagnoses.sql', databaseError('55P03', message))), false);
    assert.equal(isBusyRefusal(new MigrationFileError(file, databaseError('57014', message))), false);
  }
});
