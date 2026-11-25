#!/usr/bin/env node
// BILL-1 (0162-0167): each migration's own mechanics, and the two things a
// rolled-back SQL suite cannot show (two sessions at once). Runs only against
// a disposable local PostgreSQL cluster reached by a Unix socket under /tmp or
// /var/tmp, with fictional data, from a template database at the live schema
// (0001-0153 since backend release E; the files need 0001-0151) built by
// the release's runner as a NOSUPERUSER NOBYPASSRLS owner:
//
//   HID_BILLING_MECHANICS_LOCAL_CLUSTER=socket PGHOST=/var/tmp/... PGPORT=... PGUSER=<superuser> \
//   HID_BILLING_MECHANICS_TEMPLATE=<db at the live schema> HID_BILLING_MECHANICS_OWNER=<its owner> \
//   node services/ehr-api/scripts/test-patient-billing-migrations.mjs
//
// Checked, for each of 0162-0167:
//   1. preconditions: on the live schema alone (without the earlier BILL-1 files), each
//      of 0163-0167 refuses 55000 with a message that begins with its number,
//      and nothing is applied;
//   1b. other release lanes first: with another lane's code on shared roles
//      and its trigger on ehr.visit_queue, all six apply and keep them; with
//      a code 0001-0151 gave a role gone 0162 refuses, and with a trigger
//      Release C gave a table gone 0167 refuses;
//   2. locks first, NOWAIT: with a second session holding a table the file
//      locks, the file refuses 55P03 with a message that begins with its
//      number, and nothing is applied;
//   3. applied, then applied again: "016n: already applied" (55000), nothing
//      changed.
// Then, on the database with all six:
//   4. two sessions paying the same bill at once never overpay: the second
//      waits for the first's lock and answers OVERPAYMENT;
//   5. bill and receipt numbers from four sessions at once have no gaps and no
//      repeats, and a new year starts its receipts at 1;
//   6. a payment taken while its day is being closed waits for the close and
//      is refused TILL_DAY_NOT_OPEN, so the closed day's expected cash counts
//      every payment recorded in it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const { Client } = require('pg');

const host = process.env.PGHOST ?? '';
assert(process.env.HID_BILLING_MECHANICS_LOCAL_CLUSTER === 'socket' && /^\/(var\/)?tmp\//.test(host),
  'Only a disposable local cluster on a Unix socket under /tmp or /var/tmp is supported');
const template = process.env.HID_BILLING_MECHANICS_TEMPLATE ?? '';
const owner = process.env.HID_BILLING_MECHANICS_OWNER ?? '';
assert(/^[a-z][a-z0-9_]{0,40}$/.test(template) && /^[a-z][a-z0-9_]{0,40}$/.test(owner), 'Name the template and its owner');
const migrations = join(service, 'database/migrations');
const files = ['0162_billing_roles_and_codes.sql', '0163_billing_settings_and_price_list.sql',
  '0164_bills_payments_and_hmo_cover.sql', '0165_till_days_and_end_of_day.sql',
  '0166_pharmacy_point_of_care_stock.sql', '0167_billing_and_stock_hooks.sql'];
// A table each file locks first, which a second session holds to make it busy.
const busyTable = { '0162': 'auth.roles', '0163': 'identity.facilities', '0164': 'ehr.visit_queue',
  '0165': 'commercial.payments', '0166': 'commercial.catalogue_items', '0167': 'pharmacy.dispensings' };
const results = {};

