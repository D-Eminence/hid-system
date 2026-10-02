#!/usr/bin/env node

// A complete, externally attested exact/absent source inventory is imported
// only after the legacy Identity run has reconciled. Dry-run is the default.
// The input contains raw NINs: never write it, a NIN, or a lookup HMAC to logs.
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';

const { Client } = pg;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const NIN = /^[0-9]{11}$/;

function requireText(value, min, max, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requireKey(value) {
  if (typeof value !== 'string') throw new Error('NIN_LOOKUP_HMAC_KEY_B64 is required');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('NIN_LOOKUP_HMAC_KEY_B64 must be exactly 32 base64-encoded bytes');
  }
  return key;
}

function sourceHasOpaqueNin(payload) {
  return ['nin_last4', 'nin_hash', 'nin_ciphertext'].some((field) =>
    payload[field] !== null && payload[field] !== undefined && String(payload[field]).trim() !== '');
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error('Invalid attestation time');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.valueOf() > Date.now()) throw new Error('Invalid attestation time');
  return parsed;
}

export function prepareLegacyNinInventory(input, sourceRows, governedBindings, lookupKey) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.patients)) {
    throw new Error('Attestation must contain a patient inventory');
  }
  if (!UUID.test(input.runId)) throw new Error('Invalid attestation run ID');
  requireText(input.sourceSnapshot, 8, 255, 'source snapshot');
  if (!SHA256.test(input.sourceChecksumSha256)) throw new Error('Invalid source checksum');
  requireText(input.evidenceReference, 8, 500, 'inventory evidence reference');
  requireText(input.attestedBy, 3, 255, 'attestor');
  const attestedAt = timestamp(input.attestedAt);
  if (!Buffer.isBuffer(lookupKey) || lookupKey.length !== 32) throw new Error('Invalid NIN lookup key');

  const sourceById = new Map();
  for (const source of sourceRows) {
    const id = String(source.source_pk).toLowerCase();
    if (!UUID.test(id) || !SHA256.test(String(source.payload_sha256).trim())
      || !source.payload || source.payload.id?.toLowerCase?.() !== id
      || sourceById.has(id)) throw new Error('Staged patient inventory is invalid');
    if (source.patient_id !== id || source.source_system !== 'legacy_identity'
      || source.source_record_id !== id || source.account_id !== source.payload.auth_user_id
      || source.hid_code !== source.payload.hid_code || !source.assurance_state) {
      throw new Error('Promoted patient identity does not match staged source');
    }
    sourceById.set(id, source);
  }
  if (input.patients.length !== sourceById.size) throw new Error('Attestation does not cover every staged patient');

  const seenPatients = new Set();
  const seenNins = new Set();
  const entries = [];
  for (const record of input.patients) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.patientId !== 'string' || !UUID.test(record.patientId)) {
      throw new Error('Invalid attested patient identity');
    }
    const patientId = record.patientId.toLowerCase();
    const source = sourceById.get(patientId);
    if (!source || seenPatients.has(patientId)) throw new Error('Attestation patient is absent or duplicated');
    seenPatients.add(patientId);
    requireText(record.evidenceReference, 8, 500, 'patient evidence reference');
    let ninLookupHmac = null;
    let ninState;
    if (record.ninStatus === 'exact') {
      if (typeof record.nin !== 'string' || !NIN.test(record.nin)) {
        throw new Error('Exact source NIN must contain 11 digits');
      }
      if (source.payload.nin_last4 && source.payload.nin_last4 !== record.nin.slice(-4)) {
        throw new Error('Exact source NIN conflicts with staged source evidence');
      }
      ninLookupHmac = createHmac('sha256', lookupKey).update(record.nin, 'utf8').digest('hex');
      if (seenNins.has(ninLookupHmac)) throw new Error('Exact source NIN is assigned to multiple patients');
      seenNins.add(ninLookupHmac);
      const governedPatient = governedBindings.get(ninLookupHmac);
      if (governedPatient && governedPatient !== patientId) {
        throw new Error('Exact source NIN conflicts with a governed patient identifier');
      }
      ninState = 'attested_exact';
    } else if (record.ninStatus === 'absent') {
      if ('nin' in record || sourceHasOpaqueNin(source.payload)) {
        throw new Error('NIN absence conflicts with source NIN evidence');
      }
      ninState = 'attested_absent';
    } else {
      throw new Error('Patient NIN disposition must be exact or absent');
    }
    entries.push({ patientId, sourceRowSha256: String(source.payload_sha256).trim(),
      ninState, ninLookupHmac, evidenceReference: record.evidenceReference });
  }
  entries.sort((left, right) => left.patientId.localeCompare(right.patientId));
  const inventorySha256 = createHash('sha256').update(entries.map((entry) => [
    entry.patientId, entry.sourceRowSha256, entry.ninState, entry.ninLookupHmac ?? '',
  ].join('\u001f')).join('\n'), 'utf8').digest('hex');
  return {
    entries, inventorySha256, attestedAt,
    patientCount: entries.length,
    exactNinCount: entries.filter((entry) => entry.ninState === 'attested_exact').length,
    absentNinCount: entries.filter((entry) => entry.ninState === 'attested_absent').length,
  };
}

