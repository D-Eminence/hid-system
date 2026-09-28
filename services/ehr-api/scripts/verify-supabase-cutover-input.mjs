#!/usr/bin/env node

// Read-only cutover gate. It accepts either a sanitized fixture/export or an
// already staged migration run and emits only counts/checksums, never source
// identifiers, PIN hashes, provider subjects, or outreach payloads.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';

const { Client } = pg;
const fixturePath = process.env.MIGRATION_FIXTURE_PATH;
const databaseUrl = process.env.DATABASE_URL;
const runId = process.env.MIGRATION_RUN_ID;
const expected = {
  pins: expectedCount('CUTOVER_EXPECTED_PIN_COUNT', 39),
  google: expectedCount('CUTOVER_EXPECTED_GOOGLE_COUNT', 6),
  plannedCampaigns: expectedCount('CUTOVER_EXPECTED_PLANNED_CAMPAIGN_COUNT', 4),
  queuedEncounters: expectedCount('CUTOVER_EXPECTED_QUEUED_ENCOUNTER_COUNT', 2),
};
const EXPECTATION_OVERRIDE_NAMES = Object.freeze([
  'CUTOVER_EXPECTED_PIN_COUNT',
  'CUTOVER_EXPECTED_GOOGLE_COUNT',
  'CUTOVER_EXPECTED_PLANNED_CAMPAIGN_COUNT',
  'CUTOVER_EXPECTED_QUEUED_ENCOUNTER_COUNT',
]);
const STAGED_ENTITY_TYPES = Object.freeze([
  'accounts',
  'google_identities',
  'patient_access_pins',
  'user_profiles',
  'organizations',
  'facilities',
  'patients',
  'patient_identifiers',
  'staff',
  'memberships',
  'access_requests',
  'consent_grants',
  'audit_events',
  'outreach_campaigns',
  'outreach_workers',
  'outreach_encounters',
  'outreach_sync_queue',
  'outreach_referrals',
  'outreach_vaccinations',
  'outreach_mobile_lab_samples',
  'outreach_invites',
]);

if (Boolean(fixturePath) === Boolean(databaseUrl)) {
  throw new Error('Provide exactly one of MIGRATION_FIXTURE_PATH or DATABASE_URL');
}
if (databaseUrl && !runId) throw new Error('MIGRATION_RUN_ID is required when validating staged data');

function expectedCount(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== (process.env[name] ?? String(fallback))) {
    throw new Error(name + ' must be a non-negative integer');
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Input contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => JSON.stringify(key) + ':' + canonicalJson(child)).join(',') + '}';
  }
  throw new Error('Input contains an unsupported value');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function timestamp(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).valueOf());
}

function rowsByType(rows) {
  const result = new Map();
  for (const row of rows) {
    const current = result.get(row.entityType) ?? [];
    current.push(row);
    result.set(row.entityType, current);
  }
  return result;
}

function payloadRows(grouped, entityType) {
  return grouped.get(entityType) ?? [];
}

function ids(rows) {
  return new Set(rows.map((row) => row.payload.id).filter(uuid));
}

function fail(errors, message) {
  errors.push(message);
}