const client = async (database, role) => {
  const connection = new Client({ host, port: Number(process.env.PGPORT ?? 5432), database,
    user: role ?? process.env.PGUSER });
  await connection.connect();
  return connection;
};
async function withAdmin(work) {
  const admin = await client('postgres');
  try { return await work(admin); } finally { await admin.end(); }
}
const copy = (name) => withAdmin(async (admin) => {
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name} template ${template} owner ${owner}`);
});
const drop = (name) => withAdmin((admin) => admin.query(`drop database if exists ${name}`));

/** Applies one file as the owner with psql; answers [status, sqlstate, message of the last error]. */
function apply(database, file) {
  const run = spawnSync('psql', ['-X', '-q', '-U', owner, '-d', database, '-v', 'ON_ERROR_STOP=1',
    '-v', 'VERBOSITY=verbose', '-f', join(migrations, file)], { encoding: 'utf8', env: process.env, timeout: 120_000 });
  const error = [...(run.stderr ?? '').matchAll(/ERROR:\s+([0-9A-Z]{5}):\s+(.*)/g)].at(-1);
  return [run.status, error?.[1] ?? null, error?.[2] ?? null];
}
const applied = async (database, file) => {
  const connection = await client(database);
  try {
    return (await connection.query('select count(*)::int as n from migration.schema_migrations where version = $1',
      [file])).rows[0].n === 1 || (await connection.query(
      "select (to_regnamespace('commercial') is not null and $1 = '0162') as made", [file.slice(0, 4)])).rows[0].made;
  } finally { await connection.end(); }
};

// 1. Preconditions on the live schema alone.
await copy('hid_bill_pre');
for (const file of files.slice(1)) {
  const number = file.slice(0, 4);
  const [status, sqlstate, message] = apply('hid_bill_pre', file);
  assert.notEqual(status, 0, `${number} applied on the live schema alone`);
  assert.equal(sqlstate, '55000', `${number} precondition: ${sqlstate} ${message}`);
  assert(message.startsWith(`${number}: `), `${number} precondition message: ${message}`);
  results[`${number}_precondition`] = message;
}
await drop('hid_bill_pre');

// 1b. Other release lanes first (coordinator, #258, 25 November 2026: wave 1 releases in order of readiness). A
// code another lane gave the shared roles and a trigger another lane put on ehr.visit_queue are accepted; a code
// 0001-0151 gave a role, or a trigger Release C gave a table, that is gone is refused (fictional names).
const asOwner = async (database, sql) => {
  const connection = await client(database);
  try {
    await connection.query('begin');
    await connection.query('set local session_replication_role = replica');
    await connection.query(sql);
    await connection.query('commit');
  } finally { await connection.end(); }
};
await copy('hid_bill_lanes');
await asOwner('hid_bill_lanes', `
  insert into auth.permissions (code, description) values ('ehr.other-lane.read', 'Another lane''s code (fictional)');
  insert into auth.role_permissions (role_code, permission_code) values ('receptionist', 'ehr.other-lane.read'),
    ('doctor', 'ehr.other-lane.read'), ('admin', 'ehr.other-lane.read'), ('pharmacist', 'ehr.other-lane.read');
  create function ehr.other_lane_mirror() returns trigger language plpgsql set search_path = pg_catalog, pg_temp
    as $f$ begin return null; end $f$;
  create trigger other_lane_mirror after update on ehr.visit_queue for each row
    execute function ehr.other_lane_mirror();`);
for (const file of files) {
  const [status, , failure] = apply('hid_bill_lanes', file);
  assert.equal(status, 0, `${file.slice(0, 4)} refused another lane's code or trigger: ${failure}`);
}
const kept = await client('hid_bill_lanes');
assert.equal((await kept.query(`select count(*)::int as n from auth.role_permissions
  where permission_code = 'ehr.other-lane.read'`)).rows[0].n, 4, 'another lane\'s rows are kept');
await kept.end();
await drop('hid_bill_lanes');
results.other_lanes_first = 'applied with another lane\'s code on four shared roles and its trigger on ehr.visit_queue';
await copy('hid_bill_lost');
await asOwner('hid_bill_lost', `delete from auth.role_permissions
  where role_code = 'receptionist' and permission_code = 'identity.registration.write'`);
{
  const [status, sqlstate, message] = apply('hid_bill_lost', files[0]);
  assert.notEqual(status, 0, '0162 applied with a receptionist code of 0001-0151 gone');
  assert.deepEqual([sqlstate, message],
    ['55000', '0162: these roles are inactive or lack a code 0001-0151 gave them: receptionist']);
  results.code_gone = message;
}
await asOwner('hid_bill_lost', `insert into auth.role_permissions (role_code, permission_code)
  values ('receptionist', 'identity.registration.write')`);
for (const file of files.slice(0, 5)) {
  const [status, , failure] = apply('hid_bill_lost', file);
  assert.equal(status, 0, `${file.slice(0, 4)} did not apply: ${failure}`);
}
await asOwner('hid_bill_lost', 'drop trigger lab_specimens_no_delete on lab.specimens');
{
  const [status, sqlstate, message] = apply('hid_bill_lost', files[5]);
  assert.notEqual(status, 0, '0167 applied with a Release C trigger gone');
  assert.deepEqual([sqlstate, message],
    ['55000', '0167: these tables lack a trigger Release C gives them: lab.specimens; nothing applied']);
  results.trigger_gone = message;
}
await drop('hid_bill_lost');

