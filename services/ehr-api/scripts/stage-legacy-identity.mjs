#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';

const { Client } = pg;
const sourceUrl = process.env.LEGACY_DATABASE_URL;
const fixturePath = process.env.MIGRATION_FIXTURE_PATH;
const targetUrl = process.env.DATABASE_URL;
const snapshotLabel = process.env.MIGRATION_SNAPSHOT_ID;
const operator = process.env.MIGRATION_OPERATOR;
const dryRun = process.argv.includes('--dry-run');
const batchSize = Number.parseInt(process.env.MIGRATION_BATCH_SIZE ?? '250', 10);
const runId = process.env.MIGRATION_RUN_ID ?? randomUUID();

if (!sourceUrl && !fixturePath) throw new Error('LEGACY_DATABASE_URL or MIGRATION_FIXTURE_PATH is required');
if (sourceUrl && fixturePath) throw new Error('Use either LEGACY_DATABASE_URL or MIGRATION_FIXTURE_PATH, not both');
if (!dryRun && !targetUrl) throw new Error('DATABASE_URL is required');
if (!snapshotLabel) throw new Error('MIGRATION_SNAPSHOT_ID is required and must identify the source backup/snapshot');
if (!operator) throw new Error('MIGRATION_OPERATOR is required');
if (!Number.isSafeInteger(batchSize) || batchSize < 10 || batchSize > 5_000) {
  throw new Error('MIGRATION_BATCH_SIZE must be between 10 and 5000');
}

// These rows have an approved AWS target and are promoted as canonical
// identity records. The cutover-only inputs below are deliberately separate:
// Google identities become exact external-identity links, PINs retain only a
// bcrypt envelope, and outreach rows remain preservation evidence.
export const OUTREACH_PRESERVATION_ENTITY_TYPES = Object.freeze([
  'outreach_campaigns',
  'outreach_workers',
  'outreach_encounters',
  'outreach_sync_queue',
  'outreach_referrals',
  'outreach_vaccinations',
  'outreach_mobile_lab_samples',
  'outreach_invites',
]);

const optionalFixtureEntityTypes = new Set([
  'google_identities',
  'patient_access_pins',
  ...OUTREACH_PRESERVATION_ENTITY_TYPES,
]);

const entities = [
  {
    type: 'accounts',
    sql: `
      select source_pk, payload, source_updated_at
      from (
        select user_row.id::text as source_pk,
               jsonb_build_object(
                 'id', user_row.id,
                 'email', user_row.email,
                 'encrypted_password', nullif(user_row.encrypted_password, ''),
                 'created_at', user_row.created_at,
                 'updated_at', user_row.updated_at,
                 'deleted_at', user_row.deleted_at,
                 'banned_until', user_row.banned_until,
                 'last_sign_in_at', user_row.last_sign_in_at,
                 'email_confirmed_at', user_row.email_confirmed_at,
                 'provider', user_row.raw_app_meta_data->>'provider'
               ) as payload,
               user_row.updated_at as source_updated_at
        from auth.users user_row
      ) source
      where source_pk > $1
      order by source_pk
      limit $2`,
  },
  {
    // `auth.identities.id` is the provider-identity record coordinate. Keep
    // only the fields required to prove its exact provider-to-account link;
    // do not copy provider email, tokens, or other metadata into the ledger.
    type: 'google_identities',
    sql: `
      select identity_row.id::text as source_pk,
             jsonb_build_object(
               'id', identity_row.id,
               'user_id', identity_row.user_id,
               'provider', identity_row.provider,
               'provider_id', identity_row.provider_id,
               'identity_data', jsonb_build_object('sub', identity_row.identity_data->>'sub'),
               'created_at', identity_row.created_at,
               'updated_at', identity_row.updated_at,
               'last_sign_in_at', identity_row.last_sign_in_at
             ) as payload,
             coalesce(identity_row.updated_at, identity_row.created_at, identity_row.last_sign_in_at)
               as source_updated_at
      from auth.identities identity_row
      where lower(identity_row.provider) = 'google'
        and identity_row.id::text > $1
      order by identity_row.id::text
      limit $2`,
  },
  {
    // The source table contains a bcrypt verifier, never a raw PIN. Select a
    // minimal envelope so no unrelated patient data enters the ledger.
    type: 'patient_access_pins',
    sql: `
      select secret_row.patient_id::text as source_pk,
             jsonb_build_object(
               'patient_id', secret_row.patient_id,
               'pin_hash', secret_row.access_pin_hash,
               'created_at', secret_row.created_at,
               'updated_at', secret_row.updated_at,
               'source_table', 'public.hid_patient_access_secrets'
             ) as payload,
             secret_row.updated_at as source_updated_at
      from public.hid_patient_access_secrets secret_row
      where secret_row.patient_id::text > $1
      order by secret_row.patient_id::text
      limit $2`,
  },
  tableEntity('user_profiles', 'public.hid_user_profiles'),
  tableEntity('organizations', 'public.hid_organizations'),
  tableEntity('facilities', 'public.hid_facilities'),
  tableEntity('patients', 'public.hid_patients'),
  tableEntity('patient_identifiers', 'public.hid_patient_identifiers', 'created_at'),
  tableEntity('staff', 'public.hid_staff_accounts'),
  tableEntity('memberships', 'public.hid_staff_memberships'),
  tableEntity('access_requests', 'public.hid_access_requests'),
  tableEntity('consent_grants', 'public.hid_access_grants'),
  {
    type: 'audit_events',
    sql: `
      select event_id::text as source_pk,
             to_jsonb(audit_row) as payload,
             created_at as source_updated_at
      from public.hid_audit_events audit_row
      where event_id::text > $1
      order by event_id::text
      limit $2`,
  },
  tableEntity('outreach_campaigns', 'public.hid_outreach_campaigns', 'created_at'),
  tableEntity('outreach_workers', 'public.hid_outreach_workers', 'created_at'),
  tableEntity('outreach_encounters', 'public.hid_outreach_encounters', 'created_at'),
  tableEntity('outreach_sync_queue', 'public.hid_sync_queue', 'created_at'),
  tableEntity('outreach_referrals', 'public.hid_outreach_referrals', 'created_at'),
  tableEntity('outreach_vaccinations', 'public.hid_vaccinations', 'administered_at'),
  tableEntity('outreach_mobile_lab_samples', 'public.hid_mobile_lab_samples', 'collected_at'),
  tableEntity('outreach_invites', 'public.hid_outreach_invites', 'created_at'),
];

