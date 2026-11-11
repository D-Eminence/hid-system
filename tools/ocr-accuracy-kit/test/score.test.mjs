// Scorer correctness on small hand-made cases (fictional text only).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareDate, renderMarkdown, scoreDocument, scoreRun, supported } from '../score.mjs';
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

// ----- Other readings accepted (Ola's pre-check) and dates -----

const RX_LINES = ['DEMO HOSPITAL', 'Date: 03/04/2026', 'Inh Salbutamol 100mcg 2 puffs prn',
  'Mist. Magnesium trisilicate 10 ml tds', 'Treatment given:', 'IV fluids 0.9% saline 1L 8hrly',
  'Admitted: 01/04/2026   Discharged: 06/04/2026'];
const rxKey = (items) => ({ ...key(items), text: [{ page: 1, lines: RX_LINES.map((text, index) => ({ n: index + 1, text,
  handwritten: false, box: { ...box, top: 0.05 * (index + 1) } })) }] });
const rx = { prescriberAsWritten: null, dateAsWritten: '03/04/2026' };
const SALB = med('T001-i01', 'Inh Salbutamol 100mcg 2 puffs prn', 'Salbutamol', '100mcg', 'prn', 3,
  { prescription: rx, dateAsWritten: '03/04/2026',
    fields: { name: 'Salbutamol', strength: '100mcg', form: 'Inh', route: null, frequency: 'prn', duration: null, status: 'new' } });
const MIST = med('T001-i02', 'Mist. Magnesium trisilicate 10 ml tds', 'Magnesium trisilicate', '10 ml', 'tds', 4,
  { prescription: rx, dateAsWritten: '03/04/2026',
    fields: { name: 'Magnesium trisilicate', strength: '10 ml', form: 'Mist.', route: null, frequency: 'tds', duration: null, status: 'new' } });
const FLUIDS = { id: 'T001-i03', kind: 'note', asWritten: 'IV fluids 0.9% saline 1L 8hrly', page: 1, lines: [6],
  prescription: null, trap: null, dateAsWritten: null, fields: { text: 'IV fluids 0.9% saline 1L 8hrly' } };
const RX_ITEMS = [SALB, MIST, FLUIDS];
const rxPayload = (items) => ({ ...payload(items), pages: [{ page: 1, flagged: false, flagReasons: [],
  lines: RX_LINES.map((text, index) => ({ id: `p1-l${index + 1}`, text, box, confidence: 0.99, handwritten: false })) }] });
const salbOut = (route, extra = {}) => ({ ...out('medicine', 'Inh Salbutamol 100mcg 2 puffs prn', { name: 'Salbutamol',
  strength: '100mcg', form: 'Inh', route, frequency: 'prn', duration: null, status: 'new' }), dateAsWritten: '03/04/2026', ...extra });
const mistOut = (strength) => ({ ...out('medicine', 'Mist. Magnesium trisilicate 10 ml tds', { name: 'Magnesium trisilicate',
  strength, form: 'Mist.', route: null, frequency: 'tds', duration: null, status: 'new' }, { line: 4 }), dateAsWritten: '03/04/2026' });
const fluidsNote = () => out('note', 'IV fluids 0.9% saline 1L 8hrly', { text: 'IV fluids 0.9% saline 1L 8hrly' }, { line: 6 });

test('route "inhaled" for an inhaler with no route written is supported and correct; elsewhere it is not', () => {
  const doc = scoreDocument(rxKey(RX_ITEMS), rxPayload([salbOut('inhaled'), mistOut('10 ml'), fluidsNote()]));
  assert.equal(doc.unsupported.unsupported, 0);
  assert.equal(doc.kinds.medicine.fieldsCorrect, 2);
  assert.equal(supported('route', 'inhaled', RX_LINES, 'Salbutamol'), true);
  assert.equal(supported('route', 'inhaled', RX_LINES, 'Magnesium trisilicate'), false, 'not an inhaler');
  assert.equal(supported('route', 'po', RX_LINES, 'Salbutamol'), false, 'any other route still has to be written');
  const iv = scoreDocument(rxKey(RX_ITEMS), rxPayload([salbOut('IM'), mistOut('10 ml'), fluidsNote()]));
  assert.equal(iv.unsupported.byValue.route, 1);
  assert.equal(iv.kinds.medicine.fieldsCorrect, 1);
});