// 2 and 3. Busy, then applied, then applied again, file by file.
await copy('hid_bill_steps');
for (const file of files) {
  const number = file.slice(0, 4);
  const blocker = await client('hid_bill_steps');
  await blocker.query('begin');
  await blocker.query(`lock table ${busyTable[number]} in access exclusive mode`);
  const started = Date.now();
  const [busyStatus, busyState, busyMessage] = apply('hid_bill_steps', file);
  await blocker.query('rollback');
  await blocker.end();
  assert.notEqual(busyStatus, 0, `${number} applied while ${busyTable[number]} was held`);
  assert.equal(busyState, '55P03', `${number} busy: ${busyState} ${busyMessage}`);
  assert(busyMessage.startsWith(`${number}: `), `${number} busy message: ${busyMessage}`);
  const [status, , failure] = apply('hid_bill_steps', file);
  assert.equal(status, 0, `${number} did not apply: ${failure}`);
  const [againStatus, againState, againMessage] = apply('hid_bill_steps', file);
  assert.notEqual(againStatus, 0);
  assert.deepEqual([againState, againMessage], ['55000', `${number}: already applied`], `${number} re-run`);
  results[`${number}_busy_ms`] = Date.now() - started;
  results[`${number}_rerun`] = againMessage;
}
assert(await applied('hid_bill_steps', files[0]));

// 4, 5 and 6. Two sessions at once, on fictional rows (ids start b1680).
const ids = { org: 'b1680000-0000-4000-8000-000000000001', facility: 'b1680000-0000-4000-8000-000000000002',
  account: 'b1680100-0000-4000-8000-000000000001', staff: 'b1680200-0000-4000-8000-000000000001',
  member: 'b1680300-0000-4000-8000-000000000001', item: 'b1680400-0000-4000-8000-000000000001' };
const setup = await client('hid_bill_steps');
await setup.query('begin');
await setup.query("set local session_replication_role = replica");
await setup.query(`insert into identity.organizations (id, name, slug) values ($1, 'Mechanics Group', 'mechanics-group')`, [ids.org]);
await setup.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
  values ($1, $2, 'Mechanics Clinic', 'MECH-A', 'Africa/Lagos', true, 'verified')`, [ids.facility, ids.org]);
await setup.query(`insert into auth.accounts (id, subject, email, display_name, status)
  values ($1, 'synthetic:mechanics-cashier', 'mechanics-cashier@example.invalid', 'Mechanics Cashier', 'active')`, [ids.account]);
await setup.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
  values ($1, $2, 'Mechanics Cashier', 'mechanics-cashier@example.invalid', 'verified', 'cashier')`, [ids.staff, ids.account]);
await setup.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, 'cashier', 'cashier', true, true)`,
[ids.member, ids.staff, ids.account, ids.org, ids.facility]);
await setup.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
  values (gen_random_uuid(), $1, 'cashier', 'facility', $2, $3, 'Synthetic mechanics role')`, [ids.account, ids.member, ids.facility]);
await setup.query(`insert into commercial.payment_settings (facility_id, updated_by_membership_id, idempotency_key, request_sha256)
  values ($1, $2, 'mechanics-settings-0001', repeat('0', 64))`, [ids.facility, ids.member]);
await setup.query(`insert into commercial.catalogue_items (id, facility_id, kind, name, created_by_membership_id,
  updated_by_membership_id, idempotency_key, request_sha256)
  values ($1, $2, 'other', 'Consultation', $3, $3, 'mechanics-item-000001', repeat('0', 64))`,
[ids.item, ids.facility, ids.member]);
await setup.query(`insert into commercial.catalogue_item_prices (facility_id, catalogue_item_id, amount_kobo)
  values ($1, $2, 1000)`, [ids.facility, ids.item]);
await setup.query('commit');
await setup.end();

const session = async () => {
  const connection = await client('hid_bill_steps');
  return connection;
};
const begin = async (connection) => {
  await connection.query('begin');
  await connection.query('set local role hid_ehr_api_runtime');
  await connection.query(`select set_config('app.actor_subject', 'synthetic:mechanics-cashier', true),
    set_config('app.membership_id', $1, true), set_config('app.facility_id', $2, true),
    set_config('app.correlation_id', 'mechanics-' || gen_random_uuid(), true),
    set_config('app.purpose_of_use', 'healthcare-operations', true)`, [ids.member, ids.facility]);
};
const key = (label) => `mechanics-${label}`.padEnd(20, '0');
const sha = (label) => (Buffer.from(label).toString('hex') + '0'.repeat(64)).slice(0, 64);

// A bill with one line of 1000 kobo, and the cashier's open day.
const first = await session();
await begin(first);
const created = (await first.query(`select commercial.bill_create(jsonb_build_object('source', 'pharmacy',
  'patient', jsonb_build_object('anonymous', true), 'lines', jsonb_build_array(jsonb_build_object('catalogueItemId', $1::text,
  'quantity', 1))), $2, $3) as answer`, [ids.item, key('bill'), sha('bill')])).rows[0].answer;
await first.query(`select commercial.day_open(null, 0, $1, $2)`, [key('day'), sha('day')]);
await first.query('commit');
const billId = created.bill.id;

// 4. Two payments of 600 at once on 1000 due.
const second = await session();
await begin(first);
await begin(second);
const one = await first.query(`select commercial.payment_record($1, '{"method":"cash","amountKobo":600}', null, $2, $3) as answer`,
  [billId, key('pay-one'), sha('pay-one')]);
