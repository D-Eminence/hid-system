#!/usr/bin/env node
// Phase 4 Stage 9 measurement, not a gate: how often concurrent writes of
// unrelated rows still fail under the SERIALIZABLE retry, and how many attempts
// they take. Rounds of WIDTH concurrent Pharmacy dispenses of different work
// items, then reversals of those dispensings, run through the real Pharmacy API
// as hid_pharmacy_api_runtime on a disposable copy of the owned synthetic
// rehearsal database, with an Identity fake that answers each authorization
// after LATENCY milliseconds (inside the transaction, as in production).
// SERIALIZABLE tracks reads by index page, so on these small tables such writes
// cancel each other (40001) even though they touch different rows.
//
// Run as the rehearsal runs the runtime verifiers (non-root, PGHOST pointing at
// the owned /tmp/hid-tuf-migration.* cluster, PGDATABASE=hid_rehearsal,
// NODE_ENV=test), for example:
//   ROUNDS=20 WIDTH=16 LATENCY=20-40 node services/pharmacy-api/scripts/measure-serializable-retry.mjs
// POLICY=attempts,baseMs,capMs measures the same retry loop with other numbers
// (it does not apply the once-only rule for unique violations, which unrelated
// writes do not raise). The release checklist (section 8, Stage 9) records the
// results that sized the shipped policy.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { disposableDatabase, fakeService, startService } from '../../../scripts/service-runtime-harness.mjs';

const ROUNDS = Number(process.env.ROUNDS ?? 30), WIDTH = Number(process.env.WIDTH ?? 8);
const LATENCY = (process.env.LATENCY ?? '20-40').split('-').map(Number);
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const PHARMACY_TOKEN = 'public-synthetic-pharmacy-internal-token-0001', IDENTITY_TOKEN = 'public-synthetic-identity-pharmacy-token-0001';
const actors = new Map();
const identity = await fakeService(async ({ path, headers, body }) => {
  const actor = actors.get(String(headers.authorization ?? '').replace(/^Bearer /, ''));
  if (path === '/api/v1/auth/service-session') return [200, { actor }];
  await new Promise((r) => setTimeout(r, LATENCY[0] + Math.floor(Math.random() * (LATENCY[1] - LATENCY[0] + 1))));
  const facilityId = headers['x-facility-id'];
  return [200, { allowed: true, patientId: body.patientId, facilityId, membershipId: actor.facilities[0].membershipId,
    scope: body.scope, purpose: body.purpose, breakGlass: false }];
});
const database = await disposableDatabase(require, 'stress');
for (const key of Object.keys(process.env)) if (/^(PHARMACY|IDENTITY)_/.test(key)) delete process.env[key];
Object.assign(process.env, { DATABASE_URL: database.url('hid_pharmacy_api_runtime'), DATABASE_POOL_MAX: '8',
  IDENTITY_API_URL: identity.url, IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret', IDENTITY_PHARMACY_INTERNAL_SERVICE_TOKEN: IDENTITY_TOKEN,
  PHARMACY_SERVICE_IDENTITY_MODE: 'local-secret', PHARMACY_INTERNAL_SERVICE_TOKEN: PHARMACY_TOKEN });