test('"Mist. ... 10 ml" read as the strength or as a dose (strength left empty) is exact; another volume is not', () => {
  for (const strength of ['10 ml', '10ml', null]) {
    const doc = scoreDocument(rxKey(RX_ITEMS), rxPayload([salbOut(null), mistOut(strength), fluidsNote()]));
    assert.equal(doc.medicines.exact, 2, String(strength));
  }
  const wrong = scoreDocument(rxKey(RX_ITEMS), rxPayload([salbOut(null), mistOut('5 ml'), fluidsNote()]));
  assert.equal(wrong.medicines.exact, 1);
  // A tablet whose strength is left empty is still not exact.
  const items = perfect();
  items[0] = outMed('Tab Amlodipine 5 mg od', 'Amlodipine', null, 'od');
  assert.equal(scoreDocument(key(KEY_ITEMS), payload(items)).medicines.exact, 2);
});

test('IV fluids read as a note or as a past or stopped medicine are found; as an active medicine they are extra', () => {
  const asMedicine = (status) => out('medicine', 'IV fluids 0.9% saline 1L 8hrly', { name: '0.9% saline', strength: '1L',
    form: null, route: 'IV', frequency: '8hrly', duration: null, status }, { line: 6 });
  for (const status of ['past', 'stopped']) {
    const doc = scoreDocument(rxKey(RX_ITEMS), rxPayload([salbOut(null), mistOut('10 ml'), asMedicine(status)]));
    assert.equal(doc.kinds.note.matched, 1, status);
    assert.equal(doc.extraItems, 0, status);
    assert.equal(doc.alternatives.ivFluidsAsPastMedicine, 1);
    assert.equal(doc.medicines.expected, 2, 'the launch measure counts the key medicines only');
  }
  for (const status of ['new', 'current']) {
    const doc = scoreDocument(rxKey(RX_ITEMS), rxPayload([salbOut(null), mistOut('10 ml'), asMedicine(status)]));
    assert.equal(doc.kinds.note.matched, 0, status);
    assert.equal(doc.extraItems, 1, status);
  }
});

test('a prescription date read as a separate note is accepted, not extra, and its medicines\' date is "given as note"', () => {
  const noDate = (item) => ({ ...item, dateAsWritten: null });
  const items = [noDate(salbOut(null)), noDate(mistOut('10 ml')), fluidsNote(),
    out('note', 'Date: 03/04/2026', { text: '03/04/2026' }, { line: 2 })];
  const report = scoreRun([rxKey(RX_ITEMS)], new Map([['T001', rxPayload(items)]]));
  assert.equal(report.alternatives.prescriptionDateAsNote, 1);
  assert.equal(report.perKind.note.precision, 1);
  assert.equal(report.dates.given_as_note, 2);
  assert.equal(report.dates.missing, 0);
  // A note with some other date is not a prescription date.
  const other = scoreDocument(rxKey(RX_ITEMS), rxPayload([...items.slice(0, 3),
    out('note', 'Admitted: 01/04/2026', { text: '01/04/2026' }, { line: 7 })]));
  assert.equal(other.extraItems, 1);
  assert.equal(other.dates.missing, 2);
});