function validate(rows, stagedEvidence) {
  const errors = [];
  const grouped = rowsByType(rows);
  for (const entityType of grouped.keys()) {
    if (!STAGED_ENTITY_TYPES.includes(entityType)) {
      fail(errors, 'staged source rows contain an unexpected entity category');
    }
  }
  const pins = payloadRows(grouped, 'patient_access_pins');
  const google = payloadRows(grouped, 'google_identities');
  const campaigns = payloadRows(grouped, 'outreach_campaigns');
  const workers = payloadRows(grouped, 'outreach_workers');
  const encounters = payloadRows(grouped, 'outreach_encounters');
  const queues = payloadRows(grouped, 'outreach_sync_queue');
  const referrals = payloadRows(grouped, 'outreach_referrals');
  const vaccinations = payloadRows(grouped, 'outreach_vaccinations');
  const samples = payloadRows(grouped, 'outreach_mobile_lab_samples');
  const invites = payloadRows(grouped, 'outreach_invites');

  for (const row of rows) {
    if (typeof row.sourcePk !== 'string' || typeof row.payloadSha256 !== 'string'
      || !/^[0-9a-f]{64}$/i.test(row.payloadSha256)
      || sha256(canonicalJson(row.payload)) !== row.payloadSha256.toLowerCase()) {
      fail(errors, 'staged source row checksum does not match its payload');
    }
  }

  if (pins.length !== expected.pins) fail(errors, 'patient_access_pins count does not equal the authorized expectation');
  if (google.length !== expected.google) fail(errors, 'google_identities count does not equal the authorized expectation');
  const planned = campaigns.filter((row) => row.payload.status === 'planned').length;
  const queued = encounters.filter((row) => row.payload.status === 'queued').length;
  if (planned !== expected.plannedCampaigns) fail(errors, 'planned outreach campaign count does not equal the authorized expectation');
  if (queued !== expected.queuedEncounters) fail(errors, 'queued outreach encounter count does not equal the authorized expectation');

  for (const row of pins) {
    const source = row.payload;
    if (row.sourcePk !== source.patient_id || !uuid(source.patient_id)
      || typeof source.pin_hash !== 'string'
      || !/^\$2[aby]\$(?:0[4-9]|1[0-2])\$[./A-Za-z0-9]{53}$/.test(source.pin_hash)
      || !timestamp(source.created_at) || !timestamp(source.updated_at)) {
      fail(errors, 'patient_access_pins contains an invalid source envelope');
    }
  }

  const accountIds = new Set(payloadRows(grouped, 'accounts').map((row) => row.payload.id).filter(uuid));
  const contextAccountIds = new Set([
    ...payloadRows(grouped, 'patients').map((row) => row.payload.auth_user_id),
    ...payloadRows(grouped, 'staff').map((row) => row.payload.auth_user_id),
  ].filter(uuid));
  const providerSubjects = new Set();
  for (const row of google) {
    const source = row.payload;
    const subject = typeof source.provider_id === 'string' ? source.provider_id : '';
    const data = source.identity_data && typeof source.identity_data === 'object' ? source.identity_data : {};
    if (row.sourcePk !== source.id || !uuid(source.id) || source.provider !== 'google'
      || !subject || !uuid(source.user_id) || !accountIds.has(source.user_id)
      || !contextAccountIds.has(source.user_id) || !timestamp(source.created_at)
      || (data.sub !== undefined && data.sub !== null && data.sub !== subject)
      || providerSubjects.has(subject)) {
      fail(errors, 'google_identities contains an invalid, unlinked, or duplicate provider subject');
    }
    providerSubjects.add(subject);
  }

  const campaignIds = ids(campaigns);
  const workerById = new Map(workers.map((row) => [row.payload.id, row.payload]));
  const encounterById = new Map(encounters.map((row) => [row.payload.id, row.payload]));
  for (const row of workers) {
    if (!uuid(row.payload.id) || !campaignIds.has(row.payload.campaign_id)
      || !accountIds.has(row.payload.auth_user_id)) {
      fail(errors, 'outreach_workers has an unresolved source relationship');
    }
  }
  for (const row of encounters) {
    const worker = workerById.get(row.payload.worker_id);
    if (!uuid(row.payload.id) || !campaignIds.has(row.payload.campaign_id)
      || !worker || worker.campaign_id !== row.payload.campaign_id) {
      fail(errors, 'outreach_encounters has an unresolved source relationship');
    }
  }
  for (const row of queues) {
    const worker = workerById.get(row.payload.worker_id);
    if (!uuid(row.payload.id) || !campaignIds.has(row.payload.campaign_id)
      || !worker || worker.campaign_id !== row.payload.campaign_id) {
      fail(errors, 'outreach_sync_queue has an unresolved source relationship');
    }
  }
  for (const [entityType, collection] of [
    ['outreach_referrals', referrals],
    ['outreach_vaccinations', vaccinations],
    ['outreach_mobile_lab_samples', samples],
  ]) {
    for (const row of collection) {
      const encounter = row.payload.encounter_id ? encounterById.get(row.payload.encounter_id) : null;
      if (!uuid(row.payload.id) || !campaignIds.has(row.payload.campaign_id)
        || (row.payload.encounter_id && (!encounter || encounter.campaign_id !== row.payload.campaign_id))) {
        fail(errors, entityType + ' has an unresolved source relationship');
      }
    }
  }
  for (const row of invites) {
    const worker = workerById.get(row.payload.created_by);
    if (!uuid(row.payload.id) || !campaignIds.has(row.payload.campaign_id)
      || !worker || worker.campaign_id !== row.payload.campaign_id) {
      fail(errors, 'outreach_invites has an unresolved source relationship');
    }
  }

  const summary = {};
  for (const entityType of STAGED_ENTITY_TYPES) {
    const entityRows = grouped.get(entityType) ?? [];
    const aggregate = createHash('sha256');
    for (const row of entityRows) aggregate.update(row.sourcePk + ':' + row.payloadSha256 + '\n', 'utf8');
    summary[entityType] = { count: entityRows.length, checksum: aggregate.digest('hex') };
  }
  if (stagedEvidence) validateSealedEvidence(summary, stagedEvidence, errors);
  if (errors.length > 0) throw new Error('Cutover input validation failed: ' + [...new Set(errors)].join('; '));
  return summary;
}

