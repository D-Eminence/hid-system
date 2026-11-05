// Scorer correctness on small hand-made cases (fictional text only).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown, scoreDocument, scoreRun, supported } from '../score.mjs';
import { normFrequency, normName, normStrength, onPage } from '../lib/normalise.mjs';

const box = { left: 0.1, top: 0.2, width: 0.5, height: 0.02 };
const LINES = ['DEMO HOSPITAL', 'Name: Adaeze Example   Sex: F', 'Tab Amlodipine 5 mg od, Losartan 50mg od',
  'Tab Hydroxyzine 25mg nocte', 'No evidence of Malaria', 'BP 140/90 mmHg'];

function key(items, extra = {}) {
  return { docId: 'T001', file: 'T001.png', pages: 1, documentKind: 'outpatient_card', difficulty: 'clean_typed',
    traps: [], fictional: true,
    identity: { nameAsWritten: 'Adaeze Example', dateOfBirthAsWritten: null, folderNumberAsWritten: null,
      sexAsWritten: 'F', page: 1, lines: [2] },
    text: [{ page: 1, lines: LINES.map((text, index) => ({ n: index + 1, text, handwritten: false,
      box: { ...box, top: 0.05 * (index + 1) } })) }],
    items, ...extra };
}

const med = (id, asWritten, name, strength, frequency, line, extra = {}) => ({ id, kind: 'medicine', asWritten,
  page: 1, lines: [line], prescription: null, trap: null,
  fields: { name, strength, form: 'Tab', route: null, frequency, duration: null, status: 'new' }, ...extra });
const KEY_ITEMS = [
  med('T001-i01', 'Tab Amlodipine 5 mg od', 'Amlodipine', '5 mg', 'od', 3, { trap: 'strength:5mg/50mg' }),
  med('T001-i02', 'Losartan 50mg od', 'Losartan', '50mg', 'od', 3, { trap: 'strength:5mg/50mg' }),
  med('T001-i03', 'Tab Hydroxyzine 25mg nocte', 'Hydroxyzine', '25mg', 'nocte', 4, { trap: 'lookalike:hydroxyzine/hydralazine' }),
  { id: 'T001-i04', kind: 'diagnosis', asWritten: 'No evidence of Malaria', page: 1, lines: [5], prescription: null,
    trap: 'negation', fields: { name: 'Malaria', status: 'ruled_out' } },
  { id: 'T001-i05', kind: 'vital', asWritten: 'BP 140/90 mmHg', page: 1, lines: [6], prescription: null, trap: null,
    fields: { measure: 'blood_pressure', value: '140/90', unit: 'mmHg' } },
];

let counter = 0;
function out(kind, asWritten, fields, { confidence = 'clear', line = 3, page = 1 } = {}) {
  counter += 1;
  return { id: `it-${counter.toString(16).padStart(16, '0')}`, kind, asWritten, plain: asWritten, dateAsWritten: null,
    page, lineIds: [`p${page}-l${line}`], box: { ...box, top: 0.05 * line }, confidence,
    checkReasons: confidence === 'clear' ? [] : ['ai_unsure'], checkReason: null, readBy: 'first_pass',
    fields, prescription: kind === 'medicine' ? null : null };
}
const outMed = (asWritten, name, strength, frequency, options) => out('medicine', asWritten,
  { name, strength, form: 'Tab', route: null, frequency, duration: null, status: 'new' }, options);
const payload = (items) => ({ contract: 'hid-paper-reading-v2', identity: { nameAsWritten: 'EXAMPLE, Adaeze',
  dateOfBirthAsWritten: null, folderNumberAsWritten: null, sexAsWritten: 'Female', lineIds: ['p1-l2'], box: null },
  pages: [{ page: 1, flagged: false, flagReasons: [], lines: LINES.map((text, index) => ({ id: `p1-l${index + 1}`,
    text, box, confidence: 0.99, handwritten: false })) }],
  items, reading: { status: 'read', itemCount: items.length } });

const perfect = () => [
  outMed('Tab Amlodipine 5 mg od', 'Amlodipine', '5mg', 'daily'),
  outMed('Losartan 50mg od', 'Losartan', '50 mg', 'OD'),
  outMed('Tab Hydroxyzine 25mg nocte', 'Hydroxyzine', '25mg', 'nocte', { line: 4 }),
  out('diagnosis', 'No evidence of Malaria', { name: 'Malaria', status: 'ruled_out' }, { line: 5 }),
  out('vital', 'BP 140/90 mmHg', { measure: 'blood_pressure', value: '140/90', unit: 'mmHg' }, { line: 6 }),
];

