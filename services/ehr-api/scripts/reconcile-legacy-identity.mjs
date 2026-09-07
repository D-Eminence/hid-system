#!/usr/bin/env node

import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';

const { Client } = pg;
// PostgreSQL DATE is a calendar date, not a midnight instant in the runner's
// timezone. Preserve its YYYY-MM-DD representation for source reconciliation.
pg.types.setTypeParser(1082, (value) => value);
const databaseUrl = process.env.DATABASE_URL;
const runId = process.env.MIGRATION_RUN_ID;
const encryptionKey = decodeKey('MIGRATION_FIELD_ENCRYPTION_KEY_B64', 32);
const lookupKey = decodeKey('MIGRATION_LOOKUP_HMAC_KEY_B64', 32);
const facilityTimezones = parseFacilityTimezones(process.env.MIGRATION_FACILITY_TIMEZONES_JSON);
const batchSize = Number.parseInt(process.env.MIGRATION_BATCH_SIZE ?? '500', 10);

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!runId) throw new Error('MIGRATION_RUN_ID is required');
if (!Number.isSafeInteger(batchSize) || batchSize < 10 || batchSize > 5_000) {
  throw new Error('MIGRATION_BATCH_SIZE must be between 10 and 5000');
}

function decodeKey(name, minimumBytes) {
  const encoded = process.env[name];
  if (!encoded) throw new Error(`${name} is required`);
  const value = Buffer.from(encoded, 'base64');
  if (value.length < minimumBytes) throw new Error(`${name} must decode to at least ${minimumBytes} bytes`);
  return value.subarray(0, minimumBytes);
}

function parseFacilityTimezones(value) {
  if (!value) throw new Error('MIGRATION_FACILITY_TIMEZONES_JSON is required');
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Invalid facility timezone mapping');
  return parsed;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Buffer.isBuffer(value)) return JSON.stringify({ base64: value.toString('base64') });
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error(`Unsupported canonical value: ${typeof value}`);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deterministicUuid(namespace) {
  const bytes = createHash('sha256').update(namespace, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function lookupHmac(value) {
  return createHmac('sha256', lookupKey).update(value, 'utf8').digest('hex');
}

function decrypt(value, associatedData) {
  if (!Buffer.isBuffer(value) || value.length < 30 || value[0] !== 1) throw new Error('Unsupported ciphertext envelope');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(1, 13));
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(value.subarray(13, 29));
  return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString('utf8');
}

function normalizePhone(value) {
  return value ? String(value).replace(/[^0-9+]/g, '') : null;
}

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function recordOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uuidOrNull(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function correlationOrFallback(value, eventId) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)
    ? value
    : `legacy:${eventId}`;
}

function legacyAuditOutcome(value) {
  if (value === 'deny' || value === 'not_found' || value === 'denied') return 'denied';
  if (value === 'failure' || value === 'failed') return 'failure';
  return 'success';
}

