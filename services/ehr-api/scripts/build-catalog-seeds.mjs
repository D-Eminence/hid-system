#!/usr/bin/env node
// ORD-7: the two seed files from the combined list (catalog-seed.mjs says
// how). Writes <out>/hid-medicines.json and <out>/hid-lab-tests.json, or with
// --check compares them with the files already there and fails on any
// difference. Prints each file's sha256, the number the clinical lead signs
// (docs/codes/catalog-approvals.json), and what the lead signs with it: what
// was held back and why, how each Wave 0 code stands (kept ones included),
// every brand name added (brand -> generic) and every one left out, with why.
// The report opens with the record of Ola's brand decision (brandDecision:
// the 21 confirmed brands Ola checked as clinical owner on 23 Nov 2026; a
// brand pending a pharmacist's review stays out until a pharmacist confirms
// it).
//
//   node scripts/build-catalog-seeds.mjs --csv <combined list> --retired <retired ids JSON>
//     --wave-zero <hid-lab-codes.json> --version 2026.1 --out <directory> [--check]
//     [--brands <brand-names.ts>] [--with-atc [--approvals <catalog-approvals.json>]]
//
// The retired ids file maps each retired id to why ({"MED-01375": "..."}).
// A list the builder cannot make into seeds (an id gap with no reason, a
// retired id that is still a row, or one whose row it holds back: "fix the
// row, do not retire it") stops it with one plain line, exit 2, nothing built.
// --brands defaults to ocr-worker's brand-names.ts, read with Node's own
// TypeScript type stripping (on by default from Node 22.18: an older Node is
// refused first, exit 2). Only its confirmed rows (CONFIRMED_BRAND_REVIEWS;
// a row pending a pharmacist's review is left out) become other names, by
// catalog-seed.mjs's addBrandNames rule.
// atcCode is null unless --with-atc is given, which is refused (exit 2) until
// the approvals file (default docs/codes/catalog-approvals.json) records the
// WHOCC terms answer on a medicine entry of this version.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BRAND_DECISION, buildSeeds, parseCsv, seedProblems, seedText, sha256, typeStrippingProblem, withAtcProblem }
  from './catalog-seed.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const stop = (message) => { console.error(message); process.exit(2); };
const required = (name) => option(name) || stop(`--${name} is required`);

const nodeProblem = typeStrippingProblem(process.versions.node);
if (nodeProblem) stop(nodeProblem);

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
// Every row, with its review status and whether the file uses it: addBrandNames adds the confirmed ones and
// reports the rest.
const brands = brandsModule.BRAND_ROWS.map((row) => ({ brand: row.brand, generic: row.generic, reviewedBy: row.reviewed_by,
  active: brandsModule.isActiveBrandRow(row) }));

const rows = parseCsv(readFileSync(required('csv'), 'utf8'));
const retired = JSON.parse(readFileSync(required('retired'), 'utf8'));
const waveZero = JSON.parse(readFileSync(required('wave-zero'), 'utf8')).codes;
let seeds;
try {
  seeds = buildSeeds(rows, { version, retired, waveZero, withAtc, brands });
} catch (error) {
  stop(`${error.message}; nothing built`);
}
const out = required('out');
const check = process.argv.includes('--check');
let failed = false;
// The record of Ola's brand decision first, so the lead signs with it in view.
const summary = { brandDecision: BRAND_DECISION };
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
    // Every brand added (brand -> generic, on how many items) and every brand left out, with why.
    summary[file].brands = {
      added: seeds.brands.added.map(({ brand, generic, items }) => `${brand} -> ${generic} (${items} item${items === 1 ? '' : 's'})`),
      onItems: seeds.brands.items,
      leftOut: seeds.brands.leftOut.map(({ brand, generic, why }) => `${brand} -> ${generic}: ${why}`),
    };
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
