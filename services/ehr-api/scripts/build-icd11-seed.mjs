#!/usr/bin/env node
// ORD-9: the ICD-11 diagnosis list's seed (icd11-seed.mjs says how), from
// WHO's release file and ocr-worker's DIAGNOSIS_SYNONYMS. Writes <out>, or
// with --check compares it with the file already there. Prints the seed's
// sha256 (what the clinical lead signs in docs/codes/catalog-approvals.json)
// and the release file's.
//
//   node scripts/build-icd11-seed.mjs --zip SimpleTabulation-ICD-11-MMS-en.zip --release 2026-01
//     --synonyms ../ocr-worker/src/reading/diagnosis-list.ts --out <icd11-mms-2026-01.json> [--check]
//
// The release file is WHO's (https://icdcdn.who.int/static/releasefiles/<release>/
// SimpleTabulation-ICD-11-MMS-en.zip). It is read, never committed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { seedProblems, seedText, sha256 } from './catalog-seed.mjs';
import { buildIcd11Seed, otherNamesFrom, parseTabulation, TABULATION_MEMBER, zipMember } from './icd11-seed.mjs';

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) { console.error(`--${name} is required`); process.exit(2); }
  return value;
};
const zipPath = option('zip');
const zipBytes = readFileSync(zipPath);
const rows = parseTabulation(zipMember(zipBytes, TABULATION_MEMBER).toString('utf8'));
const seed = buildIcd11Seed(rows, {
  release: option('release'),
  releaseFile: { name: basename(zipPath), sha256: sha256(zipBytes) },
  otherNames: otherNamesFrom(readFileSync(option('synonyms'), 'utf8')),
});
const problems = seedProblems(seed);
if (problems.length > 0) { console.error(problems.slice(0, 20).join('\n')); process.exit(1); }
const text = seedText(seed);
const out = option('out');
if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== text) {
    console.error(`${out} is not what the release file makes: run without --check`);
    process.exit(1);
  }
} else {
  writeFileSync(out, text);
}
console.log(JSON.stringify({ seed: out, sha256: sha256(Buffer.from(text)), items: seed.items.length,
  withOtherNames: seed.items.filter((item) => item.otherNames.length > 0).length, releaseFile: seed.release }));
