// docs/DATABASE.md presents itself as the current database architecture, but
// its section on EHR records described a target model (a generic
// ehr.clinical_resource registry and typed tables including
// allergy_intolerance) that no migration creates (ALLERGY-1). The EHR records
// no allergies at all, and a reader could take the document to say it does.
//
// These checks hold the document to the migrations: a section that is not
// headed as a target model names only EHR relations a migration creates,
// names no allergy table, and lists exactly the EHR tables that exist; and the
// document says that allergies are not recorded.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const migrationDirectory = join(repository, 'services/ehr-api/database/migrations');
const document = readFileSync(join(repository, 'docs/DATABASE.md'), 'utf8');

const migrations = readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()
  .map((name) => readFileSync(join(migrationDirectory, name), 'utf8').toLowerCase()).join('\n');
const created = new Set([...migrations.matchAll(
  /create\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:table|view|materialized\s+view|function|type|index|sequence|trigger)\s+(?:if\s+not\s+exists\s+)?(ehr\.[a-z_][a-z0-9_]*)/g,
)].map((match) => match[1]));
const tables = new Set([...migrations.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(ehr\.[a-z_][a-z0-9_]*)/g)]
  .map((match) => match[1]));

/** The document's sections, outside code fences: heading, whether it is headed as a target model, and its lines. */
function sections(markdown) {
  const result = [];
  let current = { heading: '(preamble)', target: false, lines: [] };
  let fenced = false;
  markdown.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,6}\s/.test(line)) {
      current = { heading: line.trim(), target: /\btarget\b/i.test(line), lines: [] };
      result.push(current);
      return;
    }
    current.lines.push({ number: index + 1, text: line, fenced });
  });
  return result;
}

const current = sections(document).filter((section) => !section.target);
/** An `ehr.name` written as a relation: not a permission code (`ehr.note.write`) or a column (`ehr.vitals.status`). */
const relationReferences = (text) => [...text.matchAll(/`(ehr\.[a-z_][a-z0-9_]*)(?![a-z0-9_.-])/gi)]
  .map((match) => match[1].toLowerCase());

test('every EHR relation a current section names is created by a migration', () => {
  const missing = current.flatMap((section) => section.lines.flatMap((line) => relationReferences(line.text)
    .filter((name) => !created.has(name))
    .map((name) => `${name} (DATABASE.md:${line.number}, ${section.heading})`)));
  assert.deepEqual(missing, [], 'DATABASE.md presents EHR relations that no migration creates; head the section as a target model or correct it');
});

test('no current section presents an allergy table', () => {
  const allergyTables = current.flatMap((section) => section.lines
    .filter((line) => /allergy_intolerance|`ehr\.allerg/i.test(line.text))
    .map((line) => `DATABASE.md:${line.number} (${section.heading})`));
  assert.deepEqual(allergyTables, [], 'DATABASE.md presents an allergy table as current; the EHR records no allergies');
});

test('the document says that the EHR records no allergies', () => {
  const said = current.some((section) => section.lines.some((line) =>
    /\ballerg(?:y|ies)\b.*\bnot\s+(?:recorded|captured)\b|\bno\s+allergy\b|\brecords\s+no\s+allergies\b/i.test(line.text)));
  assert.equal(said, true, 'DATABASE.md must state, outside a target-model section, that allergies are not recorded');
});

test('the implemented EHR record list names exactly the EHR tables the migrations create', () => {
  const implemented = sections(document).filter((section) => /implemented ehr (?:records|tables)/i.test(section.heading));
  assert.equal(implemented.length, 1, 'DATABASE.md needs one section headed "Implemented EHR records"');
  const listed = new Set(implemented[0].lines.flatMap((line) => relationReferences(line.text)).filter((name) => tables.has(name)
    || !created.has(name)));
  assert.deepEqual([...listed].sort(), [...tables].sort());
});