let pharmacy;
try {
  const id = () => randomUUID();
  const f = { org: id(), facility: id(), patient: id(), encounter: id(), prescriber: id(),
    members: Array.from({ length: 4 }, () => ({ account: id(), staff: id(), membership: id() })),
    work: Array.from({ length: ROUNDS * WIDTH }, () => id()) };
  await database.fixture(async (client) => {
    await client.query('insert into identity.organizations (id,name,slug) values ($1,$2,$3)', [f.org, 'Stress Org', `stress-${f.org.slice(0, 8)}`]);
    await client.query(`insert into identity.facilities (id,organization_id,name,code,timezone,active,lifecycle_status)
      values ($1,$2,'Stress Clinic',$3,'Africa/Lagos',true,'verified')`, [f.facility, f.org, `ST-${f.facility.slice(0, 8)}`]);
    for (const [i, m] of f.members.entries()) {
      await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,'Stress','active')`,
        [m.account, `synthetic:stress:${m.account}`, `stress-${m.account}@example.invalid`]);
      await client.query(`insert into identity.staff (id,account_id,full_name,email,verification_status,default_role)
        values ($1,$2,'Stress',$3,'verified','pharmacist')`, [m.staff, m.account, `stress-${m.account}@example.invalid`]);
      await client.query(`insert into identity.staff_facility_memberships (id,staff_id,account_id,organization_id,facility_id,
        membership_role,app_role) values ($1,$2,$3,$4,$5,'pharmacist','pharmacist')`, [m.membership, m.staff, m.account, f.org, f.facility]);
      actors.set(`token-${i}`, { id: m.account, subject: `synthetic:stress:${m.account}`, accountId: m.account, sessionId: id(), roles: [],
        permissions: [], facilityIds: [f.facility], authenticationMethod: 'local', facilities: [{ id: f.facility, membershipId: m.membership,
          organizationId: f.org, name: 'Stress', roles: ['pharmacist'], permissions: ['pharmacy.dispensing.create', 'pharmacy.dispensing.reverse'], isPrimary: true }] });
    }
    await client.query(`insert into auth.accounts (id,subject,email,display_name,status) values ($1,$2,$3,'Prescriber','active')`,
      [f.prescriber, `synthetic:stress-prescriber:${f.prescriber}`, `prescriber-${f.prescriber}@example.invalid`]);
    await client.query(`insert into identity.patients (id,hid_code,first_name,last_name,full_name,status)
      values ($1,'HID-STRSSAAA','Stress','Patient','Stress Patient','active')`, [f.patient]);
    await client.query(`insert into identity.purpose_of_use_codes (code,display,source_system) values ('direct-care','Direct patient care','stress') on conflict (code) do nothing`);
    for (const m of f.members) await client.query(`insert into identity.consent_grants (id,patient_id,staff_id,account_id,membership_id,facility_id,scope,
      purpose_of_use,status,reason,starts_at,expires_at) values ($1,$2,$3,$4,$5,$6,'write_records','direct-care','active','Stress consent',
      clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')`, [id(), f.patient, m.staff, m.account, m.membership, f.facility]);
    for (const w of f.work) await client.query(`insert into pharmacy.work_items (id,patient_id,facility_id,ordering_facility_id,
      source_ehr_prescription_id,source_ehr_prescription_version,source_encounter_id,source_status,medication_display,frequency,instructions,
      prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,acceptance_reason,idempotency_key,request_sha256,correlation_id)
      values ($1,$2,$3,$3,$4,1,$5,'active','Amoxicillin 500 mg','Every 8 hours','Take after food',$6,'2026-10-01 08:00:00+00',$7,$8,
      'Stress accepted',$9,repeat('a',64),'pharmacy-stress-probe')`, [w, f.patient, f.facility, id(), f.encounter, f.prescriber, f.members[0].account,
      f.members[0].membership, `stress-accept-${w}`]);
  });
  pharmacy = await startService({ require, service });
  // POLICY=attempts,base,cap replaces the shipped retry loop with the same loop under other numbers.
  if (process.env.POLICY) {
    const [attemptLimit, base, cap] = process.env.POLICY.split(',').map(Number);
    const { isRetryableConflict } = require(join(service, 'src/database/database.service.ts'));
    pharmacy.database.withTransaction = async function (context, operation, options = {}) {
      const limit = options.isolationLevel === 'SERIALIZABLE' ? attemptLimit : 1;
      for (let attempt = 1; ; attempt += 1) {
        try { return await this.transaction(context, operation, options); } catch (error) {
          if (attempt >= limit || !isRetryableConflict(error)) throw error;
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * Math.min(cap, base * 2 ** (attempt - 1)))));
        }
      }
    };
  }
  const original = pharmacy.database.transaction.bind(pharmacy.database);
  const attemptsPerCall = new Map();
  pharmacy.database.transaction = (context, operation, options) => {
    attemptsPerCall.set(context.correlationId, (attemptsPerCall.get(context.correlationId) ?? 0) + 1);
    return original(context, operation, options);
  };
  const send = (path, body, i) => pharmacy.request('POST', `/pharmacy${path}`, { body, headers: { authorization: `Bearer token-${i % 4}`,
    'x-facility-id': f.facility, 'x-purpose-of-use': 'direct-care', 'idempotency-key': `stress-${randomUUID()}` } });
  const outcomes = { dispense: {}, reverse: {} };
  const tally = (kind, r) => { const k = r.status === 201 ? '201' : `${r.status}:${r.sqlstate}`; outcomes[kind][k] = (outcomes[kind][k] ?? 0) + 1; };
  const started = Date.now();
  for (let round = 0; round < ROUNDS; round += 1) {
    const items = f.work.slice(round * WIDTH, (round + 1) * WIDTH);
    const dispensed = await Promise.all(items.map((w, i) => send(`/work-items/${w}/dispensings`,
      { expectedWorkItemVersion: 1, quantityDispensed: 21, quantityUnit: 'tablet', reason: 'Synthetic medication supplied' }, i)));
    dispensed.forEach((r) => tally('dispense', r));
    const reversed = await Promise.all(dispensed.filter((r) => r.status === 201).map((r, i) => send(`/dispensings/${r.body.id}/reversals`,
      { expectedDispensingVersion: 1, reason: 'Synthetic dispensing reversed' }, i)));
    reversed.forEach((r) => tally('reverse', r));
  }
  const attempts = [...attemptsPerCall.values()];
  const histogram = attempts.reduce((h, a) => ({ ...h, [a]: (h[a] ?? 0) + 1 }), {});
  await pharmacy.close(); pharmacy = undefined;
  console.log(JSON.stringify({ policy: process.env.POLICY ?? 'shipped', rounds: ROUNDS, width: WIDTH, latency: LATENCY, seconds: (Date.now() - started) / 1000, outcomes,
    attemptsHistogram: histogram, deadlocks: await database.deadlocks() }));
} finally { await pharmacy?.close(); await database.close(); await identity.close(); }