const pending = second.query(`select commercial.payment_record($1, '{"method":"cash","amountKobo":600}', null, $2, $3) as answer`,
  [billId, key('pay-two'), sha('pay-two')]).then(() => 'paid', (error) => `${error.code} ${error.message}`);
await new Promise((done) => setTimeout(done, 300));
await first.query('commit');
const two = await pending;
await second.query('rollback');
assert.equal(one.rows[0].answer.paidKobo, 600);
assert.equal(two, 'HB409 OVERPAYMENT', 'the second payment must wait for the first and be refused');
results.concurrent_payments = { first: 'paid 600', second: two };

// 6. The cashier closes the day (600 cash taken) while a second session takes 100 more on the same bill.
await begin(first);
const open = (await first.query('select commercial.day_current(null) as answer')).rows[0].answer.shift;
await first.query('select commercial.day_close($1, $2, null, $3, $4, $5)',
  [open.id, Number(open.expectedCashKobo), open.version, key('close'), sha('close')]);
await begin(second);
const closingStarted = Date.now();
const late = second.query(`select commercial.payment_record($1, '{"method":"cash","amountKobo":100}', null, $2, $3) as answer`,
  [billId, key('pay-late'), sha('pay-late')]).then(() => 'paid', (error) => `${error.code} ${error.message}`);
await new Promise((done) => setTimeout(done, 300));
await first.query('commit');
const lateAnswer = await late;
const waited = Date.now() - closingStarted;
await second.query('rollback');
assert.equal(lateAnswer, 'HB409 TILL_DAY_NOT_OPEN', 'a payment must wait for the day close and find no open day');
assert(waited >= 250, `the payment must wait for the day close (${waited} ms)`);
const dayCheck = await client('hid_bill_steps');
await dayCheck.query('begin');
await dayCheck.query("select set_config('app.facility_id', $1, true)", [ids.facility]);
await dayCheck.query(`set local role ${owner}`);
const closed = (await dayCheck.query(`select day_row.expected_cash_kobo::bigint as expected,
  (day_row.opening_cash_kobo + coalesce((select sum(payment.amount_kobo) from commercial.payments payment
     where payment.till_day_id = day_row.id and payment.method = 'cash'), 0))::bigint as counted_in_day,
  (select count(*) from commercial.payments payment where payment.till_day_id = day_row.id
     and payment.received_at > day_row.closed_at)::int as after_close
  from commercial.till_days day_row where day_row.id = $1`, [open.id])).rows[0];
await dayCheck.query('rollback');
await dayCheck.end();
assert.deepEqual([closed.expected, closed.after_close], [closed.counted_in_day, 0],
  'the closed day\'s expected cash counts every payment recorded in it');
results.payment_while_closing = { answer: lateAnswer, waitedMs: waited, expectedCashKobo: Number(closed.expected) };

// 5. Bills from four sessions at once: numbers without gaps or repeats; a new year's receipts start at 1.
const sessions = [first, second, await session(), await session()];
await Promise.all(sessions.map(async (connection, index) => {
  for (let step = 0; step < 5; step += 1) {
    await begin(connection);
    await connection.query(`select commercial.bill_create(jsonb_build_object('source', 'pharmacy',
      'patient', jsonb_build_object('anonymous', true), 'lines', jsonb_build_array(jsonb_build_object('catalogueItemId',
      $1::text, 'quantity', 1))), $2, $3)`, [ids.item, key(`bills-${index}-${step}`), sha(`bills-${index}-${step}`)]);
    await connection.query('commit');
  }
}));
const check = await client('hid_bill_steps');
const numbers = (await check.query(`select number from commercial.bills where facility_id = $1 order by number`,
  [ids.facility])).rows.map((row) => row.number);
assert.deepEqual(numbers, Array.from({ length: 21 }, (_, index) => `B-${String(index + 1).padStart(6, '0')}`));
await check.query('begin');
await check.query("select set_config('app.facility_id', $1, true)", [ids.facility]);
await check.query(`set local role ${owner}`);
const years = (await check.query(`select commercial.next_number($1, 'receipt', 2026) as y2026,
  commercial.next_number($1, 'receipt', 2027) as y2027, commercial.next_number($1, 'receipt', 2027) as y2027b`,
[ids.facility])).rows[0];
await check.query('rollback');
assert.deepEqual([Number(years.y2027), Number(years.y2027b)], [1, 2], 'a new year starts its receipts at 1');
results.bill_numbers = `${numbers[0]}..${numbers.at(-1)} (${numbers.length}, no gaps)`;
for (const connection of [...sessions, check]) await connection.end();
await drop('hid_bill_steps');

process.stdout.write(`${JSON.stringify({ status: 'passed', ...results })}\n`);
