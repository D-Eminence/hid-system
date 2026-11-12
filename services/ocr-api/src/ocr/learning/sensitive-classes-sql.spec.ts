import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SENSITIVE_BRANDS, SENSITIVE_GENERICS, SENSITIVE_WORD_PATTERNS } from './sensitive-classes';

/**
 * 0118's ocr.learning_value_sensitive is the database's own copy of this list (review of 2026-11-12: the database
 * enforces it too). Each of its three arrays must equal ocr-api's, in order, so the two can never drift.
 */
const migration = readFileSync(join(__dirname, '../../../../ehr-api/database/migrations/0118_ocr_correction_observations.sql'),
  'utf8');
const body = migration.slice(migration.indexOf('create function ocr.learning_value_sensitive'),
  migration.indexOf('create function ocr.record_correction_observations'));

function sqlArray(marker: 'generics' | 'words' | 'brands'): string[] {
  const start = body.indexOf(`array[ -- ${marker}`);
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf(']::text[]', start);
  const literal = body.slice(body.indexOf('\n', start), end);
  return [...literal.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]!.replace(/''/g, "'"));
}

describe('the database copy of the sensitive-class list (0118)', () => {
  it('holds the same generic names, in order', () => {
    expect(sqlArray('generics')).toEqual(Object.values(SENSITIVE_GENERICS).flat());
  });
  it('holds the same brand names, in order', () => {
    expect(sqlArray('brands')).toEqual(Object.values(SENSITIVE_BRANDS).flat());
  });
  it('holds the same word patterns, in order', () => {
    expect(sqlArray('words')).toEqual([...SENSITIVE_WORD_PATTERNS]);
  });
});
