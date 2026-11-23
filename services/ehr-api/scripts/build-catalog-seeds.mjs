#!/usr/bin/env node
// ORD-7: the two seed files from the combined list (catalog-seed.mjs says
// how). Writes <out>/hid-medicines.json and <out>/hid-lab-tests.json, or with
// --check compares them with the files already there and fails on any
// difference. Prints each file's sha256, the number the clinical lead signs
// (docs/codes/catalog-approvals.json), and what was held back and why.
//
//   node scripts/build-catalog-seeds.mjs --csv <combined list> --retired <retired ids JSON>
//     --wave-zero <hid-lab-codes.json> --version 2026.1 --out <directory> [--check]
//
// The retired ids file maps each retired id to why ({"MED-01375": "..."}).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildSeeds, parseCsv, seedProblems, seedText, sha256 } from './catalog-seed.mjs';

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const required = (name) => {
  const value = option(name);
  if (!value) { console.error(`--${name} is required`); process.exit(2); }
  return value;
};

const rows = parseCsv(readFileSync(required('csv'), 'utf8'));
const retired = JSON.parse(readFileSync(required('retired'), 'utf8'));
const waveZero = JSON.parse(readFileSync(required('wave-zero'), 'utf8')).codes;
const seeds = buildSeeds(rows, { version: required('version'), retired, waveZero });
const out = required('out');
const check = process.argv.includes('--check');
let failed = false;
const summary = {};
for (const [kind, file] of [['medicine', 'hid-medicines.json'], ['lab_test', 'hid-lab-tests.json']]) {
  const seed = seeds[kind];
  const problems = seedProblems(seed);
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
    retired: seed.retired.length, ...(seed.waveZero ? { waveZero: seed.waveZero.filter((entry) => entry.status !== 'kept') } : {}) };
}
console.log(JSON.stringify(summary, null, 2));
process.exit(failed ? 1 : 0);
