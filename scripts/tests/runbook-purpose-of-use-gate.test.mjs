// docs/MIGRATION_RUNBOOK.md §5 tells operators, before a real source read, how
// the purpose-of-use vocabulary reaches the database: which codes migrations
// seed and which an operator inserts by a reviewed change. When 0097 (break-glass
// at launch, D9) began seeding `emergency`, the gate still said that operators
// insert `emergency` by hand and that it stays absent. An operator who did so
// before 0097 keeps a row 0097 then leaves as it is (ON CONFLICT DO NOTHING),
// whatever its display, source or `active`; an inactive one keeps break-glass
// refused (release checklist P10).
//
// These checks hold the gate to the migrations: every code a migration seeds
// is named in the gate with the migration that seeds it, and no sentence of the
// gate tells operators to insert that code by a reviewed change or says that it
// stays absent.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const migrationDirectory = join(repository, 'services/ehr-api/database/migrations');
const runbook = readFileSync(join(repository, 'docs/MIGRATION_RUNBOOK.md'), 'utf8');

/** Each purpose-of-use code a migration inserts, with the first migration that inserts it. */
const seeded = new Map();
for (const name of readdirSync(migrationDirectory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
  const sql = readFileSync(join(migrationDirectory, name), 'utf8')
    .replace(/--[^\n]*/g, '');
  for (const insert of sql.matchAll(/insert\s+into\s+identity\.purpose_of_use_codes\s*\([^)]*\)\s*values\s*([\s\S]*?);/gi)) {
    for (const row of insert[1].matchAll(/\(\s*'([^']+)'/g)) {
      if (!seeded.has(row[1])) seeded.set(row[1], name.slice(0, 4));
    }
  }
}

/** The §5 bullet that approves the purpose-of-use vocabulary, as one line of text. */
function vocabularyGate(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^- approve the purpose-of-use vocabulary\b/.test(line));
  assert.notEqual(start, -1, 'MIGRATION_RUNBOOK.md §5 needs its "approve the purpose-of-use vocabulary" gate');
  const item = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    item.push(line.trim());
  }
  return item.join(' ').replace(/\s+/g, ' ');
}

const gate = vocabularyGate(runbook);
/** Sentences of the gate; a semicolon inside a sentence does not end it. */
const sentences = gate.split(/(?<=\.)\s+(?=[A-Z`])/);
const names = (sentence, code) => sentence.includes(`\`${code}\``);

test('the check finds the purpose-of-use codes the migrations seed', () => {
  assert.equal(seeded.get('direct-care'), '0082');
  assert.equal(seeded.get('emergency'), '0097');
});

test('the runbook gate names every seeded code with the migration that seeds it', () => {
  const unnamed = [...seeded].filter(([code, migration]) => !sentences.some((sentence) =>
    names(sentence, code) && sentence.includes(migration) && /\bseeds\b/.test(sentence)));
  assert.deepEqual(unnamed.map(([code, migration]) => `${code} (${migration})`), [],
    'MIGRATION_RUNBOOK.md §5 must say which migration seeds each purpose-of-use code');
});

test('the runbook gate tells operators to insert by hand only codes no migration seeds', () => {
  const handInserted = sentences
    .filter((sentence) => /\binsert\b/i.test(sentence) && /\breviewed change\b/i.test(sentence))
    .flatMap((sentence) => [...seeded.keys()].filter((code) => names(sentence, code)));
  assert.deepEqual(handInserted, [],
    'MIGRATION_RUNBOOK.md §5 tells operators to insert a code by a reviewed change that a migration seeds');
});

test('the runbook gate does not say that a seeded code stays absent', () => {
  const absent = sentences.flatMap((sentence) => [...seeded.keys()].filter((code) => names(sentence, code)
    && /\b(?:stays|remains|is|are) (?:absent|unseeded|not seeded)\b/i.test(sentence)));
  assert.deepEqual(absent, [], 'MIGRATION_RUNBOOK.md §5 says a code that a migration seeds stays absent');
});
