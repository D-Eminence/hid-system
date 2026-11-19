#!/usr/bin/env node
// QoreID NIN checks asked once per NIN (0137, Q109), run against a disposable local PostgreSQL only, as a login role
// that is a member of the Identity API runtime (hid_identity_api_runtime): the real NinCheckOnce, the real 0137 commands
// and grants, separate connection pools (as separate Identity tasks), and a fake QoreID in this process that counts the
// checks it is asked for. Proves: two and ten simultaneous checks of one NIN ask once; checks of different NINs do not
// wait for each other; no database connection is held while QoreID answers; a timeout holds the NIN; the audit rows
// carry no NIN or lookup HMAC; an answer that arrives after the caller stopped waiting is kept and reused; the
// sweeper's prune erases expired rows. Fictional values only; nothing leaves the
// machine. Usage: NODE_ENV=test DATABASE_URL=postgresql://<runtime login>@127.0.0.1:<port>/<db>
//   DATABASE_ADMIN_URL=postgresql://<owner>@127.0.0.1:<port>/<db> node scripts/verify-nin-check-once-runtime.mjs
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL']) {
  const url = new URL(process.env[name] ?? 'missing://');
  assert(process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname),
    `${name} must name a disposable local database (NODE_ENV=test)`);
}
Object.assign(process.env, {
  DATABASE_SSL: 'false', CORS_ORIGINS: 'https://app.nin-once.invalid', AUTH_MODE: 'local',
  // Session keys for this run only, never written anywhere (as verify-outreach-organisers-runtime does).
  AUTH_SIGNING_SECRET: randomBytes(32).toString('base64url'), AUTH_LOGIN_PEPPER: randomBytes(32).toString('base64url'),
  NIN_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
  NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 8).toString('base64'), NIN_KEY_VERSION: 'synthetic-v1',
  QOREID_TIMEOUT_MS: '1000',
});
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const load = (path) => require(join(service, 'src', path));
const { Pool } = require('pg');
const { DatabaseService } = load('database/database.service.ts');
const { AuditService } = load('audit/audit.service.ts');
const { DomainProblem } = load('common/problem.ts');
const { NinIdentifierProtector } = load('identity/nin-identifier-protector.ts');
const { NinCheckOnce, NIN_RECORD_ANSWER_SECONDS } = load('identity/nin-check-once.ts');

const admin = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
const protector = new NinIdentifierProtector();
const tasks = Array.from({ length: 3 }, () => {
  const database = new DatabaseService();
  return { database, check: new NinCheckOnce(database, protector, new AuditService(database)) };
});
const record = (nin) => ({ outcome: 'record', providerReference: '9001',
  record: { complete: true, binding: { nin, firstName: 'Synthetic', lastName: 'Person', dateOfBirth: '1990-01-01',
    gender: 'female' } } });
const nins = Array.from({ length: 9 }, (_, index) => `7999999${String(index).padStart(4, '0')}`);
const lookups = nins.map((nin) => protector.lookup(nin));
const qoreId = { asked: new Map() };
const inUse = () => tasks.reduce((sum, task) => sum + task.database.pool.totalCount - task.database.pool.idleCount, 0);
const ask = (nin, delayMs = 300, failure, onAsk) => async () => {
  qoreId.asked.set(nin, (qoreId.asked.get(nin) ?? 0) + 1);
  onAsk?.();
  await new Promise((done) => setTimeout(done, delayMs));
  if (failure) throw failure;
  return { answer: record(nin), value: 'fresh' };
};
// audit.events is append-only: each run's rows carry its own correlation prefix.
const run = `nin-once-runtime-${randomUUID().slice(0, 8)}`;
const request = (task, nin, extra = {}) => tasks[task].check.check({ nin, correlationId: `${run}-${task}`,
  path: 'enrollment', needsCompleteRecord: true, ask: ask(nin), ...extra });