const definitions = [
  definition('accounts', 'auth.accounts', (source) => source.id, (source) => ({
    id: source.id,
    subject: source.id,
    email: textOrNull(source.email),
    password_hash: textOrNull(source.encrypted_password),
    disabled_until: source.banned_until ?? null,
    email_verified_at: source.email_confirmed_at ?? null,
    status: source.deleted_at ? 'deleted' : source.email_confirmed_at ? 'active' : 'pending_reset',
  }), (target) => ({
    id: target.id,
    subject: target.subject,
    email: target.email,
    password_hash: target.password_hash,
    disabled_until: target.disabled_until?.toISOString?.() ?? target.disabled_until ?? null,
    email_verified_at: target.email_verified_at?.toISOString?.() ?? target.email_verified_at ?? null,
    status: target.status,
  })),
  {
    ...definition('external_identities', 'auth.external_identities',
    (source) => deterministicUuid(`legacy-identity:${source.id}`),
    (source) => ({
      id: deterministicUuid(`legacy-identity:${source.id}`),
      account_id: source.id,
      issuer: 'legacy-identity',
      subject: source.id,
      status: !source.deleted_at && source.email_confirmed_at ? 'active' : 'disabled',
      source_system: 'legacy_identity',
    }),
    (target) => ({
      id: target.id,
      account_id: target.account_id,
      issuer: target.issuer,
      subject: target.subject,
      status: target.status,
      source_system: target.source_system,
    })),
    sourceEntityType: 'accounts',
  },
  {
    ...definition('user_profiles', 'auth.accounts', (source) => source.auth_user_id, (source) => ({
      account_id: source.auth_user_id,
      display_name: textOrNull(source.display_name),
    }), (target) => ({ account_id: target.id, display_name: target.display_name })),
    orphanSql: null,
  },
  definition('organizations', 'identity.organizations', (source) => source.id, (source) => ({
    id: source.id, name: source.name, slug: source.slug, active: source.active,
  }), (target) => ({ id: target.id, name: target.name, slug: target.slug, active: target.active })),
  definition('facilities', 'identity.facilities', (source) => source.id, (source) => ({
    id: source.id, organization_id: source.organization_id, name: source.name, code: source.code,
    active: source.active, lifecycle_status: source.active ? 'verified' : 'suspended',
    timezone: facilityTimezones[source.id] ?? null,
  }), (target) => ({ id: target.id, organization_id: target.organization_id, name: target.name,
    code: target.code, active: target.active, lifecycle_status: target.lifecycle_status, timezone: target.timezone })),
  definition('patients', 'identity.patients', (source) => source.id, (source) => {
    const phone = normalizePhone(source.phone_e164);
    const email = normalizeEmail(source.email);
    const emergencyContact = {
      name: source.emergency_contact_name ?? null,
      relationship: source.emergency_contact_relationship ?? null,
      phone: source.emergency_contact_phone ?? null,
      address: source.emergency_contact_address ?? null,
    };
    const hasEmergencyContact = Object.values(emergencyContact).some((value) => value !== null && value !== '');
    return {
      id: source.id,
      account_id: source.auth_user_id,
      hid_code: source.hid_code,
      first_name: source.first_name,
      last_name: source.last_name,
      full_name: source.full_name,
      dob: source.dob ?? null,
      phone,
      phone_hmac: phone ? lookupHmac(phone) : null,
      email,
      email_hmac: email ? lookupHmac(email) : null,
      emergency_contact: hasEmergencyContact ? canonicalJson(emergencyContact) : null,
      status: source.deleted_at ? 'deleted' : 'active',
    };
  }, (target) => ({
    id: target.id,
    account_id: target.account_id,
    hid_code: target.hid_code,
    first_name: target.first_name,
    last_name: target.last_name,
    full_name: target.full_name,
    dob: target.dob ?? null,
    phone: target.phone_e164_ciphertext ? decrypt(target.phone_e164_ciphertext, `${target.id}:phone`) : null,
    phone_hmac: target.phone_lookup_hmac,
    email: target.email_ciphertext ? decrypt(target.email_ciphertext, `${target.id}:email`) : null,
    email_hmac: target.email_lookup_hmac,
    emergency_contact: target.emergency_contact_ciphertext
      ? decrypt(target.emergency_contact_ciphertext, `${target.id}:emergency-contact`)
      : null,
    status: target.status,
  })),
  definition('patient_identifiers', 'identity.patient_identifiers', (source) => source.id, (source) => {
    const isPublic = source.identifier_type === 'hid_code';
    const normalized = String(source.normalized_value ?? source.raw_value).trim();
    return {
      id: source.id,
      patient_id: source.patient_id,
      identifier_type: source.identifier_type,
      value: isPublic ? normalized.toUpperCase() : String(source.raw_value),
      lookup_hmac: isPublic ? null : lookupHmac(normalized.toLowerCase()),
      verified: source.verified,
    };
  }, (target) => ({
    id: target.id,
    patient_id: target.patient_id,
    identifier_type: target.identifier_type,
    value: target.public_value ?? decrypt(target.value_ciphertext, `${target.id}:identifier`),
    lookup_hmac: target.lookup_hmac,
    verified: target.verified,
  })),
  definition('staff', 'identity.staff', (source) => source.id, (source) => ({
    id: source.id,
    account_id: source.auth_user_id,
    full_name: source.full_name,
    email: source.email,
    verification_status: source.verification_status,
    default_role: source.role,
    active: source.active,
  }), (target) => ({
    id: target.id,
    account_id: target.account_id,
    full_name: target.full_name,
    email: target.email,
    verification_status: target.verification_status,
    default_role: target.default_role,
    active: target.active,
  })),
  definition('memberships', 'identity.staff_facility_memberships', (source) => source.id, (source) => ({
    id: source.id,
    staff_id: source.staff_account_id,
    organization_id: source.organization_id,
    facility_id: source.facility_id ?? null,
    membership_role: source.membership_role,
    app_role: source.app_role,
    active: source.active,
    migration_hold_reason: !source.facility_id
      ? 'legacy_membership_missing_facility'
      : source.app_role === 'platform_admin'
        ? 'privileged_role_requires_reapproval'
        : null,
  }), (target) => ({
    id: target.id,
    staff_id: target.staff_id,
    organization_id: target.organization_id,
    facility_id: target.facility_id,
    membership_role: target.membership_role,
    app_role: target.app_role,
    active: target.active,
    migration_hold_reason: target.migration_hold_reason,
  })),
  definition('access_requests', 'identity.access_requests', (source) => source.id, (source) => ({
    id: source.id,
    patient_id: source.patient_id,
    staff_id: source.requester_staff_account_id,
    membership_id: source.requester_membership_id,
    scope: source.scope,
    status: source.status,
    break_glass: source.break_glass,
    purpose_of_use: null,
    migration_hold_reason: 'legacy_request_purpose_unmapped',
  }), (target) => ({
    id: target.id,
    patient_id: target.patient_id,
    staff_id: target.staff_id,
    membership_id: target.membership_id,
    scope: target.scope,
    status: target.status,
    break_glass: target.break_glass,
    purpose_of_use: target.purpose_of_use,
    migration_hold_reason: target.migration_hold_reason,
  })),
  definition('consent_grants', 'identity.consent_grants', (source) => source.id, (source) => ({
    id: source.id,
    patient_id: source.patient_id,
    staff_id: source.staff_account_id,
    membership_id: source.membership_id,
    scope: source.scope,
    status: source.status,
    break_glass: source.scope === 'break_glass',
    request_id: null,
    source_request_id: source.request_id ? String(source.request_id) : null,
    purpose_of_use: null,
    migration_hold_reason: 'legacy_grant_purpose_unmapped',
  }), (target) => ({
    id: target.id,
    patient_id: target.patient_id,
    staff_id: target.staff_id,
    membership_id: target.membership_id,
    scope: target.scope,
    status: target.status,
    break_glass: target.break_glass,
    request_id: target.request_id,
    source_request_id: target.source_request_id,
    purpose_of_use: target.purpose_of_use,
    migration_hold_reason: target.migration_hold_reason,
  })),
  {
    type: 'audit_events',
    table: 'audit.events',
    targetKey: (source) => source.event_id,
    keyColumn: 'event_id',
    expected: (source) => {
      const metadata = recordOrEmpty(source.metadata);
      return {
        event_id: source.event_id,
        correlation_id: correlationOrFallback(metadata.correlation_id ?? source.request_id, source.event_id),
        actor_type: 'legacy',
        patient_id: source.patient_id ?? null,
        organization_id: source.organization_id ?? null,
        facility_id: uuidOrNull(metadata.facility_id),
        action: source.action,
        outcome: legacyAuditOutcome(metadata.outcome),
        purpose_of_use: textOrNull(metadata.purpose),
        resource_type: source.resource_type ?? null,
        resource_id: source.resource_id ? String(source.resource_id) : null,
        provenance: 'legacy_identity',
        source_event_id: String(source.event_id),
      };
    },
    actual: (target) => ({
      event_id: target.event_id,
      correlation_id: target.correlation_id,
      actor_type: target.actor_type,
      patient_id: target.patient_id,
      organization_id: target.organization_id,
      facility_id: target.facility_id,
      action: target.action,
      outcome: target.outcome,
      purpose_of_use: target.purpose_of_use,
      resource_type: target.resource_type,
      resource_id: target.resource_id,
      provenance: target.provenance,
      source_event_id: target.source_event_id,
    }),
    orphanSql: `select count(*)::bigint as count from audit.events where provenance = 'legacy_identity'`,
  },
];