test('normalisation: spacing, case, frequency mapping and names', () => {
  assert.equal(normStrength('5 mg'), normStrength('5mg'));
  assert.equal(normStrength('100 µg'), normStrength('100mcg'));
  assert.notEqual(normStrength('5mg'), normStrength('50mg'));
  for (const spelling of ['tds', 'TDS', 'tid', 't.d.s.', 'three times a day', '8hrly', 'three times daily']) {
    assert.equal(normFrequency(spelling), 'tds', spelling);
  }
  for (const spelling of ['bd', 'b.d.', 'BID', 'twice daily', '12hrly']) assert.equal(normFrequency(spelling), 'bd');
  assert.equal(normFrequency('od'), normFrequency('once daily'));
  assert.notEqual(normFrequency('od'), normFrequency('bd'));
  assert.equal(normName('Tab Amlodipine'), 'amlodipine');
  assert.equal(normName('Artemether-Lumefantrine'), normName('Artemether/Lumefantrine'));
  assert.equal(onPage('Amlodipine 5mg', LINES), true);
  assert.equal(onPage('Amlodipme 5 mg', LINES), true, 'one-letter OCR slip in a long word is tolerated');
  assert.equal(onPage('Amlodipine 10mg', LINES), false, 'numbers must be on the page');
  assert.equal(onPage('Hydralazine', LINES), false, 'a look-alike drug is not on the page');
});

test('a perfect reading scores 100% on both measures and passes', () => {
  const report = scoreRun([key(KEY_ITEMS)], new Map([['T001', payload(perfect())]]));
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.value, 1);
  assert.equal(report.launchMetrics.medicineAccuracyStrict.value, 1);
  assert.equal(report.launchMetrics.unsupportedItems.value, 0);
  assert.equal(report.pass, true);
  assert.equal(report.identity.name, 1, 'SURNAME, First matches First Surname');
  assert.equal(report.identity.sex, 1, 'F matches Female');
  assert.deepEqual(report.worstDocuments, []);
});

test('a wrong strength flagged check_carefully counts after checking but not strictly', () => {
  const items = perfect();
  items[1] = outMed('Losartan 50mg od', 'Losartan', '5mg', 'od', { confidence: 'check_carefully' });
  const doc = scoreDocument(key(KEY_ITEMS), payload(items));
  assert.equal(doc.medicines.exact, 2);
  assert.equal(doc.medicines.caughtByCheck, 1);
  assert.equal(doc.medicines.missedAfterChecking, 0);
  assert.equal(doc.unsupported.unsupported, 0, '5 is not on the line as a number, but "5 mg" is on the page');
});

test('a wrong strength marked clear is a miss; a missing medicine is a miss', () => {
  const items = perfect();
  items[1] = outMed('Losartan 50mg od', 'Losartan', '5mg', 'od');
  items.splice(2, 1);
  const report = scoreRun([key(KEY_ITEMS)], new Map([['T001', payload(items)]]));
  const m = report.launchMetrics.medicineAccuracyAfterChecking;
  assert.equal(m.exact, 1);
  assert.equal(m.missed, 2);
  assert.equal(report.pass, false);
  assert.deepEqual(report.worstDocuments[0].missedMedicineIds, ['T001-i02', 'T001-i03']);
  assert.equal(report.traps.lookalike.credited, 0);
});

test('a look-alike drug read as clear is a miss and an unsupported item', () => {
  const items = perfect();
  items[2] = outMed('Tab Hydroxyzine 25mg nocte', 'Hydralazine', '25mg', 'nocte', { line: 4 });
  const report = scoreRun([key(KEY_ITEMS)], new Map([['T001', payload(items)]]));
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.missed, 1);
  assert.equal(report.launchMetrics.unsupportedItems.unsupported, 1);
  assert.equal(report.launchMetrics.unsupportedItems.byValue.name, 1);
});

test('a look-alike drug flagged check_carefully at the same place is caught by checking', () => {
  const items = perfect();
  items[2] = outMed('Tab Hydroxyzine 25mg nocte', 'Hydralazine', '25mg', 'nocte', { line: 4, confidence: 'check_carefully' });
  const doc = scoreDocument(key(KEY_ITEMS), payload(items));
  assert.equal(doc.medicines.caughtByCheck, 1);
  assert.equal(doc.medicines.missedAfterChecking, 0);
});

test('an invented item is unsupported; the share and threshold are worked out over all items', () => {
  const items = [...perfect(), out('medicine', 'Tab Amlodipine 5 mg od',
    { name: 'Metformin', strength: '500mg', form: 'Tab', route: null, frequency: 'bd', duration: null, status: 'new' })];
  const report = scoreRun([key(KEY_ITEMS)], new Map([['T001', payload(items)]]));
  const u = report.launchMetrics.unsupportedItems;
  assert.equal(u.unsupported, 1);
  assert.equal(u.produced, 6);
  assert.equal(u.pass, false, '1 of 6 is not under 1%');
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.value, 1);
  assert.equal(report.perKind.medicine.precision, 3 / 4);
});