test('dates: a day/month swap is its own outcome, and dates never change the two launch measures', () => {
  assert.equal(compareDate('03/04/2026', '03/04/2026'), 'same');
  assert.equal(compareDate('3/4/26', '03/04/2026'), 'same_date_other_spelling');
  assert.equal(compareDate('2026-04-03', '03/04/2026'), 'same_date_other_spelling');
  assert.equal(compareDate('04/03/2026', '03/04/2026'), 'day_month_swapped');
  assert.equal(compareDate('04/04/2026', '04/04/2026'), 'same');
  assert.equal(compareDate('06/04/2026', '01/04/2026', ['01/04/2026', '06/04/2026']), 'other_date_on_page');
  assert.equal(compareDate('09/09/2026', '03/04/2026'), 'wrong');
  assert.equal(compareDate(null, '03/04/2026'), 'missing');
  assert.equal(compareDate('03/04/2026', null), 'extra');
  assert.equal(compareDate(null, null), null);
  const right = scoreRun([rxKey(RX_ITEMS)], new Map([['T001', rxPayload([salbOut(null), mistOut('10 ml'), fluidsNote()])]]));
  // The produced item's date may also come only in its prescription.
  const swapped = scoreRun([rxKey(RX_ITEMS)], new Map([['T001', rxPayload([
    salbOut(null, { dateAsWritten: null, prescription: { prescriberAsWritten: null, dateAsWritten: '04/03/2026' } }),
    mistOut('10 ml'), fluidsNote()])]]));
  assert.equal(right.dates.same, 2);
  assert.equal(swapped.dates.day_month_swapped, 1);
  assert.deepEqual(swapped.dates.swappedIds, ['T001-i01']);
  assert.equal(swapped.launchMetrics.medicineAccuracyAfterChecking.value, right.launchMetrics.medicineAccuracyAfterChecking.value);
  assert.match(renderMarkdown(swapped), /## Dates[\s\S]*Day and month swapped: T001-i01/);
});

test('a lab test with or without its method in brackets is the same test', () => {
  const lines = ['MALARIA PARASITE', 'MP (thick film): Positive (++)'];
  const labKey = { ...key([{ id: 'T001-i01', kind: 'lab_result', asWritten: 'MP (thick film): Positive (++)', page: 1,
    lines: [2], prescription: null, trap: null, dateAsWritten: null,
    fields: { test: 'MP (thick film)', value: 'Positive (++)', unit: null, referenceRange: null, flag: null } }]),
  text: [{ page: 1, lines: lines.map((text, index) => ({ n: index + 1, text, handwritten: false, box })) }] };
  for (const test of ['MP (thick film)', 'MP']) {
    const doc = scoreDocument(labKey, payload([out('lab_result', 'MP (thick film): Positive (++)',
      { test, value: 'Positive (++)', unit: null, referenceRange: null, flag: null }, { line: 2 })]));
    assert.equal(doc.kinds.lab_result.fieldsCorrect, 1, test);
  }
  const other = scoreDocument(labKey, payload([out('lab_result', 'MP (thick film): Positive (++)',
    { test: 'mRDT', value: 'Positive (++)', unit: null, referenceRange: null, flag: null }, { line: 2 })]));
  assert.equal(other.kinds.lab_result.matched, 0);
  // Only a known method in brackets is dropped: "FBS (random)" is not "FBS".
  const fbsKey = { ...labKey, items: [{ ...labKey.items[0], asWritten: 'FBS (random): 6.1 mmol/L',
    fields: { test: 'FBS (random)', value: '6.1', unit: 'mmol/L', referenceRange: null, flag: null } }],
  text: [{ page: 1, lines: [{ n: 1, text: 'BLOOD SUGAR', handwritten: false, box },
    { n: 2, text: 'FBS (random): 6.1 mmol/L', handwritten: false, box }] }] };
  const fbs = scoreDocument(fbsKey, payload([out('lab_result', 'FBS (random): 6.1 mmol/L',
    { test: 'FBS', value: '6.1', unit: 'mmol/L', referenceRange: null, flag: null }, { line: 2 })]));
  assert.equal(fbs.kinds.lab_result.fieldsCorrect, 0, '"FBS (random)" is not "FBS"');
});