function definition(type, table, targetKey, expected, actual) {
  return {
    type,
    table,
    targetKey,
    keyColumn: 'id',
    expected,
    actual,
    orphanSql: `select count(*)::bigint as count from ${table} where source_system = 'legacy_identity'`,
  };
}

function safeTable(table) {
  if (!/^[a-z_]+\.[a-z_]+$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  return table.split('.').map((part) => `"${part}"`).join('.');
}

async function recordConflict(client, entityType, sourcePk, sourceHash, targetHash, details) {
  await client.query(
    `insert into migration.conflicts (
       run_id, entity_type, source_pk, conflict_type, source_sha256, target_sha256, details
     ) values ($1, $2, $3, 'reconciliation_mismatch', $4, $5, $6::jsonb)
     on conflict (run_id, entity_type, source_pk, conflict_type) do nothing`,
    [runId, entityType, sourcePk, sourceHash, targetHash, JSON.stringify(details)],
  );
}

async function reconcileDefinition(client, definitionRow) {
  let cursor = '';
  let sourceCount = 0;
  let matchedCount = 0;
  let conflictCount = 0;
  const sourceAggregate = createHash('sha256');
  const targetAggregate = createHash('sha256');

  for (;;) {
    const staged = await client.query(
      `select source_pk, payload, payload_sha256
         from migration.source_rows
        where run_id = $1 and entity_type = $2 and source_pk > $3
        order by source_pk
        limit $4`,
      [runId, definitionRow.sourceEntityType ?? definitionRow.type, cursor, batchSize],
    );
    if (staged.rows.length === 0) break;
    const keys = staged.rows.map((row) => definitionRow.targetKey(row.payload));
    const targetRows = await client.query(
      `select * from ${safeTable(definitionRow.table)} where ${definitionRow.keyColumn} = any($1::uuid[])`,
      [keys],
    );
    const targetByKey = new Map(targetRows.rows.map((row) => [String(row[definitionRow.keyColumn]), row]));

    for (const row of staged.rows) {
      cursor = row.source_pk;
      sourceCount += 1;
      let expected;
      let actual;
      let expectedHash;
      let actualHash = null;
      try {
        expected = definitionRow.expected(row.payload);
        expectedHash = sha256(canonicalJson(expected));
        const target = targetByKey.get(String(definitionRow.targetKey(row.payload)));
        if (target) {
          actual = definitionRow.actual(target);
          actualHash = sha256(canonicalJson(actual));
        }
      } catch {
        expectedHash = row.payload_sha256.trim();
      }
      sourceAggregate.update(`${row.source_pk}:${expectedHash}\n`, 'utf8');
      if (!actualHash || actualHash !== expectedHash) {
        conflictCount += 1;
        await recordConflict(client, definitionRow.type, row.source_pk, expectedHash, actualHash, { table: definitionRow.table });
      } else {
        matchedCount += 1;
        targetAggregate.update(`${row.source_pk}:${actualHash}\n`, 'utf8');
      }
    }
  }

  const sourceChecksum = sourceAggregate.digest('hex');
  const targetChecksum = targetAggregate.digest('hex');
  if (definitionRow.orphanSql) {
    const markedTargetCount = BigInt((await client.query(definitionRow.orphanSql)).rows[0]?.count ?? 0);
    if (markedTargetCount > BigInt(sourceCount)) {
      conflictCount += 1;
      await recordConflict(
        client,
        definitionRow.type,
        '__orphan_count__',
        sha256(String(sourceCount)),
        sha256(String(markedTargetCount)),
        { reason: 'target_contains_legacy_rows_absent_from_snapshot' },
      );
    }
  }

  if (conflictCount === 0) {
    await client.query(
      `insert into migration.entity_reconciliations (
         run_id, entity_type, source_count, target_count, source_checksum_sha256, target_checksum_sha256
       ) values ($1, $2, $3, $4, $5, $6)
       on conflict (run_id, entity_type) do nothing`,
      [runId, definitionRow.type, sourceCount, matchedCount, sourceChecksum, targetChecksum],
    );
  }
  process.stdout.write(`${definitionRow.type}: ${matchedCount}/${sourceCount} matched; ${conflictCount} conflict(s)\n`);
  return { sourceCount, matchedCount, sourceChecksum, targetChecksum, conflictCount };
}

async function reconcileClinicalQuarantine(client) {
  let cursor = '';
  let sourceCount = 0;
  let matchedCount = 0;
  let conflictCount = 0;
  const sourceAggregate = createHash('sha256');
  const targetAggregate = createHash('sha256');
  for (;;) {
    const staged = await client.query(
      `select source_pk, payload
         from migration.source_rows
        where run_id = $1 and entity_type = 'patients' and source_pk > $2
        order by source_pk
        limit $3`,
      [runId, cursor, batchSize],
    );
    if (staged.rows.length === 0) break;
    const patientIds = [];
    const expectedByPatient = new Map();
    for (const row of staged.rows) {
      cursor = row.source_pk;
      const source = row.payload;
      const clinical = {
        blood_group: source.blood_group ?? null,
        genotype: source.genotype ?? null,
        allergies: source.allergies ?? null,
        chronic_conditions: source.chronic_conditions ?? null,
        current_medications: source.current_medications ?? null,
        medical_notes: source.medical_notes ?? null,
      };
      if (Object.values(clinical).some((value) => value !== null && value !== '')) {
        const plaintext = canonicalJson(clinical);
        expectedByPatient.set(source.id, { plaintext, hash: sha256(plaintext) });
        patientIds.push(source.id);
      }
    }
    if (patientIds.length === 0) continue;
    const targets = await client.query(
      `select patient_id, encrypted_payload, payload_sha256
         from migration.legacy_clinical_quarantine
        where run_id = $1 and patient_id = any($2::uuid[])`,
      [runId, patientIds],
    );
    const targetByPatient = new Map(targets.rows.map((row) => [String(row.patient_id), row]));
    for (const patientId of patientIds) {
      sourceCount += 1;
      const expected = expectedByPatient.get(patientId);
      const target = targetByPatient.get(patientId);
      sourceAggregate.update(`${patientId}:${expected.hash}\n`, 'utf8');
      let targetHash = null;
      try {
        const plaintext = decrypt(target.encrypted_payload, `${runId}:${patientId}:legacy-clinical`);
        targetHash = sha256(plaintext);
      } catch {
        targetHash = null;
      }
      if (!target || target.payload_sha256.trim() !== expected.hash || targetHash !== expected.hash) {
        conflictCount += 1;
        await recordConflict(client, 'legacy_clinical_quarantine', patientId, expected.hash, targetHash, { table: 'migration.legacy_clinical_quarantine' });
      } else {
        matchedCount += 1;
        targetAggregate.update(`${patientId}:${targetHash}\n`, 'utf8');
      }
    }
  }
  const sourceChecksum = sourceAggregate.digest('hex');
  const targetChecksum = targetAggregate.digest('hex');
  const targetCount = Number((await client.query(
    'select count(*)::integer as count from migration.legacy_clinical_quarantine where run_id = $1',
    [runId],
  )).rows[0]?.count ?? 0);
  if (targetCount !== sourceCount) {
    conflictCount += 1;
    await recordConflict(client, 'legacy_clinical_quarantine', '__count__', sha256(String(sourceCount)), sha256(String(targetCount)), { reason: 'quarantine_count_mismatch' });
  }
  if (conflictCount === 0) {
    await client.query(
      `insert into migration.entity_reconciliations (
         run_id, entity_type, source_count, target_count, source_checksum_sha256, target_checksum_sha256
       ) values ($1, 'legacy_clinical_quarantine', $2, $3, $4, $5)
       on conflict (run_id, entity_type) do nothing`,
      [runId, sourceCount, matchedCount, sourceChecksum, targetChecksum],
    );
  }
  process.stdout.write(`legacy_clinical_quarantine: ${matchedCount}/${sourceCount} matched; ${conflictCount} conflict(s)\n`);
  return { sourceCount, matchedCount, sourceChecksum, targetChecksum, conflictCount };
}

async function main() {
  const client = new Client(databaseOptions(databaseUrl, 'hid-legacy-reconciler'));
  await client.connect();
  try {
    const run = (await client.query(
      `select id, status, mode from migration.runs where id = $1 and source_system = 'legacy_identity'`,
      [runId],
    )).rows[0];
    if (!run || run.status !== 'staged' || run.mode !== 'promote') {
      throw new Error('Run must have completed promotion and remain in staged status');
    }
    const existingConflicts = Number((await client.query(
      'select count(*)::integer as count from migration.conflicts where run_id = $1',
      [runId],
    )).rows[0]?.count ?? 0);
    if (existingConflicts > 0) throw new Error('Run already has conflicts; stage a new corrected run');

    const results = {};
    let totalConflicts = 0;
    for (const item of definitions) {
      const result = await reconcileDefinition(client, item);
      results[item.type] = result;
      totalConflicts += result.conflictCount;
    }
    const quarantineResult = await reconcileClinicalQuarantine(client);
    results.legacy_clinical_quarantine = quarantineResult;
    totalConflicts += quarantineResult.conflictCount;

    const targetCounts = Object.fromEntries(Object.entries(results).map(([type, result]) => [type, result.matchedCount]));
    const targetChecksum = sha256(canonicalJson(Object.fromEntries(
      Object.entries(results).map(([type, result]) => [type, result.targetChecksum]),
    )));
    if (totalConflicts > 0) {
      await client.query(
        `update migration.runs
            set status = 'blocked', target_counts = $2::jsonb, target_checksum_sha256 = $3,
                notes = 'Reconciliation conflicts detected; cutover prohibited'
          where id = $1`,
        [runId, JSON.stringify(targetCounts), targetChecksum],
      );
      throw new Error(`Reconciliation blocked by ${totalConflicts} conflict(s)`);
    }

    await client.query(
      `update migration.runs
          set mode = 'reconcile', status = 'verified', completed_at = clock_timestamp(),
              target_counts = $2::jsonb, target_checksum_sha256 = $3,
              notes = coalesce(notes, '') || E'\nIdentity reconciliation verified.'
        where id = $1`,
      [runId, JSON.stringify(targetCounts), targetChecksum],
    );
    process.stdout.write(`Run ${runId} is verified. This is not cutover authorization.\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