test('a document with no result counts every medicine as missed', () => {
  const report = scoreRun([key(KEY_ITEMS)], new Map());
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.value, 0);
  assert.deepEqual(report.documents.missing, ['T001']);
  assert.equal(report.pass, false);
});

test('99% passes and just under fails; the markdown names no document text', () => {
  const keys = [];
  const payloads = new Map();
  for (let index = 1; index <= 100; index += 1) {
    const id = `T${String(index).padStart(3, '0')}`;
    keys.push({ ...key([KEY_ITEMS[0]]), docId: id });
    payloads.set(id, payload(index === 1 ? [] : [perfect()[0]]));
  }
  const report = scoreRun(keys, payloads);
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.value, 0.99);
  assert.equal(report.launchMetrics.medicineAccuracyAfterChecking.pass, true);
  payloads.set('T002', payload([]));
  const failing = scoreRun(keys, payloads);
  assert.equal(failing.launchMetrics.medicineAccuracyAfterChecking.pass, false);
  const markdown = renderMarkdown(failing);
  assert.match(markdown, /FAIL/);
  assert.match(markdown, /T001/);
  for (const line of LINES) assert.equal(markdown.includes(line), false, 'no document text in the summary');
});

test('a stopped medicine read as current is not exact: missed when clear, caught only when flagged', () => {
  const stopped = med('T001-i01', 'Tab Amlodipine 5 mg od', 'Amlodipine', '5 mg', 'od', 3,
    { trap: 'negation', fields: { name: 'Amlodipine', strength: '5 mg', form: 'Tab', route: null, frequency: 'od',
      duration: null, status: 'stopped' } });
  const items = KEY_ITEMS.slice(1);
  const asCurrent = (confidence) => out('medicine', 'Tab Amlodipine 5 mg od', { name: 'Amlodipine', strength: '5mg',
    form: 'Tab', route: null, frequency: 'od', duration: null, status: 'current' }, { confidence });
  const clear = scoreDocument(key([stopped, ...items]), payload([asCurrent('clear'), ...perfect().slice(1)]));
  assert.equal(clear.medicines.exact, 2);
  assert.equal(clear.medicines.statusDisagreements, 1);
  assert.deepEqual(clear.medicines.missedIds, ['T001-i01']);
  assert.deepEqual(clear.medicines.traps.negation, { expected: 1, credited: 0, exact: 0 });
  const flagged = scoreDocument(key([stopped, ...items]), payload([asCurrent('check_carefully'), ...perfect().slice(1)]));
  assert.deepEqual(flagged.medicines.caughtIds, ['T001-i01']);
  assert.deepEqual(flagged.medicines.traps.negation, { expected: 1, credited: 1, exact: 0 });
  // "new" and "current" both mean the medicine is taken: not a disagreement.
  const items2 = perfect();
  items2[0].fields.status = 'current';
  assert.equal(scoreDocument(key(KEY_ITEMS), payload(items2)).medicines.exact, 3);
});

test('a leading-dot strength is a different dose: ".5 mg" is never "5 mg"', () => {
  assert.notEqual(normStrength('.5 mg'), normStrength('5 mg'));
  assert.equal(normStrength('.5 mg'), normStrength('0.5mg'));
  assert.equal(onPage('Amlodipine .5 mg', LINES), false);
  const items = perfect();
  items[0] = outMed('Tab Amlodipine 5 mg od', 'Amlodipine', '.5 mg', 'od');
  const doc = scoreDocument(key(KEY_ITEMS), payload(items));
  assert.deepEqual(doc.medicines.missedIds, ['T001-i01']);
  assert.equal(doc.unsupported.byValue.strength, 1);
});

test('a flagged duplicate of one medicine does not cover a skipped neighbour on the same line', () => {
  const items = perfect();
  items[0] = outMed('Losartan 999mg od', 'Losartan', '999mg', 'od', { confidence: 'check_carefully' });
  const doc = scoreDocument(key(KEY_ITEMS), payload(items));
  assert.deepEqual(doc.medicines.caughtIds, []);
  assert.deepEqual(doc.medicines.missedIds, ['T001-i01']);
});

test('an invented "nocte" is not supported by the everyday word "on" elsewhere on the page', () => {
  const lines = ['Seen on 3 Nov', 'Tab Amlodipine 5 mg od', 'Amitriptyline 25mg ON'];
  assert.equal(supported('frequency', 'nocte', lines, 'Amlodipine'), false);
  assert.equal(supported('frequency', 'at night', lines, 'Amlodipine'), false);
  assert.equal(supported('frequency', 'on', lines, 'Amlodipine'), false);
  assert.equal(supported('frequency', 'nocte', lines, ''), false);
  assert.equal(supported('frequency', 'nocte', lines, 'Amitriptyline'), true, 'written ON after the medicine');
  assert.equal(supported('frequency', 'daily', lines, 'Amlodipine'), true, 'daily for a written od');
});
