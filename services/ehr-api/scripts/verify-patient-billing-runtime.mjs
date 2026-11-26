#!/usr/bin/env node
// BILL-1 (0162-0167): the patient-billing flow of release 1 as the exact
// runtime roles, on an isolated copy of the database. Every billing command
// runs as hid_ehr_api_runtime and every stock and counter-sale command as
// hid_pharmacy_api_runtime (a session with `-c role=`, as the other runtime
// verifiers connect), each in the context its service's transactions set,
// calling the same database functions with the same arguments as ehr-api's
// CommercialController and pharmacy-api's PharmacyStockController. Owner SQL
// is used only for what no route does: the fictional facility, its staff and
// their roles, and reading what the database holds. All values are synthetic.
//
// It runs only against the owned disposable synthetic rehearsal (PGHOST under
// /tmp/hid-tuf-migration., PGDATABASE hid_rehearsal) or, with
// HID_PATIENT_BILLING_RUNTIME_LOCAL_CLUSTER=socket, a disposable local cluster
// on a Unix socket under /tmp or /var/tmp.
//
// The flow (the contract's verifier list, less the HTTP boot of the services):
// an administrator saves the payment settings; a billing officer prices a
// consultation and a stock-kept medicine; a cashier opens a day, makes a bill
// (and an anonymous walk-in lab bill, which is not a counter sale),
// takes POS and cash; a billing officer voids the cash (the cashier cannot,
// and the officer cannot void what the officer took); an HMO cover is recorded
// (owed, never paid); the pharmacist keeps stock, receives three batches and
// sells at the counter, paid first, handed over expiry-first; the day closes
// with a difference and a note. After every command each bill's totals agree,
// and at the end every batch's on hand equals the sum of its movements.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const { Client } = require('pg');

const host = process.env.PGHOST ?? '';
const rehearsal = host.startsWith('/tmp/hid-tuf-migration.') && process.env.PGDATABASE === 'hid_rehearsal';
const local = process.env.HID_PATIENT_BILLING_RUNTIME_LOCAL_CLUSTER === 'socket' && /^\/(var\/)?tmp\//.test(host)
  && /^[a-z][a-z0-9_]{0,40}$/.test(process.env.PGDATABASE ?? '');
assert(process.env.NODE_ENV === 'test' && (rehearsal || local),
  'Only the owned synthetic rehearsal or an explicitly named local socket cluster is supported');