function parseArguments(argv) {
  const allowed = argv.filter((arg) => arg === '--apply' || arg === '--dry-run');
  if (allowed.length !== argv.length || allowed.length > 1) throw new Error('Use --apply or --dry-run only');
  return allowed.includes('--apply');
}

async function main() {
  const apply = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  const inputPath = process.env.LEGACY_NIN_ATTESTATION_PATH;
  const runId = process.env.MIGRATION_RUN_ID;
  const operator = process.env.MIGRATION_OPERATOR;
  if (!databaseUrl || !inputPath || !runId || !operator) {
    throw new Error('DATABASE_URL, LEGACY_NIN_ATTESTATION_PATH, MIGRATION_RUN_ID and MIGRATION_OPERATOR are required');
  }
  if (!UUID.test(runId)) throw new Error('Invalid migration run ID');
  const lookupKey = requireKey(process.env.NIN_LOOKUP_HMAC_KEY_B64);
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  if (input.runId?.toLowerCase?.() !== runId.toLowerCase()
    || input.attestedBy !== operator) throw new Error('Attestation does not match migration run/operator');

  const client = new Client(databaseOptions(databaseUrl, 'hid-legacy-nin-crosswalk'));
  await client.connect();
  try {
    await client.query('begin isolation level serializable');
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-legacy-nin-crosswalk', 0))");
    const run = (await client.query(`select id, source_system, source_snapshot, source_checksum_sha256,
        mode, status from migration.runs where id = $1 for share`, [runId])).rows[0];
    if (!run || run.source_system !== 'legacy_identity'
      || !['reconcile', 'cutover'].includes(run.mode)
      || !['verified', 'completed'].includes(run.status)
      || run.source_snapshot !== input.sourceSnapshot
      || String(run.source_checksum_sha256).trim() !== input.sourceChecksumSha256) {
      throw new Error('Attestation requires the exact verified legacy migration run');
    }
    const sourceRows = (await client.query(`select source.source_pk, source.payload, source.payload_sha256,
        patient.id as patient_id, patient.account_id, patient.hid_code,
        patient.source_system, patient.source_record_id, assurance.state as assurance_state
      from migration.source_rows source
      left join identity.patients patient on patient.id::text = source.source_pk
      left join identity.patient_assurance_states assurance on assurance.patient_id = patient.id
      where source.run_id = $1 and source.entity_type = 'patients'
      order by source.source_pk for share of source`, [runId])).rows;
    const governed = (await client.query(`select patient_id, lookup_hmac
      from identity.patient_identifiers where identifier_type = 'nin'
        and lookup_hmac is not null for share`)).rows;
    const bindings = new Map();
    for (const row of governed) {
      const digest = String(row.lookup_hmac).trim();
      const prior = bindings.get(digest);
      if (prior && prior !== row.patient_id) throw new Error('Governed NIN identifiers conflict');
      bindings.set(digest, row.patient_id);
    }
    const inventory = prepareLegacyNinInventory(input, sourceRows, bindings, lookupKey);
    const otherActive = (await client.query(`select patient_id, nin_lookup_hmac
      from migration.legacy_nin_crosswalk
      where run_id <> $1 and status = 'active' for share`, [runId])).rows;
    const otherPatients = new Set(otherActive.map((row) => row.patient_id));
    const otherNins = new Set(otherActive.filter((row) => row.nin_lookup_hmac)
      .map((row) => String(row.nin_lookup_hmac).trim()));
    if (inventory.entries.some((entry) => otherPatients.has(entry.patientId)
      || (entry.ninLookupHmac && otherNins.has(entry.ninLookupHmac)))) {
      throw new Error('Active source NIN inventory conflicts with another verified run');
    }
    const existing = (await client.query(`select patient_id, source_row_sha256, nin_state,
        nin_lookup_hmac, source_snapshot, evidence_reference, attested_by, attested_at
      from migration.legacy_nin_crosswalk where run_id = $1 and status = 'active'
      order by patient_id for update`, [runId])).rows;
    const attestation = (await client.query(`select * from migration.legacy_nin_crosswalk_attestations
      where run_id = $1 and status = 'active' for update`, [runId])).rows;
    if ((existing.length > 0 || attestation.length > 0)
      && (existing.length !== inventory.patientCount || attestation.length !== 1
        || String(attestation[0].inventory_sha256).trim() !== inventory.inventorySha256
        || attestation[0].evidence_reference !== input.evidenceReference
        || attestation[0].attested_by !== input.attestedBy
        || new Date(attestation[0].attested_at).valueOf() !== inventory.attestedAt.valueOf()
        || existing.some((row, index) => {
          const expected = inventory.entries[index];
          return row.patient_id !== expected.patientId
            || String(row.source_row_sha256).trim() !== expected.sourceRowSha256
            || row.nin_state !== expected.ninState
            || (row.nin_lookup_hmac ? String(row.nin_lookup_hmac).trim() : null) !== expected.ninLookupHmac
            || row.source_snapshot !== input.sourceSnapshot
            || row.evidence_reference !== expected.evidenceReference
            || row.attested_by !== input.attestedBy
            || new Date(row.attested_at).valueOf() !== inventory.attestedAt.valueOf();
        }))) throw new Error('Existing NIN attestation differs from this inventory');

    if (existing.length === 0 && attestation.length === 0 && apply) {
      for (const entry of inventory.entries) {
        await client.query(`insert into migration.legacy_nin_crosswalk
          (run_id,patient_id,source_row_sha256,nin_state,nin_lookup_hmac,
           source_snapshot,evidence_reference,attested_by,attested_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
          runId, entry.patientId, entry.sourceRowSha256, entry.ninState,
          entry.ninLookupHmac, input.sourceSnapshot, entry.evidenceReference,
          input.attestedBy, inventory.attestedAt,
        ]);
      }
      await client.query(`insert into migration.legacy_nin_crosswalk_attestations
        (run_id,source_snapshot,source_checksum_sha256,patient_count,
         exact_nin_count,absent_nin_count,inventory_sha256,evidence_reference,
         attested_by,attested_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        runId, input.sourceSnapshot, input.sourceChecksumSha256,
        inventory.patientCount, inventory.exactNinCount, inventory.absentNinCount,
        inventory.inventorySha256, input.evidenceReference, input.attestedBy,
        inventory.attestedAt,
      ]);
    }
    if (apply) await client.query('commit');
    else await client.query('rollback');
    process.stdout.write(`${apply ? 'Applied' : 'Dry-run verified'} complete legacy NIN inventory: ${inventory.patientCount} patients, ${inventory.exactNinCount} exact source associations, ${inventory.absentNinCount} attested absent; run ${runId}.\n`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Legacy NIN crosswalk blocked: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
