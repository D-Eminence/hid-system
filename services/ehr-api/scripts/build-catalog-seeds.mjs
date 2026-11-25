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
// Everything it reads goes through one plain line: a file that cannot be
// read or is not JSON, a broken CSV (an unclosed quote, a row with the wrong
// number of fields), a list the builder cannot make into seeds (an id gap
// with no reason, a retired id that is still a row, or one whose row it
// holds back: "fix the row, do not retire it"), or a seed that would not
// load (an HID-LAB code that is not Wave 0's) stops it with one line, exit 2,
// nothing built. Both seeds are built and checked in memory first and
// written only when both are good, each under a temporary name and then
// renamed into place, so a bad lab-test list never leaves a new medicine
// file behind. A write that fails is one line too (exit 1), and the files
// that were there stay as they were.
// --brands defaults to ocr-worker's brand-names.ts, read with Node's own
// TypeScript type stripping (on by default from Node 22.18: an older Node is
// refused first, exit 2). Only its confirmed rows (CONFIRMED_BRAND_REVIEWS;
// a row pending a pharmacist's review is left out) become other names, by
// catalog-seed.mjs's addBrandNames rule.
// atcCode is null unless --with-atc is given, which is refused (exit 2) until
// the approvals file (default docs/codes/catalog-approvals.json) records the
// WHOCC terms answer on a medicine entry of this version.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const FILES = [['medicine', 'hid-medicines.json'], ['lab_test', 'hid-lab-tests.json']];
// One line, whatever the message holds.
const oneLine = (text) => String(text).replace(/\s*\n\s*/g, ' ');
function readText(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${what} ${path} cannot be read (${error?.code ?? 'unreadable'})`);
  }
}
function readJson(path, what) {
  const text = readText(path, what);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} ${path} is not JSON`);
  }
}

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
let seeds;
try {
  // Everything the builder reads (the brand names, the combined list, the retired ids, the Wave 0 codes) and makes
  // of it is inside this one-line handling: a file that cannot be read, a broken CSV (an unclosed quote), a list it
  // cannot make into seeds, or a seed that would not load, each stops it with one plain line, exit 2, nothing built.
  const brandsPath = option('brands') ?? join(repository, 'services/ocr-worker/src/reading/brand-names.ts');
  let brandsModule;
  try {
    brandsModule = await import(pathToFileURL(brandsPath).href);
  } catch (error) {
    const why = error?.code ?? oneLine(error?.message ?? error);
    throw new Error(`the brand names file ${brandsPath} cannot be read (${why})`);
  }
  if (!Array.isArray(brandsModule.BRAND_ROWS) || typeof brandsModule.isActiveBrandRow !== 'function') {
    throw new Error(`the brand names file ${brandsPath} has no BRAND_ROWS and isActiveBrandRow`);
  }
  // Every row, with its review status and whether the file uses it: addBrandNames adds the confirmed ones and
  // reports the rest.
  const brands = brandsModule.BRAND_ROWS.map((row) => ({ brand: row.brand, generic: row.generic, reviewedBy: row.reviewed_by,
    active: brandsModule.isActiveBrandRow(row) }));
  const csvPath = required('csv');
  const csvText = readText(csvPath, 'the combined list');
  let rows;
  try {
    rows = parseCsv(csvText);
  } catch (error) {
    throw new Error(`the combined list ${csvPath}: ${error.message}`);
  }
  // The columns every row is read by (a medicine's dose form, a test's category), so none is read as missing.
  const needed = ['id', 'list', 'name', 'source', ...(rows.some((row) => row.list === 'medicine') ? ['dose_form'] : []),
    ...(rows.some((row) => row.list === 'lab-test') ? ['category'] : [])];
  const missing = rows.length === 0 ? [] : needed.filter((column) => !(column in rows[0]));
  if (missing.length > 0) {
    throw new Error(`the combined list ${csvPath} has no ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}`);
  }
  const retiredPath = required('retired');
  const retired = readJson(retiredPath, 'the retired ids file');
  if (retired === null || typeof retired !== 'object' || Array.isArray(retired)) {
    throw new Error(`the retired ids file ${retiredPath} is not an object of retired ids, each with why`);
  }
  const waveZeroPath = required('wave-zero');
  const waveZero = readJson(waveZeroPath, 'the Wave 0 codes file')?.codes;
  if (!Array.isArray(waveZero)
      || !waveZero.every((entry) => typeof entry?.code === 'string' && typeof entry?.display === 'string')) {
    throw new Error(`the Wave 0 codes file ${waveZeroPath} has no list of codes, each with its name`);
  }
  seeds = buildSeeds(rows, { version, retired, waveZero, withAtc, brands });
  // Both seeds are checked before either is written: a list that makes one good seed and one bad one writes neither.
  const problems = FILES.flatMap(([kind, file]) => {
    const found = seedProblems(seeds[kind], { waveZero });
    return found.length > 0 ? [`${file}: ${found.join('; ')}`] : [];
  });
  if (problems.length > 0) throw new Error(problems.join('; '));
} catch (error) {
  stop(`${oneLine(error?.message ?? error)}; nothing built`);
}
const out = required('out');
const check = process.argv.includes('--check');
const texts = FILES.map(([kind, file]) => [kind, file, seedText(seeds[kind])]);
let failed = false;
if (check) {
  for (const [, file, text] of texts) {
    const path = join(out, file);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
      console.error(`${path} is not what the combined list makes: run without --check`);
      failed = true;
    }
  }
} else {
  // Both files are written in full under temporary names next to the seeds, then renamed into place, so a write that
  // fails leaves the seeds that were there before (and no temporary file) behind.
  const written = [];
  const renamed = [];
  try {
    for (const [, file, text] of texts) {
      const temporary = join(out, `.${file}.${process.pid}.tmp`);
      written.push([temporary, file]);
      writeFileSync(temporary, text);
    }
    for (const [temporary, file] of written) {
      renameSync(temporary, join(out, file));
      renamed.push(file);
    }
  } catch (error) {
    for (const [temporary] of written) {
      try { rmSync(temporary, { force: true }); } catch { /* the line below is what matters */ }
    }
    const why = error?.code ?? oneLine(error?.message ?? error);
    // Only a rename failing after the first one succeeded (in the same directory) leaves one file new: said so.
    console.error(renamed.length === 0 ? `the seed files could not be written to ${out} (${why}); nothing built`
      : `${renamed.join(', ')} was written to ${out} but the other seed file could not be (${why}); run the builder again`);
    process.exit(1);
  }
}
// The record of Ola's brand decision first, so the lead signs with it in view.
const summary = { brandDecision: BRAND_DECISION };
for (const [kind, file, text] of texts) {
  const seed = seeds[kind];
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