const source = process.env.PGDATABASE;
const isolated = `${source}_billing_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const port = Number(process.env.PGPORT ?? 5432);
const connect = async (database, role) => {
  const client = new Client({ host, port, database, user: process.env.PGUSER,
    ...(role ? { options: `-c role=${role}` } : {}) });
  await client.connect();
  return client;
};

const admin = await connect('postgres');
await admin.query(`create database ${isolated} template ${source}`);
const steps = [];
try {
  const owner = await connect(isolated);
  // A failure ends this session when the copy is dropped below: keep that from hiding the failure itself.
  owner.on('error', () => undefined);
  const ids = {
    org: 'b1690000-0000-4000-8000-000000000001', facility: 'b1690000-0000-4000-8000-000000000002',
  };
  const members = { admin: 1, officer: 2, cashier: 3, pharmacist: 4, officer2: 5 };
  const roleOf = { 1: 'admin', 2: 'billing_officer', 3: 'cashier', 4: 'pharmacist', 5: 'billing_officer' };
  const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const account = (n) => uuid('b1690100', n);
  const membership = (n) => uuid('b1690300', n);
  // A demo-free, QA-free fictional facility: billing on through COMMERCIAL_BILLING_ENABLED=true, as the routes pass it.
  await owner.query('begin');
  await owner.query('set local session_replication_role = replica');
  await owner.query(`insert into identity.organizations (id, name, slug) values ($1, 'Billing Runtime Group', 'billing-runtime-group')`,
    [ids.org]);
  await owner.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $2, 'Billing Runtime Clinic', 'BILL-RT', 'Africa/Lagos', true, 'verified')`, [ids.facility, ids.org]);
  for (const [n, role] of Object.entries(roleOf)) {
    await owner.query(`insert into auth.accounts (id, subject, email, display_name, status)
      values ($1, $2, $3, $4, 'active')`, [account(n), `synthetic:billing-runtime-${n}`,
      `billing-runtime-${n}@example.invalid`, `Runtime ${role} ${n}`]);
    await owner.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
      values ($1, $2, $3, $4, 'verified', $5)`, [uuid('b1690200', n), account(n), `Runtime ${role} ${n}`,
      `billing-runtime-${n}@example.invalid`, role]);
    await owner.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
      facility_id, membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
    [membership(n), uuid('b1690200', n), account(n), ids.org, ids.facility, role]);
    await owner.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
      grant_reason) values (gen_random_uuid(), $1, $2, 'facility', $3, $4, 'Synthetic billing runtime role')`,
    [account(n), role, membership(n), ids.facility]);
  }
  await owner.query('commit');

  const digest = (label) => createHash('sha256').update(label).digest('hex');
  let counter = 0;
  /** One command as member n under its service's runtime role; the answer, or { refused: code }. */
  const as = async (n, runtime, sql, values, { keyed = true } = {}) => {
    const client = await connect(isolated, runtime);
    try {
      await client.query('begin');
      await client.query(`select set_config('app.actor_subject', $1, true), set_config('app.facility_id', $2, true),
        set_config('app.correlation_id', $3, true), set_config('app.membership_id', $4, true),
        set_config('app.purpose_of_use', 'healthcare-operations', true),
        set_config('hid.billing_source', $5, true)`,
      [`synthetic:billing-runtime-${n}`, ids.facility, `billing-runtime-${randomUUID()}`, membership(n),
        runtime === 'hid_pharmacy_api_runtime' ? 'pharmacy-api' : 'ehr-api']);
      const on = (await client.query('select commercial.billing_switched_on($1) as on', [true])).rows[0].on;
      assert.equal(on, true);
      counter += 1;
      const args = keyed ? [...values, `billing-runtime-key-${counter}`.padEnd(20, '0'), digest(`${counter}`)] : values;
      const answer = (await client.query(sql, args)).rows[0].answer;
      await client.query('commit');
      return answer;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      if (typeof error?.code === 'string' && error.code.startsWith('HB4')) return { refused: error.message };
      throw error;
    } finally {
      await client.end();
    }
  };
  const ehr = (n, sql, values, options) => as(n, 'hid_ehr_api_runtime', sql, values, options);
  const pharmacy = (n, sql, values, options) => as(n, 'hid_pharmacy_api_runtime', sql, values, options);
  const totalsAgree = async () => {
    const { rows } = await owner.query(`select count(*) filter (where not commercial.bill_totals_agree(id))::int as bad
      from commercial.bills where facility_id = $1`, [ids.facility]);
    assert.equal(rows[0].bad, 0, 'every bill\'s totals agree');
  };
  const step = async (name, work) => { await work(); await totalsAgree(); steps.push(name); };

  let settings;
  await step('administrator saves the payment settings', async () => {
    settings = await ehr(members.admin, 'select commercial.settings_put($1, $2, $3, $4, $5, $6) as answer',
      [{ wherePaid: 'both', methods: ['cash', 'pos', 'transfer', 'hmo', 'waiver'],
        payBefore: { pharmacy: false, lab: false }, allowDeferredFor: ['emergency'], transferAccount: null,
        hmos: [{ name: 'Runtime HMO', active: true }], tills: [], dayCloseBy: 'cashier', receiptFooter: 'Thank you',
        checkInChargeItemId: null }, 0, false, false]);
    assert.equal(settings.version, 1);
  });
  let consultation; let medicine;
  await step('billing officer prices a consultation and a medicine', async () => {
    consultation = await ehr(members.officer, 'select commercial.catalogue_create($1, $2, $3) as answer',
      [{ kind: 'other', name: 'Consultation', prices: { cashKobo: 500000, hmo: [] } }]);
    medicine = await ehr(members.officer, 'select commercial.catalogue_create($1, $2, $3) as answer',
      [{ kind: 'drug', name: 'Fictional tablet 10 mg', form: 'tablet', prescriptionOnly: false,
        prices: { cashKobo: 2000, hmo: [] } }]);
    assert(consultation.id && medicine.id);
  });
  let bill;
  await step('cashier opens a day and makes a bill', async () => {
    const day = await ehr(members.cashier, 'select commercial.day_open($1, $2, $3, $4) as answer', [null, 100000]);
    assert(day.id);
    bill = (await ehr(members.cashier, 'select commercial.bill_create($1, $2, $3) as answer',
      [{ source: 'pharmacy', patient: { anonymous: true, name: 'Runtime walk-in' },
        lines: [{ catalogueItemId: consultation.id, quantity: 1 }] }])).bill;
    assert.equal(bill.totalKobo, 500000);
    assert.equal(bill.refundDueKobo, 0);
    assert.equal(bill.coverOverKobo, 0);
  });
  await step('cashier makes an anonymous walk-in lab bill (not a counter sale)', async () => {
    const lab = (await ehr(members.cashier, 'select commercial.bill_create($1, $2, $3) as answer',
      [{ source: 'lab', patient: { anonymous: true }, lines: [{ catalogueItemId: consultation.id, quantity: 1 }] }])).bill;
    assert.equal(lab.source, 'lab');
    assert.equal(lab.counter, false);
    assert.equal(lab.patient, null);
    assert.equal(lab.displayName, 'Walk-in');
  });
  await step('cashier takes POS and cash', async () => {
    const pos = await ehr(members.cashier, 'select commercial.payment_record($1, $2, $3, $4, $5) as answer',
      [bill.id, { method: 'pos', amountKobo: 200000, reference: '123456789012' }, null]);
    const cash = await ehr(members.cashier, 'select commercial.payment_record($1, $2, $3, $4, $5) as answer',
      [bill.id, { method: 'cash', amountKobo: 100000 }, null]);
    assert.equal(cash.paidKobo, 300000);
    assert.deepEqual(cash.payments.map((payment) => payment.receiptNumber.slice(-6)), ['000001', '000002']);
    bill = cash;
    assert.notEqual(pos, undefined);
  });
  await step('a billing officer voids the cash; the cashier and the recorder cannot', async () => {
    const cash = bill.payments.find((payment) => payment.method === 'cash');
    const byCashier = await ehr(members.cashier, 'select commercial.payment_void($1, $2, $3, $4, $5, $6, $7) as answer',
      [bill.id, cash.id, 'Refund: counted wrong', null, null]);
    assert.deepEqual(byCashier, { refused: 'BILLING_NOT_ALLOWED' });
    await ehr(members.officer, 'select commercial.day_open($1, $2, $3, $4) as answer', [null, 0]);
    const voided = await ehr(members.officer, 'select commercial.payment_void($1, $2, $3, $4, $5, $6, $7) as answer',
      [bill.id, cash.id, 'Refund: counted wrong', null, null]);
    assert.equal(voided.paidKobo, 200000);
    // The officer's own payment: another officer voids it, never the one who took it (BILL-4).
    const own = await ehr(members.officer, 'select commercial.payment_record($1, $2, $3, $4, $5) as answer',
      [bill.id, { method: 'cash', amountKobo: 1000 }, null]);
    const ownCash = own.payments.find((payment) => payment.method === 'cash' && !payment.voided);
    const byRecorder = await ehr(members.officer, 'select commercial.payment_void($1, $2, $3, $4, $5, $6, $7) as answer',
      [bill.id, ownCash.id, 'Refund: taken twice', null, null]);
    assert.deepEqual(byRecorder, { refused: 'SECOND_PERSON_REQUIRED' });
    await ehr(members.officer2, 'select commercial.day_open($1, $2, $3, $4) as answer', [null, 0]);
    bill = await ehr(members.officer2, 'select commercial.payment_void($1, $2, $3, $4, $5, $6, $7) as answer',
      [bill.id, ownCash.id, 'Refund: taken twice', null, null]);
    assert.equal(bill.paidKobo, 200000);
  });
  await step('an HMO cover is recorded: owed, not paid', async () => {
    const covered = await ehr(members.cashier, 'select commercial.payment_record($1, $2, $3, $4, $5) as answer',
      [bill.id, { method: 'hmo', amountKobo: 100000, hmoId: settings.hmos[0].id, reference: 'APP-001' }, null]);
    assert.deepEqual([covered.paidKobo, covered.hmoCoveredKobo, covered.dueKobo], [200000, 100000, 200000]);
  });
  await step('the pharmacist keeps stock and receives three batches', async () => {
    await pharmacy(members.pharmacist, 'select pharmacy.stock_settings_put($1, $2, $3, $4, $5, $6) as answer',
      [medicine.id, 'tablet', 10, 0]);
    const lagos = new Date(Date.now() + 3600_000);
    const inDays = (days) => new Date(lagos.getTime() + days * 86400_000).toISOString().slice(0, 10);
    await pharmacy(members.pharmacist, 'select pharmacy.stock_receive($1, $2, $3) as answer', [{ lines: [
      { catalogueItemId: medicine.id, batchNumber: 'LATE', expiresOn: inDays(200), quantity: 10 },
      { catalogueItemId: medicine.id, batchNumber: 'SOON', expiresOn: inDays(20), quantity: 4 },
      { catalogueItemId: medicine.id, batchNumber: 'MID', expiresOn: inDays(60), quantity: 4 }] }]);
  });
  await step('a counter sale is paid first and handed over expiry-first', async () => {
    const sale = await pharmacy(members.pharmacist, 'select pharmacy.counter_sale_create($1, $2, $3) as answer',
      [{ patient: { kind: 'anonymous' }, counter: true, items: [{ catalogueItemId: medicine.id, quantity: 6 }] }]);
    const unpaid = await pharmacy(members.pharmacist, 'select pharmacy.sale_hand_over($1, $2, $3, $4) as answer',
      [sale.bill.id, null]);
    assert.deepEqual(unpaid, { refused: 'PAYMENT_REQUIRED' });
    await ehr(members.pharmacist, 'select commercial.day_open($1, $2, $3, $4) as answer', [null, 0]);
    await ehr(members.pharmacist, 'select commercial.payment_record($1, $2, $3, $4, $5) as answer',
      [sale.bill.id, { method: 'cash', amountKobo: 12000 }, null]);
    const handed = await pharmacy(members.pharmacist, 'select pharmacy.sale_hand_over($1, $2, $3, $4) as answer',
      [sale.bill.id, null]);
    assert(handed.handedOverAt);
    const { rows } = await owner.query(`select string_agg(batch_number || ':' || on_hand, ',' order by batch_number) as stock
      from pharmacy.stock_batches where facility_id = $1`, [ids.facility]);
    assert.equal(rows[0].stock, 'LATE:10,MID:2,SOON:0');
  });
  await step('the cashier closes the day with a difference and a note', async () => {
    const current = await ehr(members.cashier, 'select commercial.day_current($1) as answer', [null], { keyed: false });
    assert.equal(current.shift.expectedCashKobo, 200000);
    const noNote = await ehr(members.cashier, 'select commercial.day_close($1, $2, $3, $4, $5, $6) as answer',
      [current.shift.id, 190000, null, current.shift.version]);
    assert.deepEqual(noNote, { refused: 'VALIDATION_FAILED' });
    const closed = await ehr(members.cashier, 'select commercial.day_close($1, $2, $3, $4, $5, $6) as answer',
      [current.shift.id, 190000, 'One 10,000 naira bundle short', current.shift.version]);
    assert.equal(closed.differenceKobo, -10000);
  });
  const ledger = (await owner.query('select pharmacy.stock_ledger_agrees($1) as agrees', [ids.facility])).rows[0].agrees;
  assert.equal(ledger, true, 'each batch\'s on hand is the sum of its movements');
  const leaks = (await owner.query(`select count(*)::int as n from audit.events where facility_id = $1
    and (details::text ~* 'runtime walk-in|123456789012|APP-001|counted wrong|taken twice|bundle short')`, [ids.facility])).rows[0].n;
  assert.equal(leaks, 0, 'no name, reference, approval code or reason text in an audit row');
  await owner.end();
} finally {
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [isolated]);
  await admin.query(`drop database if exists ${isolated}`);
  await admin.end();
}
process.stdout.write(`${JSON.stringify({ status: 'passed', steps })}\n`);
