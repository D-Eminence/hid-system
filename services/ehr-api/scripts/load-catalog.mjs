#!/usr/bin/env node
// ORD-7: the governed loader of the national medicine and lab-test lists
// (planned contract, "Who keeps the lists"). The release integrator runs it
// after the migrations, never inside one, as the schema owner (the same
// connection as apply-migrations.mjs):
//
//   DATABASE_URL=... node scripts/load-catalog.mjs --seed <hid-medicines.json|hid-lab-tests.json>
//     [--approvals ../../docs/codes/catalog-approvals.json] [--dry-run]
//
// It refuses (exit 2, nothing written):
// - a seed file whose sha256 is not signed off in the approvals file for the
//   seed's kind and version (Q124 A: the clinical lead approves every change);
// - a seed that breaks 0149's rules (catalog-seed.mjs's seedProblems);
// - a version of that kind that is already loaded;
// - a schema without 0149.
// The database refuses on its own, and the whole load rolls back, a retired
// id, an id whose medicine or test changed, or a lab code another id held
// (0149's insert triggers).
//
// In one transaction: this loader's advisory lock; SHARE ROW EXCLUSIVE on
// ehr.catalog_versions (so two loaders cannot both switch, while searches go
// on reading); the new retired ids; the version row (inactive); its rows;
// then the old active version off and the new one on. A search sees the old
// list or the new one, never neither. --dry-run does all of it and rolls
// back. Old versions are kept, so old prescriptions keep their meaning.
// Prints one JSON line: what was loaded and which version it replaced.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { approvalFor, seedProblems, sha256 } from './catalog-seed.mjs';
import { databaseOptions, managedDatabaseUrl } from './database-options.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
/** A refusal that leaves nothing written (exit 2), as against a failure (exit 1). */
class LoadRefusal extends Error {}
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const refuse = (message) => {
  console.error(`load-catalog: ${message}; nothing loaded`);
  process.exit(2);
};

const seedPath = option('seed') ?? refuse('--seed is required');
const approvalsPath = option('approvals') ?? path.resolve(scriptDirectory, '../../../docs/codes/catalog-approvals.json');
const dryRun = process.argv.includes('--dry-run');
const databaseUrl = process.env.DATABASE_URL || managedDatabaseUrl();
if (!databaseUrl) refuse('set DATABASE_URL or DATABASE_HOST, DATABASE_USERNAME and DATABASE_PASSWORD');

const bytes = readFileSync(seedPath);
const fileSha256 = sha256(bytes);
let seed;
try {
  seed = JSON.parse(bytes.toString('utf8'));
} catch {
  refuse(`${seedPath} is not JSON`);
}
const problems = seedProblems(seed);
if (problems.length > 0) refuse(`${seedPath}: ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? ' …' : ''}`);
const approval = approvalFor(JSON.parse(readFileSync(approvalsPath, 'utf8')),
  { kind: seed.kind, version: seed.version, fileSha256 });
if (approval.problem) refuse(approval.problem);

const MEDICINES_INSERT = `insert into ehr.catalog_medicines (version_id, list_id, generic_name, other_names, strength,
    dose_form, dose_form_text, routes, atc_code, common_adult_dose, source, source_section, source_list, withdrawn)
  select $1, item."listId", item."genericName", array_to_string(array(select jsonb_array_elements_text(item."otherNames")), '; '),
         item.strength, item."doseForm", item."doseFormText", array(select jsonb_array_elements_text(item.routes)),
         item."atcCode", item."commonAdultDose", item.source, item."sourceSection", item."sourceList", item.withdrawn
    from jsonb_to_recordset($2::jsonb) as item("listId" text, "genericName" text, "otherNames" jsonb, strength text,
      "doseForm" text, "doseFormText" text, routes jsonb, "atcCode" text, "commonAdultDose" text, source text,
      "sourceSection" text, "sourceList" text, withdrawn boolean)`;
const LAB_TESTS_INSERT = `insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display,
    other_names, specimen, category, source, withdrawn)
  select $1, item."listId", item."codeSystem", item.code, item.display,
         array_to_string(array(select jsonb_array_elements_text(item."otherNames")), '; '), item.specimen, item.category,
         item.source, item.withdrawn
    from jsonb_to_recordset($2::jsonb) as item("listId" text, "codeSystem" text, code text, display text,
      "otherNames" jsonb, specimen text, category text, source text, withdrawn boolean)`;

const client = new pg.Client(databaseOptions(databaseUrl, 'hid-catalog-loader'));
await client.connect();
let outcome;
try {
  await client.query('begin');
  await client.query("set local lock_timeout = '5s'");
  await client.query("select pg_advisory_xact_lock(hashtextextended('hid-catalog-loader', 0))");
  const present = await client.query(`select to_regclass('ehr.catalog_versions') is not null
      and to_regclass('ehr.catalog_retired_codes') is not null as ready`);
  if (!present.rows[0].ready) throw new LoadRefusal('this schema has no catalogue tables (0149 is not applied)');
  await client.query('lock table ehr.catalog_versions in share row exclusive mode');
  const loaded = await client.query('select 1 from ehr.catalog_versions where kind = $1 and version = $2',
    [seed.kind, seed.version]);
  if (loaded.rowCount > 0) throw new LoadRefusal(`${seed.kind} ${seed.version} is already loaded`);
  const retired = await client.query(`insert into ehr.catalog_retired_codes (kind, list_id, reason)
      select $1, entry."listId", entry.reason from jsonb_to_recordset($2::jsonb) as entry("listId" text, reason text)
      on conflict (list_id) do nothing returning list_id`, [seed.kind, JSON.stringify(seed.retired)]);
  const versionId = randomUUID();
  await client.query(`insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference, approved_at,
      attribution) values ($1, $2, $3, $4, $5, $6, $7)`, [versionId, seed.kind, seed.version, fileSha256,
    approval.entry.approvalReference.trim(), approval.entry.approvedAt, seed.attribution]);
  const inserted = await client.query(seed.kind === 'medicine' ? MEDICINES_INSERT : LAB_TESTS_INSERT,
    [versionId, JSON.stringify(seed.items)]);
  if (inserted.rowCount !== seed.items.length) {
    throw new Error(`loaded ${inserted.rowCount} rows of ${seed.items.length}`);
  }
  const replaced = await client.query(`update ehr.catalog_versions set active = false
      where kind = $1 and active returning version`, [seed.kind]);
  await client.query('update ehr.catalog_versions set active = true, loaded_at = clock_timestamp() where id = $1',
    [versionId]);
  outcome = { status: dryRun ? 'dry-run: rolled back' : 'loaded', kind: seed.kind, version: seed.version, fileSha256,
    items: inserted.rowCount, newRetiredIds: retired.rows.map((row) => row.list_id),
    replaced: replaced.rows[0]?.version ?? null, heldBack: (seed.heldBack ?? []).length };
  await client.query(dryRun ? 'rollback' : 'commit');
} catch (error) {
  await client.query('rollback').catch(() => {});
  await client.end().catch(() => {});
  if (error instanceof LoadRefusal) refuse(error.message);
  const code = error?.code ? ` (${error.code})` : '';
  console.error(`load-catalog: ${error?.message ?? error}${code}; nothing loaded`);
  process.exit(1);
}
await client.end();
console.log(JSON.stringify(outcome));
