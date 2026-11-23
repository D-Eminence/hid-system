#!/usr/bin/env node
// Generates services/ocr-worker/src/reading/drug-generics.generated.ts, the ocr-worker drug list's generic names,
// from the medicine rows of docs/codes/drafts/hid-medicines-and-lab-tests.csv. Node only, no dependencies.
//
//   node scripts/generate-ocr-drug-list.mjs           write the generated file
//   node scripts/generate-ocr-drug-list.mjs --check   exit 1 if the checked-in file does not match the CSV
//   node scripts/generate-ocr-drug-list.mjs --stdout  print the generated file (used by drug-generics.spec.ts)
//
// The worker never reads the CSV: it imports the generated file, and drug-generics.spec.ts runs this script to prove
// the checked-in file matches the CSV.
//
// Each distinct `name` of a row with `list` = `medicine` becomes one name, in lower case with single spaces and
// " + " between the parts of a fixed combination, kept whole as written ("amoxicillin + clavulanic acid"). A few
// CSV names hold a comma or brackets, which the worker's name matching would turn into spaces; each is rewritten
// once, readably, in CLEANED_NAMES below. Any other name with such a character stops the script with an error, so
// no name is ever dropped or changed silently.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CSV_PATH = join(ROOT, 'docs/codes/drafts/hid-medicines-and-lab-tests.csv');
export const OUTPUT_PATH = join(ROOT, 'services/ocr-worker/src/reading/drug-generics.generated.ts');

/** CSV names with a comma or brackets, and the readable name used for each. */
export const CLEANED_NAMES = {
  'charcoal, activated': 'activated charcoal',
  'cytisine (cytisinicline)': 'cytisine',
  'insulin (soluble)': 'soluble insulin',
  'poliomyelitis vaccine (inactivated)': 'inactivated poliomyelitis vaccine',
  'poliomyelitis vaccine (oral)': 'oral poliomyelitis vaccine',
  'potassium ferric hexacyanoferrate (ii)': 'potassium ferric hexacyanoferrate',
  'sodium lactate, compound solution': 'compound sodium lactate solution',
  'sunscreen, broad-spectrum': 'broad-spectrum sunscreen',
};

/** The characters a listed name may hold (the worker's normaliseDrugName keeps only these). */
const NAME_CHARACTERS = /^[a-z0-9][a-z0-9 +'-]*$/;

/** Rows of a CSV text (RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ''));
}

/** A CSV name in the list's form: lower case, single spaces, " + " between parts, cleaned where listed above. */
export function listName(csvName) {
  const plain = csvName.toLowerCase().replace(/\s*\+\s*/g, ' + ').replace(/\s+/g, ' ').trim();
  const name = CLEANED_NAMES[plain] ?? plain;
  if (!NAME_CHARACTERS.test(name)) {
    throw new Error(`Medicine name "${csvName}" holds a character the drug list cannot keep: add it to CLEANED_NAMES`);
  }
  return name;
}

/**
 * The distinct medicine names of the CSV, sorted, each with the first row id it comes from and the sources that
 * give it.
 */
export function medicineNames(csvText) {
  const [header, ...rows] = parseCsv(csvText);
  const column = (name) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`CSV has no "${name}" column`);
    return index;
  };
  const [idColumn, listColumn, nameColumn, sourceColumn] = ['id', 'list', 'name', 'source'].map(column);
  const byName = new Map();
  for (const cells of rows) {
    if (cells.length !== header.length) throw new Error(`CSV row ${cells[idColumn]} has ${cells.length} fields`);
    if (cells[listColumn] !== 'medicine') continue;
    const name = listName(cells[nameColumn]);
    const found = byName.get(name) ?? { name, firstId: cells[idColumn], sources: new Set() };
    found.sources.add(cells[sourceColumn]);
    byName.set(name, found);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, firstId, sources }) => ({ name, firstId, sources: [...sources].sort() }));
}

/** The generated TypeScript file for a CSV text. */
export function generate(csvText) {
  const names = medicineNames(csvText);
  const csvFile = relative(ROOT, CSV_PATH);
  const lines = [
    '// GENERATED FILE: do not edit by hand.',
    `// Generated by scripts/generate-ocr-drug-list.mjs from ${csvFile}`,
    '// (the distinct names of its medicine rows). To change it, change the CSV and run, at the repository root:',
    '//   node scripts/generate-ocr-drug-list.mjs',
    '// drug-generics.spec.ts fails when this file does not match the CSV. Each name is followed by the first CSV row',
    '// that gives it and the source list(s) it comes from.',
    '',
    `/** The ${names.length} generic medicine names of the CSV above (drug-list.ts says where they come from). */`,
    'export const GENERATED_DRUG_GENERICS: readonly string[] = [',
    ...names.map(({ name, firstId, sources }) => `  '${name.replace(/'/g, "\\'")}', // ${firstId} ${sources.join(' ')}`),
    '];',
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = generate(readFileSync(CSV_PATH, 'utf8'));
  const mode = process.argv[2];
  if (mode === '--stdout') process.stdout.write(output);
  else if (mode === '--check') {
    let current = '';
    try { current = readFileSync(OUTPUT_PATH, 'utf8'); } catch { current = ''; }
    if (current !== output) {
      console.error(`${relative(ROOT, OUTPUT_PATH)} does not match the CSV: run node scripts/generate-ocr-drug-list.mjs`);
      process.exit(1);
    }
  } else if (mode === undefined) {
    writeFileSync(OUTPUT_PATH, output);
    console.log(`Wrote ${relative(ROOT, OUTPUT_PATH)}`);
  } else {
    console.error('Usage: node scripts/generate-ocr-drug-list.mjs [--check | --stdout]');
    process.exit(2);
  }
}