await admin.query('delete from identity.qoreid_nin_checks where nin_lookup_hmac = any($1)', [lookups]);
const results = [];
try {
  // 0. A check alone: no database connection of any task is in use while QoreID answers.
  const seen = [];
  await request(2, nins[6], { ask: ask(nins[6], 100, undefined, () => seen.push(inUse())) });
  assert.deepEqual(seen, [0], 'a database connection is held while QoreID answers');
  results.push('no database connection held while QoreID answers');

  // 1. Two simultaneous checks of one NIN from two tasks: QoreID is asked once.
  const pair = await Promise.all([request(0, nins[0]), request(1, nins[0])]);
  assert.equal(qoreId.asked.get(nins[0]), 1);
  assert.deepEqual(pair.map((result) => result.source).sort(), ['qoreid', 'stored']);
  assert.deepEqual(pair[0].answer, pair[1].answer);
  results.push('two simultaneous checks: 1 QoreID call');

  // 2. Ten at once across three tasks.
  const ten = await Promise.all(Array.from({ length: 10 }, (_, index) => request(index % 3, nins[1])));
  assert.equal(qoreId.asked.get(nins[1]), 1);
  assert.equal(ten.filter((result) => result.source === 'qoreid').length, 1);
  results.push('ten simultaneous checks: 1 QoreID call');

  // 3. Four different NINs at once do not wait for each other (no lock beyond the NIN's own row).
  const started = Date.now();
  await Promise.all(nins.slice(2, 6).map((nin, index) => request(index % 3, nin)));
  const elapsed = Date.now() - started;
  assert(elapsed < 1200, `different NINs waited for each other (${elapsed} ms)`);
  for (const nin of nins.slice(2, 6)) assert.equal(qoreId.asked.get(nin), 1);
  results.push(`four different NINs at once: 4 calls in ${elapsed} ms`);

  // 4. No answer by the ceiling holds the NIN for hours: the next check is told when to try again, QoreID is not asked.
  const timeout = new DomainProblem(504, 'QOREID_TIMEOUT', 'External verification timed out');
  await assert.rejects(request(0, nins[7], { ask: ask(nins[7], 10, timeout) }), { code: 'QOREID_TIMEOUT' });
  await assert.rejects(request(1, nins[7]), { code: 'NIN_CHECK_HELD', status: 409,
    message: 'We could not finish checking this NIN. Please try again in 6 hours.' });
  assert.equal(qoreId.asked.get(nins[7]), 1);
  results.push('no answer then resubmit: 1 QoreID call, held 6 hours with a plain message');

  // 4b. An answer slower than the caller's wait (QOREID_TIMEOUT_MS 1000) is still read, kept, and reused by
  // another task's retry: the 28 October case.
  await assert.rejects(request(0, nins[8], { ask: ask(nins[8], 1500) }), { code: 'QOREID_TIMEOUT', status: 504 });
  await tasks[0].check.settle();
  const retried = await request(1, nins[8]);
  assert.equal(retried.source, 'stored');
  assert.equal(qoreId.asked.get(nins[8]), 1);
  results.push('late answer kept: the retry reused it, 1 QoreID call');

  // 5. What is stored: encrypted, keyed by the lookup HMAC, never the NIN.
  const rows = (await admin.query(
    `select nin_lookup_hmac, state, outcome, encode(answer_ciphertext, 'escape') as ciphertext, key_version,
            until - updated_at as kept
       from identity.qoreid_nin_checks where nin_lookup_hmac = any($1) order by nin_lookup_hmac`, [lookups])).rows;
  assert.equal(rows.length, 9);
  for (const row of rows) {
    assert(lookups.includes(row.nin_lookup_hmac));
    assert(!nins.some((nin) => JSON.stringify(row).includes(nin)), 'a NIN is stored');
    assert(!JSON.stringify(row).includes('Synthetic'), 'a record is stored in clear');
  }
  assert.equal(rows.filter((row) => row.state === 'answered' && row.outcome === 'record').length, 8);
  results.push('stored: 8 encrypted records and 1 hold, keyed by lookup HMAC only');

  // 5b. Q110: the keep of a matched record, through the runtime role: kept 90 days from now (a record first kept a
  // day here), its answer and source unchanged; nothing for a held NIN.
  await admin.query(`update identity.qoreid_nin_checks set until = clock_timestamp() + interval '1 day'
                      where nin_lookup_hmac = $1`, [lookups[5]]);
  const before = (await admin.query(`select answer_ciphertext, record_source from identity.qoreid_nin_checks
                                       where nin_lookup_hmac = $1`, [lookups[5]])).rows[0];
  assert.equal(before.record_source, 'nin_only');
  assert.equal(await tasks[1].check.keepRecord(nins[5], `${run}-keep`), true);
  assert.equal(await tasks[1].check.keepRecord(nins[7], `${run}-keep-held`), false);
  const after = (await admin.query(`select answer_ciphertext, record_source,
                                           until > clock_timestamp() + interval '89 days 23 hours' as kept
                                      from identity.qoreid_nin_checks where nin_lookup_hmac = $1`, [lookups[5]])).rows[0];
  assert(after.kept && after.record_source === 'nin_only' && after.answer_ciphertext.equals(before.answer_ciphertext));
  results.push('keep: a matched record kept 90 days from now, unchanged; a held NIN not kept');

  // 6. The audit: one row per attempt, QoreID called or not, without NIN or lookup HMAC.
  const audits = (await admin.query(
    `select details from audit.events where action = 'identity.qoreid.nin-check'
        and correlation_id like $1`, [`${run}-%`])).rows;
  // Step 4b: the call's timeout, its late answer, and the retry's stored answer.
  assert.equal(audits.length, 1 + 2 + 10 + 4 + 2 + 3);
  assert.equal(audits.filter((row) => row.details.qoreidCalled === true).length, 1 + 1 + 1 + 4 + 1 + 1);
  assert.equal(audits.filter((row) => row.details.source === 'late').length, 1);
  for (const row of audits) {
    const text = JSON.stringify(row.details);
    assert(!nins.some((nin) => text.includes(nin)) && !lookups.some((lookup) => text.includes(lookup)));
  }
  results.push(`audit: ${audits.length} rows, ${audits.filter((row) => row.details.qoreidCalled).length} with a QoreID call`);

  // 7. Expiry: the sweeper's prune erases what has passed its end (simulated by moving `until` back).
  await admin.query(`update identity.qoreid_nin_checks set until = clock_timestamp() - interval '1 second'
                      where nin_lookup_hmac = any($1)`, [lookups.slice(0, 4)]);
  const removed = await tasks[2].check.prune(`${run}-prune`, 1000);
  assert(removed >= 4);
  const left = (await admin.query('select count(*)::int as n from identity.qoreid_nin_checks where nin_lookup_hmac = any($1)',
    [lookups])).rows[0].n;
  assert.equal(left, 5);
  results.push(`prune: ${removed} expired rows erased, live answers kept`);
  assert(NIN_RECORD_ANSWER_SECONDS === 90 * 24 * 3600); // Q110: a matched answer not yet on a Health ID is kept 90 days
} finally {
  await admin.query('delete from identity.qoreid_nin_checks where nin_lookup_hmac = any($1)', [lookups]);
  await admin.end();
  for (const task of tasks) await task.database.onApplicationShutdown();
}
process.stdout.write(`${JSON.stringify({ status: 'passed', results })}\n`);