function validateSealedEvidence(summary, evidence, errors) {
  const counts = evidence.sourceCounts;
  const validCounts = counts && typeof counts === 'object' && !Array.isArray(counts)
    && Object.keys(counts).length === STAGED_ENTITY_TYPES.length
    && STAGED_ENTITY_TYPES.every((entityType) => Number.isSafeInteger(counts[entityType]) && counts[entityType] >= 0)
    && Object.keys(counts).every((entityType) => STAGED_ENTITY_TYPES.includes(entityType));
  if (!validCounts) {
    fail(errors, 'staged run has invalid sealed category-count evidence');
    return;
  }
  const actualCounts = {};
  const actualChecksums = {};
  for (const entityType of STAGED_ENTITY_TYPES) {
    actualCounts[entityType] = summary[entityType].count;
    actualChecksums[entityType] = summary[entityType].checksum;
    if (counts[entityType] !== actualCounts[entityType]) {
      fail(errors, 'staged source rows do not match their sealed category counts');
    }
  }
  const actualOverallChecksum = sha256(canonicalJson({ counts: actualCounts, checksums: actualChecksums }));
  if (typeof evidence.sourceChecksum !== 'string'
    || !/^[0-9a-f]{64}$/i.test(evidence.sourceChecksum)
    || evidence.sourceChecksum.toLowerCase() !== actualOverallChecksum) {
    fail(errors, 'staged source rows do not match their sealed snapshot checksum');
  }
}

async function fixtureRows(path) {
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  if (!fixture || Array.isArray(fixture) || typeof fixture !== 'object') {
    throw new Error('MIGRATION_FIXTURE_PATH must contain an entity-to-row object');
  }
  return Object.entries(fixture).flatMap(([entityType, entityRows]) => {
    if (!Array.isArray(entityRows)) throw new Error('Fixture category is not an array');
    return entityRows.map((row) => {
      if (!row || typeof row !== 'object' || typeof row.source_pk !== 'string'
        || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
        throw new Error('Fixture contains an invalid staged row');
      }
      return {
        entityType,
        sourcePk: row.source_pk,
        payload: row.payload,
        payloadSha256: sha256(canonicalJson(row.payload)),
      };
    });
  });
}

async function stagedRows() {
  const client = new Client(databaseOptions(databaseUrl, 'hid-cutover-input-verifier'));
  await client.connect();
  try {
    const run = (await client.query(
      `select id, mode, status, source_counts, source_checksum_sha256,
              source_transaction_snapshot
         from migration.runs
        where id = $1 and source_system = $2`,
      [runId, 'legacy_identity'],
    )).rows[0];
    if (!run || !['stage', 'promote'].includes(run.mode) || run.status !== 'staged') {
      throw new Error('MIGRATION_RUN_ID is not a sealed legacy-identity staging or promotion run');
    }
    const usesExpectationOverride = EXPECTATION_OVERRIDE_NAMES.some((name) => process.env[name] !== undefined);
    if (usesExpectationOverride
      && (typeof run.source_transaction_snapshot !== 'string'
        || !run.source_transaction_snapshot.startsWith('fixture:'))) {
      throw new Error('Count overrides are permitted only for a synthetic fixture staging run');
    }
    const result = await client.query(
      'select entity_type, source_pk, payload, payload_sha256 from migration.source_rows where run_id = $1 order by entity_type, source_pk',
      [runId],
    );
    return {
      rows: result.rows.map((row) => ({
        entityType: row.entity_type,
        sourcePk: row.source_pk,
        payload: row.payload,
        payloadSha256: row.payload_sha256.trim(),
      })),
      evidence: {
        sourceCounts: run.source_counts,
        sourceChecksum: run.source_checksum_sha256?.trim(),
      },
    };
  } finally {
    await client.end();
  }
}

const input = fixturePath
  ? { rows: await fixtureRows(fixturePath), evidence: undefined }
  : await stagedRows();
const summary = validate(input.rows, input.evidence);
process.stdout.write(JSON.stringify({ expected, categories: summary }) + '\n');
