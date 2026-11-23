#!/usr/bin/env node
// ORD-7: the two seed files from the combined list (catalog-seed.mjs says
// how). Writes <out>/hid-medicines.json and <out>/hid-lab-tests.json, or with
// --check compares them with the files already there and fails on any
// difference. Prints each file's sha256, the number the clinical lead signs
// (docs/codes/catalog-approvals.json), and what the lead signs with it: what
// was held back and why, how each Wave 0 code stands (kept ones included),
// and every brand name that did not map to a medicine.
//
//   node scripts/build-catalog-seeds.mjs --csv <combined list> --retired <retired ids JSON>
//     --wave-zero <hid-lab-codes.json> --version 2026.1 --out <directory> [--check]
//     [--brands <brand-names.ts>] [--with-atc [--approvals <catalog-approvals.json>]]
//
// The retired ids file maps each retired id to why ({"MED-01375": "..."}).
// --brands defaults to ocr-worker's brand-names.ts (read with Node 22's own
// TypeScript type stripping); its active rows become other names by
// catalog-seed.mjs's addBrandNames rule.
// atcCode is null unless --with-atc is given, which is refused (exit 2) until
// the approvals file (default docs/codes/catalog-approvals.json) records the
// WHOCC terms answer on a medicine entry of this version.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSeeds, parseCsv, seedProblems, seedText, sha256, withAtcProblem } from './catalog-seed.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const stop = (message) => { console.error(message); process.exit(2); };
const required = (name) => option(name) || stop(`--${name} is required`);

const version = required('version');
const withAtc = process.argv.includes('--with-atc');
if (withAtc) {
  const approvalsPath = option('approvals') ?? join(repository, 'docs/codes/catalog-approvals.json');
  let approvals;
  try {
    approvals = JSON.parse(readFileSync(approvalsPath, 'utf8'));
  } catch {
    stop(`the approvals file ${approvalsPath} cannot be read as JSON; nothing built`);
  }
  const problem = withAtcProblem(approvals, version);
  if (problem) stop(`${problem}; nothing built`);
}
const brandsModule = await import(pathToFileURL(option('brands') ?? join(repository,
  'services/ocr-worker/src/reading/brand-names.ts')).href);
const brands = brandsModule.BRAND_ROWS.filter(brandsModule.isActiveBrandRow)
  .map(({ brand, generic }) => ({ brand, generic }));

const rows = parseCsv(readFileSync(required('csv'), 'utf8'));
const retired = JSON.parse(readFileSync(required('retired'), 'utf8'));
const waveZero = JSON.parse(readFileSync(required('wave-zero'), 'utf8')).codes;
const seeds = buildSeeds(rows, { version, retired, waveZero, withAtc, brands });
const out = required('out');
const check = process.argv.includes('--check');
let failed = false;
const summary = {};
for (const [kind, file] of [['medicine', 'hid-medicines.json'], ['lab_test', 'hid-lab-tests.json']]) {
  const seed = seeds[kind];
  const problems = seedProblems(seed, { waveZero });
  if (problems.length > 0) { console.error(`${file}: ${problems.join('; ')}`); failed = true; continue; }
  const text = seedText(seed);
  const path = join(out, file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
      console.error(`${path} is not what the combined list makes: run without --check`);
      failed = true;
    }
  } else {
    writeFileSync(path, text);
  }
  summary[file] = { sha256: sha256(Buffer.from(text)), items: seed.items.length, heldBack: seed.heldBack,
    retired: seed.retired.length };
  if (kind === 'medicine') {
    summary[file].atcCodes = seed.items.filter((item) => item.atcCode !== null).length;
    summary[file].brands = { added: seeds.brands.added, onItems: seeds.brands.items, notMapped: seeds.brands.notMapped };
  } else {
    // Every Wave 0 code, kept ones included, by how it stands ("EUCR as LAB-0113").
    const stand = (entry) => `${entry.code}${entry.listId ? ` as ${entry.listId}` : ''}`
      + `${entry.now ? ` (now ${entry.now.codeSystem} ${entry.now.code})` : ''}`;
    summary[file].waveZero = Object.fromEntries(['kept', 'renamed', 'recoded', 'held back', 'missing']
      .map((status) => [status, seed.waveZero.filter((entry) => entry.status === status).map(stand)])
      .filter(([, codes]) => codes.length > 0));
  }
}
console.log(JSON.stringify(summary, null, 2));
process.exit(failed ? 1 : 0);