export const MIGRATION_ENTITY_TYPES = Object.freeze(entities.map((entity) => entity.type));

function tableEntity(type, qualifiedTable, timestampColumn = 'updated_at') {
  return {
    type,
    sql: `
      select id::text as source_pk,
             to_jsonb(source_row) as payload,
             source_row.${timestampColumn} as source_updated_at
      from ${qualifiedTable} source_row
      where id::text > $1
      order by id::text
      limit $2`,
  };
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite value cannot be checksummed');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error(`Unsupported checksum value type: ${typeof value}`);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function stageBatch(target, entityType, rows) {
  await target.query('begin');
  try {
    for (const row of rows) {
      const payloadHash = sha256(canonicalJson(row.payload));
      const inserted = await target.query(
        `insert into migration.source_rows (
           run_id, entity_type, source_pk, payload, payload_sha256, source_updated_at
         ) values ($1, $2, $3, $4::jsonb, $5, $6)
         on conflict (run_id, entity_type, source_pk) do nothing
         returning source_pk`,
        [runId, entityType, row.source_pk, JSON.stringify(row.payload), payloadHash, row.source_updated_at],
      );
      if (inserted.rowCount === 0) {
        const existing = await target.query(
          `select payload_sha256
             from migration.source_rows
            where run_id = $1 and entity_type = $2 and source_pk = $3`,
          [runId, entityType, row.source_pk],
        );
        const existingHash = existing.rows[0]?.payload_sha256?.trim();
        if (existingHash !== payloadHash) {
          await target.query(
            `insert into migration.conflicts (
               run_id, entity_type, source_pk, conflict_type, source_sha256, target_sha256,
               details
             ) values ($1, $2, $3, 'staging_checksum_mismatch', $4, $5, $6::jsonb)
             on conflict (run_id, entity_type, source_pk, conflict_type) do nothing`,
            [runId, entityType, row.source_pk, payloadHash, existingHash ?? null, JSON.stringify({ stage: 'source_staging' })],
          );
          await target.query(
            `update migration.runs
                set status = 'blocked', notes = 'Staging checksum conflict'
              where id = $1 and status = 'running' and mode = 'stage'`,
            [runId],
          );
          await target.query('commit');
          throw new Error(`Staging conflict for ${entityType}/${row.source_pk}`);
        }
      }
    }
    await target.query('commit');
  } catch (error) {
    await target.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function main() {
  const fixture = fixturePath ? await loadMigrationFixture(fixturePath) : undefined;
  const source = fixture ? undefined : new Client(databaseOptions(sourceUrl, 'hid-legacy-reader', 'LEGACY_DATABASE'));
  const target = dryRun ? undefined : new Client(databaseOptions(targetUrl, 'hid-legacy-stager'));
  if (source) await source.connect();
  if (target) await target.connect();

  const counts = {};
  const checksums = {};
  let snapshot;
  let stageRunCreated = false;

  try {
    if (source) {
      await source.query('begin isolation level repeatable read read only');
      snapshot = (await source.query('select txid_current_snapshot()::text as snapshot')).rows[0]?.snapshot;
    } else {
      snapshot = `fixture:${sha256(canonicalJson(fixture))}`;
    }

    if (target) {
      const started = await target.query(
        `insert into migration.runs (
           id, source_system, source_snapshot, mode, status, started_by, source_transaction_snapshot
         ) values ($1, 'legacy_identity', $2, 'stage', 'running', $3, $4)
         on conflict (id) do nothing
         returning id`,
        [runId, snapshotLabel, operator, snapshot],
      );
      if (started.rowCount !== 1) {
        throw new Error('MIGRATION_RUN_ID is already in use; start a fresh staging run from a new controlled snapshot');
      }
      // A PostgreSQL repeatable-read snapshot belongs to this source
      // transaction. Never resume a partial run with a later transaction:
      // added/deleted source rows would otherwise make one ledger appear to
      // represent two different snapshots.
      stageRunCreated = true;
    }

    for (const entity of entities) {
      let cursor = '';
      let count = 0;
      const aggregate = createHash('sha256');
      for (;;) {
        const result = source
          ? await source.query(entity.sql, [cursor, batchSize])
          : { rows: fixtureRows(fixture, entity.type, cursor, batchSize) };
        if (result.rows.length === 0) break;
        for (const row of result.rows) {
          const rowHash = sha256(canonicalJson(row.payload));
          aggregate.update(`${row.source_pk}:${rowHash}\n`, 'utf8');
          cursor = row.source_pk;
          count += 1;
        }
        if (target) await stageBatch(target, entity.type, result.rows);
      }
      counts[entity.type] = count;
      checksums[entity.type] = aggregate.digest('hex');
      process.stdout.write(`${entity.type}: ${count} ${checksums[entity.type]}\n`);
    }

    const overallChecksum = sha256(canonicalJson({ counts, checksums }));
    if (target) {
      const completed = await target.query(
        `update migration.runs
            set status = 'staged', source_counts = $2::jsonb,
                source_checksum_sha256 = $3, notes = $4
          where id = $1 and status = 'running'`,
        [runId, JSON.stringify(counts), overallChecksum, `Entity checksums: ${JSON.stringify(checksums)}`],
      );
      if (completed.rowCount !== 1) {
        throw new Error('Staging run state changed before snapshot evidence could be sealed');
      }
    }
    if (source) await source.query('commit');
    process.stdout.write(`${dryRun ? 'Dry-run source scan' : `Staging run ${runId}`} complete: ${overallChecksum}\n`);
  } catch (error) {
    if (source) await source.query('rollback').catch(() => undefined);
    if (target && stageRunCreated) {
      await target.query(
        `update migration.runs
            set status = case when status = 'blocked' then status else 'failed' end,
                completed_at = case when status = 'blocked' then completed_at else clock_timestamp() end,
                notes = case when status = 'blocked' then notes else 'Staging failed; inspect restricted operational logs' end
          where id = $1 and status = 'running' and mode = 'stage'`,
        [runId],
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (source) await source.end();
    if (target) await target.end();
  }
}

export async function loadMigrationFixture(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('MIGRATION_FIXTURE_PATH must contain an entity-to-row object');
  }
  for (const entity of entities) {
    const rows = parsed[entity.type];
    // Existing synthetic identity fixtures predate controlled cutover inputs.
    // They remain usable only with an explicit empty optional category; the
    // cutover preflight independently refuses a real snapshot that omits its
    // required nonzero Google/PIN/outreach inventory.
    if (rows === undefined && optionalFixtureEntityTypes.has(entity.type)) {
      parsed[entity.type] = [];
    } else if (!Array.isArray(rows)) {
      throw new Error(`Fixture is missing ${entity.type} rows`);
    }
    const validatedRows = parsed[entity.type];
    let previous = '';
    for (const row of validatedRows) {
      if (!row || typeof row !== 'object' || typeof row.source_pk !== 'string'
          || !row.source_pk || row.source_pk <= previous
          || !row.payload || Array.isArray(row.payload) || typeof row.payload !== 'object') {
        throw new Error(`Fixture ${entity.type} rows must have unique sorted source_pk and object payload`);
      }
      previous = row.source_pk;
    }
  }
  return parsed;
}

function fixtureRows(fixture, entityType, cursor, limit) {
  return (fixture[entityType] ?? []).filter((row) => row.source_pk > cursor).slice(0, limit);
}

export function summarizeMigrationFixture(fixture) {
  const counts = {};
  const checksums = {};
  for (const entity of entities) {
    const aggregate = createHash('sha256');
    for (const row of fixture[entity.type] ?? []) {
      aggregate.update(`${row.source_pk}:${sha256(canonicalJson(row.payload))}\n`, 'utf8');
    }
    counts[entity.type] = (fixture[entity.type] ?? []).length;
    checksums[entity.type] = aggregate.digest('hex');
  }
  return { counts, checksums, overallChecksum: sha256(canonicalJson({ counts, checksums })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`Legacy staging failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
