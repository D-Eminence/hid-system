#!/usr/bin/env node
// Read-only fixture verification: print only counts and source checksums.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256, prepareStagingAdditions } from './staging-cutover-additions.mjs';
const [fixturePath, metadataPath] = process.argv.slice(2);
if (!fixturePath || !metadataPath) throw new Error('Fixture and sealed metadata paths are required');
const bytes = await readFile(fixturePath);
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256 || bytes.length !== metadata.size_bytes) {
  throw new Error('Fixture file does not match its sealed S3 metadata');
}
const fixture = JSON.parse(bytes.toString('utf8'));
if (fixture._metadata?.overall_checksum !== metadata.overall_checksum
  || fixture._metadata?.source_transaction_snapshot !== metadata.source_transaction_snapshot) {
  throw new Error('Embedded source transaction evidence differs from sealed metadata');
}
const rows = Object.entries(fixture).filter(([type]) => type !== '_metadata').flatMap(([entity_type, collection]) => collection.map(row => ({
  ...row, entity_type, payload_sha256: sha256(canonicalJson(row.payload)),
})));
const data = prepareStagingAdditions(rows, { sourceCounts: metadata.counts, sourceChecksum: metadata.overall_checksum }, metadata.overall_checksum);
process.stdout.write(JSON.stringify({ status: 'passed', snapshot_id: metadata.snapshot_id,
  patient_access_pins: data.pins.length, google_mapping_checks: data.google.length,
  retained_categories: Object.keys(data.counts).length, source_checksum: data.sourceChecksum,
  operational_outreach_rows_promoted: 0, database_mutated: false }) + '\n');
