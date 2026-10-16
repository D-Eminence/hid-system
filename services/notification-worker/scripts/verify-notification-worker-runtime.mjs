#!/usr/bin/env node
// ADR-064 (0095): the notification worker's Novu subscriber email sync,
// through the real NotificationWorker, NotificationRepository and
// NovuOrchestrator, with every database connection starting as
// hid_notification_worker on a disposable copy of the owned synthetic
// rehearsal. Novu is a local fake that keeps each subscriber's email as Novu's
// documented API does: POST /v2/subscribers creates or updates, PATCH
// /v2/subscribers/{id} with a null email clears it, and a trigger whose `to`
// carries the subscriber's fields updates them first. Each trigger records the
// email the subscriber had when it arrived, so the checks can say whether a
// trigger could have emailed. SQS is a stub that records acknowledgements.
// Every patient, login and address is synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { disposableDatabase, fakeService } from '../../../scripts/service-runtime-harness.mjs';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const RUNTIME_ROLE = 'hid_notification_worker';
const evidence = { runAs: RUNTIME_ROLE, database: 'disposable copy of hid_rehearsal', checks: [] };
const check = (name) => evidence.checks.push(name);
const id = () => randomUUID();
const GENERIC = 'You have a new update in HID. Sign in securely to view it.';

// Synthetic patients: V verified and opted in; P phone-only (0093/0094); D a
// deleted login with a verified email; O verified, later opted out.
const patients = {
  V: { account: id(), patient: id(), email: `verifier-v-${id().slice(0, 8)}@example.invalid`, status: 'active' },
  P: { account: id(), patient: id(), email: null, status: 'active' },
  D: { account: id(), patient: id(), email: `verifier-d-${id().slice(0, 8)}@example.invalid`, status: 'deleted' },
  O: { account: id(), patient: id(), email: `verifier-o-${id().slice(0, 8)}@example.invalid`, status: 'active' },
};
const hidCodes = { V: 'HID-NVRFVA', P: 'HID-NVRFPB', D: 'HID-NVRFDC', O: 'HID-NVRFQD' };
const facility = id();
const events = {};
const event = (name, label, type = 'PatientRegistered') => {
  const grant = id();
  events[name] = { label, type, id: id(), grant, correlationId: `notification-verifier-${name.toLowerCase()}-${id().slice(0, 8)}` };
  return events[name];
};
for (const [name, label] of [['V1', 'V'], ['V2', 'V'], ['V3', 'V'], ['V4', 'V'], ['P1', 'P'], ['D1', 'D'], ['O1', 'O']]) event(name, label);
event('O2', 'O', 'PatientAccessPinVerified');
event('O3', 'O', 'EmergencyAccessActivated');
const safety = (type) => type === 'PatientAccessPinVerified' || type === 'EmergencyAccessActivated';

