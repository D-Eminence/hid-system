// The committed answer keys and manifest agree with each other and are complete, consistent and fictional.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadKeys } from '../lib/kit.mjs';

const { keys, manifest } = loadKeys();
const FICTIONAL_SURNAMES = ['Example', 'Testperson', 'Sample', 'Demo', 'Placeholder', 'Fakename', 'Notreal',
  'Mockpatient', 'Testcase', 'Specimen'];
const FICTIONAL_FACILITY = /\b(?:DEMO|EXAMPLE|SAMPLE|TESTVILLE)\b/;
const CONTRACT_FIELDS = {
  medicine: ['name', 'strength', 'form', 'route', 'frequency', 'duration', 'status'],
  diagnosis: ['name', 'status'],
  allergy: ['substance', 'reaction', 'severity', 'noKnownAllergies'],
  lab_result: ['test', 'value', 'unit', 'referenceRange', 'flag'],
  vital: ['measure', 'value', 'unit'],
  note: ['text'],
};

test('manifest and keys: seed 20261103, 200 documents, one sha256 per file, PNG single page, PDF 2-4 pages', () => {
  assert.equal(manifest.seed, 20261103);
  assert.equal(manifest.count, 200);
  assert.equal(keys.length, 200);
  assert.equal(Object.keys(manifest.files).length, 200);
  for (const digest of Object.values(manifest.files)) assert.match(digest, /^[0-9a-f]{64}$/);
  const ids = new Set();
  for (const key of keys) {
    assert.equal(ids.has(key.docId), false);
    ids.add(key.docId);
    assert.equal(key.text.length, key.pages);
    if (key.mediaType === 'image/png') assert.equal(key.pages, 1, key.docId);
    else {
      assert.equal(key.mediaType, 'application/pdf');
      assert.ok(key.pages >= 2 && key.pages <= 4, key.docId);
    }
    assert.ok(key.file.startsWith(`${key.docId}-${key.documentKind}.`));
  }
  const kinds = new Set(keys.map((key) => key.documentKind));
  assert.deepEqual([...kinds].sort(), ['discharge_summary', 'lab_report', 'outpatient_card', 'prescription',
    'referral_letter', 'vitals_chart']);
  assert.equal(new Set(keys.map((key) => key.difficulty)).size, 5);
});

test('every expected item is on its own line, with the contract fields of its kind', () => {
  let medicines = 0;
  for (const key of keys) {
    const itemIds = new Set();
    for (const item of key.items) {
      assert.equal(itemIds.has(item.id), false);
      itemIds.add(item.id);
      const page = key.text[item.page - 1];
      assert.ok(page, `${item.id} page`);
      for (const n of item.lines) assert.ok(page.lines[n - 1].text.includes(item.asWritten), `${item.id} asWritten`);
      assert.deepEqual(Object.keys(item.fields).sort(), [...CONTRACT_FIELDS[item.kind]].sort(), item.id);
      if (item.kind === 'medicine') {
        medicines += 1;
        assert.ok(item.fields.name && item.fields.strength && item.fields.frequency, item.id);
      }
      // No 11-digit or phone-like numbers in an item: the worker masks those before the AI step.
      assert.equal(/\d{11}/.test(item.asWritten.replace(/\s/g, '')), false, item.id);
    }
  }
  assert.ok(medicines >= 400, `enough medicines for a 99% threshold to mean something (${medicines})`);
});

test('every person and place is fictional', () => {
  for (const key of keys) {
    assert.equal(key.fictional, true);
    const { nameAsWritten, folderNumberAsWritten } = key.identity;
    assert.ok(FICTIONAL_SURNAMES.some((surname) => nameAsWritten.toLowerCase().includes(surname.toLowerCase())),
      `${key.docId} surname`);
    assert.match(folderNumberAsWritten, /-TEST-\d{4}$/);
    assert.match(key.text[0].lines[0].text, FICTIONAL_FACILITY, `${key.docId} facility`);
    for (const page of key.text) {
      assert.equal(page.lines.at(-1).text, 'FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT');
      for (const line of page.lines) {
        if (/\bDr\b/.test(line.text)) assert.match(line.text, /Dr [A-Z]\. \w*(?:test|sample|example|demo|notreal)\w*/i);
      }
    }
  }
});

test('traps are present: look-alike names and strengths, negations, allergy conflicts and a future date', () => {
  const traps = new Set(keys.flatMap((key) => key.items.map((item) => item.trap?.split(':')[0]).filter(Boolean)));
  assert.deepEqual([...traps].sort(), ['allergy_conflict', 'future_date', 'lookalike', 'negation', 'strength']);
  for (const key of keys) {
    assert.deepEqual(key.traps, [...new Set(key.items.map((item) => item.trap?.split(':')[0]).filter(Boolean))].sort(),
      key.docId);
  }
  const byId = new Map(keys.map((key) => [key.docId, key]));
  for (const docId of ['D005', 'D019', 'D025']) assert.ok(byId.get(docId).traps.includes('allergy_conflict'), docId);
  assert.ok(byId.get('D013').traps.includes('future_date'));
  const statuses = new Set(keys.flatMap((key) => key.items.filter((item) => item.kind === 'diagnosis')
    .map((item) => item.fields.status)));
  for (const status of ['confirmed', 'suspected', 'ruled_out', 'history', 'family_history']) assert.ok(statuses.has(status), status);
  assert.ok(keys.some((key) => key.items.some((item) => item.kind === 'allergy' && item.fields.noKnownAllergies)));
  assert.ok(keys.some((key) => key.items.some((item) => item.kind === 'medicine' && item.fields.status === 'stopped')));
});

test('a working diagnosis is suspected (provisional), never confirmed', () => {
  let working = 0;
  for (const key of keys) {
    for (const item of key.items) {
      const line = key.text[item.page - 1].lines[item.lines[0] - 1].text;
      if (item.kind !== 'diagnosis' || !line.startsWith('Working diagnosis:')) continue;
      working += 1;
      assert.equal(item.fields.status, 'suspected', item.id);
    }
  }
  assert.equal(working, keys.filter((key) => key.documentKind === 'referral_letter').length);
});

test('every item carries the date its page gives for it, written on that page', () => {
  let dated = 0;
  for (const key of keys) {
    for (const item of key.items) {
      assert.ok('dateAsWritten' in item, item.id);
      if (item.dateAsWritten === null) continue;
      dated += 1;
      assert.ok(key.text[item.page - 1].lines.some((line) => line.text.includes(item.dateAsWritten)), item.id);
      if (item.prescription) assert.equal(item.dateAsWritten, item.prescription.dateAsWritten, item.id);
    }
    if (['outpatient_card', 'prescription', 'vitals_chart'].includes(key.documentKind)) {
      assert.ok(key.items.every((item) => item.dateAsWritten !== null), `${key.docId}: every page has its date`);
    }
  }
  assert.ok(dated > 2500, `${dated} dated items`);
});

test('every diagnosis that is not confirmed and every stopped medicine carries the negation trap', () => {
  for (const key of keys) {
    for (const item of key.items) {
      if ((item.kind === 'diagnosis' && item.fields.status !== 'confirmed')
        || (item.kind === 'medicine' && item.fields.status === 'stopped')) assert.equal(item.trap, 'negation', item.id);
    }
  }
});