// The fake Novu: subscribers by id, every call, and the email each trigger met.
const subscribers = new Map();
const fail = { subscriber: null, clear: null };
const triggers = [];
let transaction = 0;
const novu = await fakeService(({ method, path, body }) => {
  if (method === 'POST' && path === '/v2/subscribers') {
    if (fail.subscriber) return [fail.subscriber, { statusCode: fail.subscriber }];
    subscribers.set(body.subscriberId, { ...subscribers.get(body.subscriberId), email: body.email ?? null });
    return [201, { data: { subscriberId: body.subscriberId } }];
  }
  const patch = /^\/v2\/subscribers\/([0-9a-f-]{36})$/.exec(path);
  if (method === 'PATCH' && patch) {
    if (fail.clear) return [fail.clear, { statusCode: fail.clear }];
    if (!subscribers.has(patch[1])) return [404, { statusCode: 404 }];
    subscribers.set(patch[1], { ...subscribers.get(patch[1]), ...body });
    return [200, { data: { subscriberId: patch[1] } }];
  }
  if (method === 'POST' && path === '/v1/events/trigger') {
    const to = typeof body.to === 'string' ? { subscriberId: body.to } : body.to;
    const current = subscribers.get(to.subscriberId) ?? { email: null };
    const updated = { ...current, ...('email' in to ? { email: to.email } : {}) };
    subscribers.set(to.subscriberId, updated);
    triggers.push({ body, emailAtTrigger: updated.email ?? null });
    transaction += 1;
    return [201, { data: { transactionId: `novu-fake-${transaction}` } }];
  }
  return [404, { statusCode: 404 }];
});
const database = await disposableDatabase(require, 'notification');
const workers = [];
try {
  await database.fixture(async (client) => {
    for (const [label, row] of Object.entries(patients)) {
      await client.query(`insert into auth.accounts (id, subject, email, status, email_verified_at)
        values ($1, $2, $3, $4, case when $3::text is null then null else clock_timestamp() end)`,
      [row.account, `synthetic:notification-verifier:${row.account}`, row.email, row.status]);
      await client.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name)
        values ($1, $2, $3, 'Synthetic', $4, $5)`,
      [row.patient, row.account, hidCodes[label], `Verifier${label}`, `Synthetic Verifier${label}`]);
    }
    for (const value of Object.values(events)) {
      await client.query(`insert into identity.outbox_events (event_id, event_type, aggregate_id, aggregate_version,
          facility_id, patient_id, correlation_id, payload)
        values ($1, $2, $3, 1, $4, $5, $6, $7)`,
      [value.id, value.type, value.grant, facility, patients[value.label].patient, value.correlationId,
        safety(value.type) ? { consentGrantId: value.grant, reviewRequired: true } : {}]);
    }
  });

  require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
  const { readConfig } = require(join(service, 'src/config.ts'));
  const { NotificationRepository } = require(join(service, 'src/repository.ts'));
  const { NovuOrchestrator } = require(join(service, 'src/novu.orchestrator.ts'));
  const { NotificationWorker } = require(join(service, 'src/worker.ts'));
  const acknowledged = [];
  const sqs = { send: async (command) => { acknowledged.push(command.input.ReceiptHandle); return {}; } };
  const start = async (sync) => {
    const config = readConfig({ NODE_ENV: 'test', HID_DEPLOYMENT_ENV: 'development', NOTIFICATION_WORKER_ENABLED: 'true',
      NOTIFICATION_WORKER_ID: `notification-verifier-${sync}`, NOTIFICATION_WORKER_DATABASE_URL: database.url(RUNTIME_ROLE),
      NOTIFICATION_WORKER_QUEUE_URL: 'https://sqs.example.invalid/000000000000/hid-verifier-notifications',
      NOVU_MODE: 'live', NOVU_API_URL: novu.url, NOVU_API_KEY: 'example-novu-verifier-key',
      NOVU_SUBSCRIBER_SYNC: sync });
    const repository = new NotificationRepository(config);
    if (sync === 'email') await repository.verifySubscriberSyncPrivilege();
    const worker = new NotificationWorker(config, repository, new NovuOrchestrator(config), sqs);
    workers.push(repository);
    return worker;
  };
  // Everything the worker writes to stdout and stderr while it handles a message.
  const output = [];
  const handle = async (worker, name) => {
    const value = events[name];
    const envelope = { schema: 'ng.hid.event-envelope', schemaVersion: 1, id: value.id, type: value.type, version: 1,
      occurredAt: new Date().toISOString(), producer: 'identity', correlationId: value.correlationId,
      context: { facilityId: facility, patientId: patients[value.label].patient },
      payload: safety(value.type) ? { consentGrantId: value.grant, reviewRequired: true } : {} };
    const writes = { stdout: process.stdout.write, stderr: process.stderr.write };
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { output.push(String(chunk)); return true; };
    try {
      await worker.process({ Body: JSON.stringify({ detail: envelope }), ReceiptHandle: `receipt-${name}` });
    } finally {
      process.stdout.write = writes.stdout;
      process.stderr.write = writes.stderr;
    }
  };
  const callsFrom = (count) => novu.calls.slice(count).map(({ method, path }) => `${method} ${path.replace(/[0-9a-f-]{36}/, ':id')}`);
  const inbox = async (name) => (await database.owner.query(`select status, attempt_count from integration.inbox_messages
    where consumer_name = 'notification-worker-v1' and event_id = $1`, [events[name].id])).rows[0];
  const attempts = async (name) => (await database.owner.query(`select workflow_id, channel, outcome from notification.delivery_attempts
    where event_id = $1 order by workflow_id`, [events[name].id])).rows.map((row) => `${row.workflow_id}:${row.channel}:${row.outcome}`);
  const outcomes = () => output.map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((line) => line?.event === 'notification.worker.outcome');

  // 1. Flag off (the default): exactly main.
  const off = await start('disabled');
  let seen = novu.calls.length;
  await handle(off, 'V1');
  assert.deepEqual(callsFrom(seen), ['POST /v1/events/trigger'], 'flag off made a call other than main\'s trigger');
  assert.deepEqual(novu.calls.at(-1).body, { name: 'identity-registration-update-v1', to: { subscriberId: patients.V.patient },
    payload: { message: GENERIC } });
  assert.equal(novu.calls.at(-1).headers['idempotency-key'], events.V1.id);
  assert.deepEqual(await inbox('V1'), { status: 'processed', attempt_count: 1 });
  assert.deepEqual(await attempts('V1'), ['identity-registration-update-v1:in_app:accepted']);
  assert.deepEqual(output, [], 'flag off wrote to stdout or stderr');
  check('flag off: one trigger with main\'s body and key, no recipient lookup, no subscriber call, no output line');

  // 2. Flag email, a verified login email.
  const sync = await start('email');
  check('flag email: the worker may execute integration.notification_recipient_for_claim (startup check)');
  seen = novu.calls.length;
  await handle(sync, 'V2');
  assert.deepEqual(callsFrom(seen), ['POST /v2/subscribers', 'POST /v1/events/trigger']);
  assert.deepEqual(novu.calls[seen].body, { subscriberId: patients.V.patient, email: patients.V.email });
  assert.match(novu.calls[seen].headers['idempotency-key'], /^[0-9a-f]{64}$/);
  assert.deepEqual(novu.calls[seen + 1].body, { name: 'identity-registration-update-v1', to: { subscriberId: patients.V.patient },
    payload: { message: GENERIC } });
  assert.equal(triggers.at(-1).emailAtTrigger, patients.V.email);
  assert.deepEqual(await inbox('V2'), { status: 'processed', attempt_count: 1 });
  assert.deepEqual(await attempts('V2'), ['identity-registration-update-v1:in_app:accepted', 'novu-subscriber-email-v1:email:accepted']);
  check('flag email: the subscriber gets exactly {subscriberId, email}, then main\'s trigger; processed, with a PHI-free disclosure row');

  // 3. A phone-only patient: nothing to sync, the in-app trigger as main sends it.
  seen = novu.calls.length;
  await handle(sync, 'P1');
  assert.deepEqual(callsFrom(seen), ['PATCH /v2/subscribers/:id', 'POST /v1/events/trigger']);
  assert.deepEqual(novu.calls[seen].body, { email: null });
  assert.deepEqual(novu.calls[seen + 1].body.to, { subscriberId: patients.P.patient });
  assert.equal(triggers.at(-1).emailAtTrigger, null);
  assert.deepEqual(await inbox('P1'), { status: 'processed', attempt_count: 1 });
  check('phone-only patient: no sync, main\'s in-app trigger, processed and never failed_terminal');

  // 4. A deleted login keeps main's in-app trigger, and Novu holds no email for it.
  subscribers.set(patients.D.patient, { email: patients.D.email });
  seen = novu.calls.length;
  await handle(sync, 'D1');
  assert.deepEqual(callsFrom(seen), ['PATCH /v2/subscribers/:id', 'POST /v1/events/trigger']);
  assert.equal(triggers.at(-1).emailAtTrigger, null, 'a deleted login\'s trigger met a stored email');
  assert.equal(subscribers.get(patients.D.patient).email, null);
  assert.deepEqual(await inbox('D1'), { status: 'processed', attempt_count: 1 });
  assert.equal(novu.calls.slice(seen).some(({ path }) => path === '/v2/subscribers'), false);
  check('deleted login with an email synced earlier: the email is cleared before the in-app trigger; nothing is synced');

  // 5. Opted in, synced; then opted out: a safety notice still goes in-app and
  // the trigger meets no email.
  await handle(sync, 'O1');
  assert.equal(subscribers.get(patients.O.patient).email, patients.O.email);
  await database.owner.query('update identity.patients set notifications_enabled = false where id = $1', [patients.O.patient]);
  seen = novu.calls.length;
  await handle(sync, 'O2');
  assert.deepEqual(callsFrom(seen), ['PATCH /v2/subscribers/:id', 'POST /v1/events/trigger']);
  assert.deepEqual(novu.calls[seen + 1].body, { name: 'patient-update-v1', to: { subscriberId: patients.O.patient },
    payload: { message: GENERIC } });
  assert.equal(triggers.at(-1).emailAtTrigger, null, 'an opted-out patient\'s trigger met the email synced earlier');
  assert.deepEqual(await inbox('O2'), { status: 'processed', attempt_count: 1 });
  check('opted out after an earlier sync: the email is cleared before the PIN-use trigger, which still goes in-app');

  // 6. The clear fails: the trigger that clears the email itself goes instead.
  subscribers.set(patients.O.patient, { email: patients.O.email });
  fail.clear = 503;
  seen = novu.calls.length;
  await handle(sync, 'O3');
  fail.clear = null;
  assert.deepEqual(callsFrom(seen), ['PATCH /v2/subscribers/:id', 'POST /v1/events/trigger']);
  assert.deepEqual(novu.calls[seen + 1].body, { name: 'patient-update-v1', to: { subscriberId: patients.O.patient, email: null },
    payload: { message: GENERIC } });
  assert.notEqual(novu.calls[seen + 1].headers['idempotency-key'], events.O3.id);
  assert.equal(triggers.at(-1).emailAtTrigger, null);
  assert.deepEqual(await inbox('O3'), { status: 'processed', attempt_count: 1 });
  assert.deepEqual(await attempts('O3'), ['novu-subscriber-email-clear-v1:email:unknown', 'patient-update-v1:in_app:accepted']);
  check('clear answered 503: the emergency notice still goes in-app, by the trigger that clears the email in the same request');

  // 7. Novu's subscriber API answers 503 on every call: in-app is never lost.
  fail.subscriber = 503;
  seen = novu.calls.length;
  await handle(sync, 'V3');
  assert.deepEqual(callsFrom(seen), ['POST /v2/subscribers', 'POST /v1/events/trigger']);
  assert.deepEqual(novu.calls[seen + 1].body.to, { subscriberId: patients.V.patient });
  assert.deepEqual(await inbox('V3'), { status: 'processed', attempt_count: 1 });
  assert.equal(acknowledged.includes('receipt-V3'), true);
  // 8. A rejected sync (422) still triggers.
  fail.subscriber = 422;
  await handle(sync, 'V4');
  fail.subscriber = null;
  assert.deepEqual(await inbox('V4'), { status: 'processed', attempt_count: 1 });
  assert.equal(triggers.at(-1).body.to.subscriberId, patients.V.patient);
  assert.equal((await database.owner.query(`select count(*)::int as count from integration.inbox_messages
    where consumer_name = 'notification-worker-v1' and status <> 'processed' and event_id = any($1::uuid[])`,
  [Object.values(events).map((value) => value.id)])).rows[0].count, 0);
  check('subscriber API 503 or 422: main\'s trigger still goes and the event is processed, never retried or terminal');

  // 9. Output and stored rows hold no email, patient or event id.
  const lines = outcomes();
  assert.equal(lines.length, 8, `expected one outcome line per flag-email event, got ${lines.length}`);
  assert.deepEqual(lines.map((line) => `${line.recipient}/${line.subscriber}/${line.trigger}/${line.inbox}`), [
    'email/synced/standard/processed', 'withhold/cleared/standard/processed', 'withhold/cleared/standard/processed',
    'email/synced/standard/processed', 'withhold/cleared/standard/processed', 'withhold/clear_failed/email_withheld/processed',
    'email/sync_failed/standard/processed', 'email/sync_failed/standard/processed']);
  const text = output.join('');
  for (const secret of [...Object.values(patients).flatMap((row) => [row.patient, row.account, row.email].filter(Boolean)),
    ...Object.values(events).map((value) => value.id)]) {
    assert.equal(text.includes(secret), false, 'the worker wrote an identifier or an address');
  }
  assert.equal((await database.owner.query(`select count(*)::int as count from notification.delivery_attempts
    where to_jsonb(delivery_attempts)::text like '%example.invalid%'`)).rows[0].count, 0);
  check('one PHI-free notification.worker.outcome line per flag-email event; no address, patient, login or event id in output or rows');
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence })}\n`);
} finally {
  for (const repository of workers) await repository.close().catch(() => undefined);
  await database.close();
  await novu.close();
}
