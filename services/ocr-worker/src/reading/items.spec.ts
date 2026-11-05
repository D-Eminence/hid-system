import { checkPage, itemId, uniqueItemIds } from './items';
import { createMasker } from './masking';
import { CLINIC_PAGE, modelItem, modelPage, readPage, SOURCE_SHA } from './test-fixtures';
import type { ModelPage } from './prompt';
import type { ReadPage } from '../types';

function check(page: ReadPage, answer: ModelPage, readBy: 'first_pass' | 'reread' = 'first_pass') {
  return checkPage({ page: page.page, lines: page.lines, answer, sourceSha256Hex: SOURCE_SHA, readBy,
    masker: createMasker() });
}

const amlodipine = modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg od', plain: 'Amlodipine 5 mg once a day',
  lineIds: ['p1-l3'], status: 'current', name: 'Amlodipine', strength: '5mg', frequency: 'od' });

describe('checkPage grounding: ungrounded items are dropped and only counted', () => {
  it('drops an item whose words are not in its cited lines ("Warfarin 5" is not in "Warfarin 50 mg")', () => {
    const page = readPage(1, ['Warfarin 50 mg nocte']);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: 'Warfarin 5', lineIds: ['p1-l1'],
      name: 'Warfarin', strength: '5', status: 'current' })]));
    expect(result.items).toEqual([]);
    expect(result.droppedUngrounded).toBe(1);
    expect(JSON.stringify(result)).not.toContain('Warfarin 5"');
  });

  it('drops "5 mg" cited from "2.5 mg", an item citing no line, and one citing a line not on the page', () => {
    const page = readPage(1, ['Bisoprolol 2.5 mg od']);
    const result = check(page, modelPage([
      modelItem({ kind: 'medicine', asWritten: '5 mg', lineIds: ['p1-l1'] }),
      modelItem({ kind: 'note', asWritten: 'Bisoprolol', lineIds: [] }),
      modelItem({ kind: 'note', asWritten: 'Bisoprolol', lineIds: ['p1-l1', 'p2-l1'] }),
      modelItem({ kind: 'note', asWritten: '   ', lineIds: ['p1-l1'] }),
    ]));
    expect(result.items).toEqual([]);
    expect(result.droppedUngrounded).toBe(4);
    expect(result.rereadReasons).toContain('dropped_ungrounded');
    expect(result.flagReasons).toContain('many_dropped');
  });

  it('keeps "HTN" cited from "HTN/T2DM"', () => {
    const page = readPage(1, ['PMH: HTN/T2DM']);
    const result = check(page, modelPage([modelItem({ kind: 'diagnosis', asWritten: 'HTN', lineIds: ['p1-l1'],
      name: 'HTN', status: 'history', plain: 'High blood pressure (past history)' })]));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: 'diagnosis', fields: { name: 'HTN', status: 'history' },
      confidence: 'check_carefully' });
    expect(result.items[0]!.checkReasons).toContain('status_not_active');
  });
});

describe('checkPage reasons', () => {
  it('marks a clear, active, printed medicine as clear, with a deterministic id and the line box', () => {
    const result = check(CLINIC_PAGE, modelPage([amlodipine,
      modelItem({ kind: 'medicine', asWritten: 'Metformin 500mg bd', lineIds: ['p1-l3'], status: 'current',
        name: 'Metformin', strength: '500mg', frequency: 'bd', plain: 'Metformin 500 mg twice a day' })]));
    expect(result.items.map((item) => [item.confidence, item.checkReasons])).toEqual([['clear', []], ['clear', []]]);
    const item = result.items[0]!;
    expect(item.id).toBe(itemId(SOURCE_SHA, 'medicine', ['p1-l3'], 'Amlodipine 5mg od'));
    expect(item.id).toMatch(/^it-[0-9a-f]{16}$/);
    expect(result.items.map((entry) => entry.id)).toHaveLength(new Set(result.items.map((entry) => entry.id)).size);
    expect(item.box).toEqual(CLINIC_PAGE.lines[2]!.box);
    expect(item.checkReason).toBeNull();
    expect(item.prescription).toBeNull();
  });

  it('flags a dose that differs from its own part of the line, not the other medicine\'s', () => {
    const result = check(CLINIC_PAGE, modelPage([{ ...amlodipine, strength: '500mg' }]));
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(['strength_mismatch']));
    expect(result.items[0]!.checkReason).toBe("A dose on the paper doesn't match what was read.");
  });

  it('flags a route that is not the one written, and a route the paper does not give', () => {
    const page = readPage(1, ['Ceftriaxone 1g IV bd']);
    const base = modelItem({ kind: 'medicine', asWritten: 'Ceftriaxone 1g IV bd', lineIds: ['p1-l1'],
      status: 'new', name: 'Ceftriaxone', strength: '1g', frequency: 'bd' });
    expect(check(page, modelPage([{ ...base, route: 'IM' }])).items[0]!.checkReasons).toContain('route_mismatch');
    expect(check(page, modelPage([base])).items[0]!.checkReasons).toContain('route_missing');
    expect(check(page, modelPage([{ ...base, route: 'IV' }])).items[0]!.checkReasons).toEqual([]);
    const tab = readPage(1, ['Tab Amlodipine 5mg']);
    expect(check(tab, modelPage([modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg', lineIds: ['p1-l1'],
      status: 'new', name: 'Amlodipine', strength: '5mg', route: 'oral' })])).items[0]!.checkReasons)
      .toContain('route_not_on_paper');
  });

  it('says plainly which route problem it is', () => {
    const page = readPage(1, ['Ceftriaxone 1g IV bd']);
    const base = modelItem({ kind: 'medicine', asWritten: 'Ceftriaxone 1g IV bd', lineIds: ['p1-l1'],
      status: 'new', name: 'Ceftriaxone', strength: '1g', frequency: 'bd' });
    expect(check(page, modelPage([{ ...base, route: 'IM' }])).items[0]!.checkReason)
      .toBe("How it is given doesn't match the paper.");
    expect(check(page, modelPage([base])).items[0]!.checkReason)
      .toBe("The paper says how it is given, but that wasn't read.");
    const tab = readPage(1, ['Tab Amlodipine 5mg']);
    expect(check(tab, modelPage([modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg', lineIds: ['p1-l1'],
      status: 'new', name: 'Amlodipine', strength: '5mg', route: 'oral' })])).items[0]!.checkReason)
      .toBe("The route read (for example IV or by mouth) isn't on the paper.");
  });

  it('says the handwriting was hard to read before a route the text read does not show', () => {
    // Textract read the handwritten "IV" as "1v": the route is not in the text, and the handwriting is why.
    const page = readPage(1, [['1v Ceftriaxone 1g daily', { handwritten: true, confidence: 0.4 }]]);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: '1v Ceftriaxone 1g daily',
      lineIds: ['p1-l1'], status: 'new', name: 'Ceftriaxone', strength: '1g', frequency: 'daily', route: 'IV' })]));
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(
      ['route_not_on_paper', 'low_ocr_confidence_handwritten']));
    expect(result.items[0]!.checkReason).toBe('The handwriting was hard to read.');
  });

  it('still says a stopped medicine may not be current, even on a hard-to-read handwritten line', () => {
    const page = readPage(1, [['Warfarin 5mg od stopped', { handwritten: true, confidence: 0.5 }]]);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: 'Warfarin 5mg od stopped',
      lineIds: ['p1-l1'], name: 'Warfarin', strength: '5mg', frequency: 'od', status: 'stopped' })]));
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(
      ['status_not_active', 'low_ocr_confidence_handwritten']));
    expect(result.items[0]!.checkReason).toBe('This may not be current (for example past, stopped or suspected).');
  });

  it('still says a route that disagrees with the paper first, even on a hard-to-read handwritten line', () => {
    const page = readPage(1, [['Ceftriaxone 1g IV daily', { handwritten: true, confidence: 0.5 }]]);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: 'Ceftriaxone 1g IV daily',
      lineIds: ['p1-l1'], name: 'Ceftriaxone', strength: '1g', frequency: 'daily', route: 'oral', status: 'new' })]));
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(
      ['route_mismatch', 'low_ocr_confidence_handwritten']));
    expect(result.items[0]!.checkReason).toBe("How it is given doesn't match the paper.");
  });

  it('still says a dose that disagrees with the paper first, even on a hard-to-read handwritten line', () => {
    const page = readPage(1, [['Metronidazole 400mg tds', { handwritten: true, confidence: 0.5 }]]);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: 'Metronidazole 400mg tds',
      lineIds: ['p1-l1'], name: 'Metronidazole', strength: '200mg', frequency: 'tds', status: 'new' })]));
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(
      ['strength_mismatch', 'low_ocr_confidence_handwritten']));
    expect(result.items[0]!.checkReason).toBe("A dose on the paper doesn't match what was read.");
  });

  it('flags a dose or frequency the line gives but the item left out', () => {
    const result = check(CLINIC_PAGE, modelPage([{ ...amlodipine, strength: '', frequency: '' }]));
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(['strength_missing', 'frequency_missing']));
  });

  it('flags a corrected name (text_corrected) and a number in the plain reading that is not written', () => {
    const page = readPage(1, ['Amlodipme 5mg od']);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: 'Amlodipme 5mg od',
      lineIds: ['p1-l1'], status: 'current', name: 'Amlodipine', strength: '5mg', frequency: 'od',
      plain: 'Amlodipine 10 mg once a day' })]));
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(['text_corrected', 'reading_number_mismatch']));
  });

  it('flags an item built from lines that are not together on the page', () => {
    const page = readPage(1, [['Paracetamol', { box: { left: 0.05, top: 0.1, width: 0.2, height: 0.02 } }],
      ['Name: Test Patient', { box: { left: 0.6, top: 0.5, width: 0.3, height: 0.02 } }],
      ['1g tds', { box: { left: 0.6, top: 0.8, width: 0.1, height: 0.02 } }]]);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: 'Paracetamol 1g tds',
      lineIds: ['p1-l1', 'p1-l3'], name: 'Paracetamol', strength: '1g', frequency: 'tds', status: 'new' })]));
    expect(result.items[0]!.checkReasons).toContain('lines_not_together');
    expect(result.items[0]!.box).toEqual({ left: 0.05, top: 0.1, width: 0.65, height: 0.72 });
  });

  it('accepts an item wrapped over two lines directly below each other', () => {
    const page = readPage(1, [['Paracetamol', { box: { left: 0.1, top: 0.1, width: 0.3, height: 0.02 } }],
      ['1g tds', { box: { left: 0.1, top: 0.125, width: 0.1, height: 0.02 } }]]);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: 'Paracetamol 1g tds',
      lineIds: ['p1-l2', 'p1-l1'], name: 'Paracetamol', strength: '1g', frequency: 'tds', status: 'new' })]));
    expect(result.items[0]!.checkReasons).toEqual([]);
    expect(result.items[0]!.lineIds).toEqual(['p1-l1', 'p1-l2']);
  });

  it('flags hard-to-read handwriting with the plain sentence, and asks for a re-read', () => {
    const page = readPage(1, [['Metronidazole 400mg tds', { handwritten: true, confidence: 0.55 }]]);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: 'Metronidazole 400mg tds',
      lineIds: ['p1-l1'], name: 'Metronidazole', strength: '400mg', frequency: 'tds', status: 'new' })]));
    expect(result.items[0]!.checkReasons).toEqual(['low_ocr_confidence_handwritten', 'handwritten']);
    expect(result.items[0]!.checkReason).toBe('The handwriting was hard to read.');
    expect(result.rereadReasons).toContain('low_confidence_handwriting');
    expect(result.flagReasons).toContain('handwriting');
  });

  it('does not count legible handwriting alone towards a re-read', () => {
    const page = readPage(1, [['Metronidazole 400mg tds', { handwritten: true, confidence: 0.95 }]]);
    const result = check(page, modelPage([modelItem({ kind: 'medicine', asWritten: 'Metronidazole 400mg tds',
      lineIds: ['p1-l1'], name: 'Metronidazole', strength: '400mg', frequency: 'tds', status: 'new' })]));
    expect(result.items[0]!.checkReasons).toEqual(['handwritten']);
    expect(result.rereadReasons).toEqual([]);
  });

  it('flags status words on an active item\'s line', () => {
    const page = readPage(1, ['?Malaria']);
    const result = check(page, modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Malaria', lineIds: ['p1-l1'],
      name: 'Malaria', status: 'confirmed' })]));
    expect(result.items[0]!.checkReasons).toContain('status_cue_on_line');
  });

  it('keeps a no-known-allergies statement without a substance', () => {
    const page = readPage(1, ['Allergies: NKDA']);
    const result = check(page, modelPage([modelItem({ kind: 'allergy', asWritten: 'NKDA', lineIds: ['p1-l1'],
      noKnownAllergies: true, plain: 'No known drug allergies' })]));
    expect(result.items[0]).toMatchObject({ fields: { substance: null, reaction: null, severity: null, noKnownAllergies: true },
      confidence: 'clear' });
  });

  it('checks dates: kept only when written, flagged when day and month could swap', () => {
    const page = readPage(1, ['03/04/2026 Amoxicillin 500mg tds x 5/7']);
    const base = modelItem({ kind: 'medicine', asWritten: 'Amoxicillin 500mg tds x 5/7', lineIds: ['p1-l1'],
      name: 'Amoxicillin', strength: '500mg', frequency: 'tds', duration: '5/7', status: 'new' });
    const written = check(page, modelPage([{ ...base, dateAsWritten: '03/04/2026' }])).items[0]!;
    expect(written.dateAsWritten).toBe('03/04/2026');
    expect(written.checkReasons).toContain('date_ambiguous');
    const invented = check(page, modelPage([{ ...base, dateAsWritten: '2026-04-03' }])).items[0]!;
    expect(invented.dateAsWritten).toBeNull();
    expect(invented.checkReasons).toContain('date_not_on_page');
  });

  it('keeps a prescription\'s prescriber and date only when they are on the page', () => {
    const result = check(CLINIC_PAGE, modelPage([{ ...amlodipine, prescriberAsWritten: 'Dr Test Prescriber',
      prescriptionDate: '03/04/2026' }, modelItem({ kind: 'medicine', asWritten: 'Metformin 500mg bd',
      lineIds: ['p1-l3'], status: 'current', name: 'Metformin', strength: '500mg', frequency: 'bd',
      prescriberAsWritten: 'Dr Someone Else' })]));
    expect(result.items[0]!.prescription).toEqual({ prescriberAsWritten: 'Dr Test Prescriber', dateAsWritten: '03/04/2026' });
    expect(result.items[1]!.prescription).toBeNull();
    expect(result.items[1]!.checkReasons).toContain('prescription_detail_not_on_page');
  });

  it('checks lab values and units, and vital values', () => {
    const page = readPage(1, ['PCV 32 %', 'BP 120/80', 'BP 130/85']);
    const result = check(page, modelPage([
      modelItem({ kind: 'lab_result', asWritten: 'PCV 32 %', lineIds: ['p1-l1'], test: 'PCV', value: '23', unit: '%' }),
      modelItem({ kind: 'vital', asWritten: 'BP 120/80', lineIds: ['p1-l2'], measure: 'blood_pressure', value: '120/80' }),
      modelItem({ kind: 'vital', asWritten: 'BP 130/85', lineIds: ['p1-l3'], measure: 'blood_pressure', value: '130/85',
        unit: 'mmHg' }),
    ]));
    expect(result.items[0]!.checkReasons).toContain('value_mismatch');
    expect(result.items[1]!.checkReasons).toEqual([]);
    expect(result.items[2]!.checkReasons).toContain('unit_mismatch');
  });

  it('keeps a vital with no recognisable measure as a note to check', () => {
    const page = readPage(1, ['Reading 37']);
    const result = check(page, modelPage([modelItem({ kind: 'vital', asWritten: 'Reading 37', lineIds: ['p1-l1'],
      measure: 'none', value: '37' })]));
    expect(result.items[0]).toMatchObject({ kind: 'note', fields: { text: 'Reading 37' }, confidence: 'check_carefully' });
  });

  it('collapses an exact repeat of the same item', () => {
    const result = check(CLINIC_PAGE, modelPage([amlodipine, amlodipine]));
    expect(result.items).toHaveLength(1);
  });

  it('flags a possible missed item on a line nothing cited', () => {
    const result = check(CLINIC_PAGE, modelPage([amlodipine]));
    expect(result.flagReasons).toContain('possible_missed_item');
  });

  it('takes identity only as written on its cited lines', () => {
    const result = check(CLINIC_PAGE, modelPage([], { identity: { name: 'Test Patient Adaeze Example',
      dateOfBirth: '01/01/1990', folderNumber: 'TEST-0001', sex: '', lineIds: ['p1-l1'] } }));
    expect(result.identity).toEqual({ nameAsWritten: 'Test Patient Adaeze Example', dateOfBirthAsWritten: null,
      folderNumberAsWritten: 'TEST-0001', sexAsWritten: null, lineIds: ['p1-l1'], box: CLINIC_PAGE.lines[0]!.box });
  });

  it('grounds on the masked text the model saw and stores the original number', () => {
    const masker = createMasker();
    const page = readPage(1, ['Call 08030000000 if fever persists']);
    const lines = page.lines.map((line) => ({ ...line, text: masker.mask(line.text) }));
    const result = checkPage({ page: 1, lines, sourceSha256Hex: SOURCE_SHA, readBy: 'reread', masker,
      answer: modelPage([modelItem({ kind: 'note', asWritten: 'Call [hidden-number-1] if fever persists',
        lineIds: ['p1-l1'], noteText: 'Call [hidden-number-1] if fever persists' })]) });
    expect(result.items[0]).toMatchObject({ asWritten: 'Call 08030000000 if fever persists',
      fields: { text: 'Call 08030000000 if fever persists' }, readBy: 'reread' });
  });
});

describe('checkPage review fixes: fields held to the paper', () => {
  const reasons = (page: ReadPage, ...items: Parameters<typeof modelItem>[0][]) =>
    check(page, modelPage(items.map((item) => modelItem(item)))).items.map((item) => item.checkReasons);

  it('never clears a "no known allergies" the paper does not say, or one beside a named allergy', () => {
    const penicillin = readPage(1, ['Allergies: Penicillin - rash']);
    const [invented] = reasons(penicillin, { kind: 'allergy', asWritten: 'Allergies: Penicillin', lineIds: ['p1-l1'],
      noKnownAllergies: true });
    expect(invented).toContain('nkda_not_on_paper');
    const both = readPage(1, ['Allergies: NKDA. Allergic to penicillin']);
    expect(reasons(both, { kind: 'allergy', asWritten: 'NKDA', lineIds: ['p1-l1'], noKnownAllergies: true })[0])
      .toContain('nkda_conflicts');
    expect(reasons(readPage(1, ['No known drug allergies']), { kind: 'allergy', asWritten: 'No known drug allergies',
      lineIds: ['p1-l1'], noKnownAllergies: true })[0]).toEqual([]);
  });

  it('holds lab and vital values, units and signs to the item\'s own text', () => {
    expect(reasons(readPage(1, ['HIV -ve']), { kind: 'lab_result', asWritten: 'HIV -ve', lineIds: ['p1-l1'],
      test: 'HIV', value: '+ve' })[0]).toContain('value_mismatch');
    expect(reasons(readPage(1, ['HIV -ve']), { kind: 'lab_result', asWritten: 'HIV -ve', lineIds: ['p1-l1'],
      test: 'HIV', value: '-ve' })[0]).toEqual([]);
    expect(reasons(readPage(1, ['BP 120/80 PR 88']), { kind: 'vital', asWritten: 'BP 120/80', lineIds: ['p1-l1'],
      measure: 'blood_pressure', value: '80/120' })[0]).toContain('value_mismatch');
    const glucose = reasons(readPage(1, ['Glucose 5.4 mmol/L Creat 88 umol/L']), { kind: 'lab_result',
      asWritten: 'Glucose 5.4 mmol/L', lineIds: ['p1-l1'], test: 'Glucose', value: '88', unit: 'umol/L' })[0]!;
    expect(glucose).toEqual(expect.arrayContaining(['value_mismatch', 'unit_mismatch']));
    expect(reasons(readPage(1, ['Glucose 5.4mmol/L']), { kind: 'lab_result', asWritten: 'Glucose 5.4mmol/L',
      lineIds: ['p1-l1'], test: 'Glucose', value: '5.4', unit: 'mmol/L' })[0]).toEqual([]);
  });

  it('holds frequency and duration to the text as written, not as a set of numbers', () => {
    expect(reasons(readPage(1, ['Paracetamol 1g tds x 5/7']), { kind: 'medicine', asWritten: 'Paracetamol 1g tds x 5/7',
      lineIds: ['p1-l1'], name: 'Paracetamol', strength: '1g', frequency: 'tds', duration: '7/7', status: 'new' })[0])
      .toContain('duration_mismatch');
    expect(reasons(readPage(1, ['Metformin 500mg 1-0-1']), { kind: 'medicine', asWritten: 'Metformin 500mg 1-0-1',
      lineIds: ['p1-l1'], name: 'Metformin', strength: '500mg', frequency: '1-1-1', status: 'new' })[0])
      .toContain('frequency_mismatch');
  });

  it('flags a plain reading that swaps the dose, the frequency or the duration', () => {
    const page = readPage(1, ['Amlodipine 5mg od x 10/7']);
    const base = { kind: 'medicine' as const, asWritten: 'Amlodipine 5mg od x 10/7', lineIds: ['p1-l1'],
      name: 'Amlodipine', strength: '5mg', frequency: 'od', duration: '10/7', status: 'new' as const };
    expect(reasons(page, { ...base, plain: 'Amlodipine 10 mg twice a day for 5 days' })[0]).toContain('plain_mismatch');
    expect(reasons(page, { ...base, plain: 'Amlodipine 5 mg twice a day for 10 days' })[0]).toContain('plain_mismatch');
    expect(reasons(page, { ...base, plain: 'Amlodipine 5 mg once a day for 10 days' })[0]).toEqual([]);
  });

  it('keeps both of two different items read from the same words under unique ids, marked, and flags the page', () => {
    const page = readPage(1, ['Amlodipine 5mg + Lisinopril 10mg od']);
    const span = { kind: 'medicine' as const, asWritten: 'Amlodipine 5mg + Lisinopril 10mg od', lineIds: ['p1-l1'],
      status: 'new' as const };
    const result = check(page, modelPage([modelItem({ ...span, name: 'Amlodipine', strength: '5mg' }),
      modelItem({ ...span, name: 'Lisinopril', strength: '10mg', frequency: 'od' }),
      modelItem({ ...span, name: 'Lisinopril', strength: '10mg', frequency: 'od', plain: 'said differently' })]));
    const base = itemId(SOURCE_SHA, 'medicine', ['p1-l1'], span.asWritten);
    expect(result.items.map((item) => [item.id, (item.fields as { name: string }).name]))
      .toEqual([[base, 'Amlodipine'], [`${base}-2`, 'Lisinopril']]);
    for (const item of result.items) {
      expect(item.checkReasons).toContain('duplicate_source_span');
      expect(item.confidence).toBe('check_carefully');
      expect(item.checkReason).not.toBeNull();
    }
    expect(result.flagReasons).toContain('possible_missed_item');
  });

  it('collapses an exact repeat (same kind, lines, asWritten and fields) to one item, unflagged', () => {
    const page = readPage(1, ['Amlodipine 5mg od']);
    const once = { ...amlodipine, lineIds: ['p1-l1'] };
    const result = check(page, modelPage([once, { ...once, plain: 'Amlodipine 5 mg daily' }]));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe(itemId(SOURCE_SHA, 'medicine', ['p1-l1'], 'Amlodipine 5mg od'));
    expect(result.items[0]!.checkReasons).toEqual([]);
    expect(result.flagReasons).not.toContain('possible_missed_item');
  });

  it('suffixes repeated base ids in reading order (page, then first line) and keeps the item order', () => {
    const [first] = check(CLINIC_PAGE, modelPage([amlodipine])).items;
    const at = (page: number, line: number, name: string) => ({ ...first!, page, lineIds: [`p${page}-l${line}`],
      fields: { ...(first!.fields as object), name } } as typeof first & object);
    const items = uniqueItemIds([at(2, 1, 'c'), at(1, 4, 'b'), at(1, 2, 'a'), { ...first!, id: 'it-0000000000000001' }]);
    const base = first!.id;
    expect(items.map((item) => [item.id, (item.fields as { name: string }).name])).toEqual([
      [`${base}-3`, 'c'], [`${base}-2`, 'b'], [base, 'a'], ['it-0000000000000001', 'Amlodipine']]);
    expect(uniqueItemIds(items).map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it('holds a note\'s text, a form, a reaction and a lab flag to the paper', () => {
    const note = check(readPage(1, ['Review in 2/52']), modelPage([modelItem({ kind: 'note', asWritten: 'Review in 2/52',
      lineIds: ['p1-l1'], noteText: 'Start warfarin 5mg daily' })])).items[0]!;
    expect(note.fields).toEqual({ text: 'Review in 2/52' });
    expect(note.checkReasons).toContain('field_not_on_paper');
    expect(reasons(readPage(1, ['Tab Ceftriaxone 1g bd']), { kind: 'medicine', asWritten: 'Ceftriaxone 1g bd',
      lineIds: ['p1-l1'], name: 'Ceftriaxone', strength: '1g', frequency: 'bd', form: 'injection', status: 'new' })[0])
      .toContain('field_not_on_paper');
    expect(reasons(readPage(1, ['Penicillin allergy']), { kind: 'allergy', asWritten: 'Penicillin allergy',
      lineIds: ['p1-l1'], substance: 'Penicillin', reaction: 'anaphylaxis' })[0]).toContain('field_not_on_paper');
    expect(reasons(readPage(1, ['K 6.1']), { kind: 'lab_result', asWritten: 'K 6.1', lineIds: ['p1-l1'], test: 'K',
      value: '6.1', flag: 'H' })[0]).toContain('field_not_on_paper');
  });

  it('does not let a placeholder\'s index count as a number on the paper', () => {
    const masker = createMasker();
    const page = readPage(1, ['Amoxil 500mg tds Tel 08030000000']);
    const lines = page.lines.map((line) => ({ ...line, text: masker.mask(line.text) }));
    const result = checkPage({ page: 1, lines, sourceSha256Hex: SOURCE_SHA, readBy: 'first_pass', masker,
      answer: modelPage([modelItem({ kind: 'medicine', asWritten: 'Amoxil 500mg tds', lineIds: ['p1-l1'],
        name: 'Amoxil', strength: '500mg', frequency: 'tds', status: 'new', plain: 'Amoxil 1 g three times a day' })]) });
    expect(result.items[0]!.checkReasons).toContain('reading_number_mismatch');
  });

  it('flags the page for an illegible line no item cites', () => {
    const page = readPage(1, ['Amlodipine 5mg od', ['Warf?rn 5 nocte', { handwritten: true, confidence: 0.35 }]]);
    const result = check(page, modelPage([{ ...amlodipine, lineIds: ['p1-l1'] }]));
    expect(result.flagReasons).toContain('handwriting');
    expect(result.rereadReasons).not.toContain('low_confidence_handwriting');
  });

  describe('allergy severity', () => {
    const allergy = (text: string, severity: 'mild' | 'moderate' | 'severe' | 'unknown' | 'none', extra = {}) =>
      check(readPage(1, [text]), modelPage([modelItem({ kind: 'allergy', asWritten: text, lineIds: ['p1-l1'],
        substance: 'Penicillin', severity, plain: 'Penicillin allergy', ...extra })])).items[0]!;

    it('keeps a severity written on the cited lines, and none as null', () => {
      expect(allergy('Penicillin allergy - mild rash', 'mild', { reaction: 'rash' })).toMatchObject({
        fields: { substance: 'Penicillin', reaction: 'rash', severity: 'mild', noKnownAllergies: false },
        confidence: 'clear' });
      expect(allergy('Penicillin allergy (Moderate)', 'moderate').checkReasons).toEqual([]);
      expect(allergy('Penicillin allergy SEVERE', 'severe').checkReasons).toEqual([]);
      expect(allergy('Penicillin allergy', 'none').fields).toMatchObject({ severity: null });
      expect(allergy('Penicillin allergy, severity unknown', 'unknown').fields).toMatchObject({ severity: 'unknown' });
    });

    it('accepts anaphylaxis as severe', () => {
      const item = allergy('Penicillin allergy - anaphylaxis', 'severe', { reaction: 'anaphylaxis' });
      expect(item.fields).toMatchObject({ severity: 'severe' });
      expect(item.checkReasons).toEqual([]);
      expect(allergy('Penicillin - anaphylactic shock', 'severe').checkReasons).toEqual([]);
    });

    it('flags a severity the cited lines do not write', () => {
      expect(allergy('Penicillin allergy', 'severe').checkReasons).toContain('field_not_on_paper');
      expect(allergy('Penicillin allergy - anaphylaxis', 'mild').checkReasons).toContain('field_not_on_paper');
      expect(allergy('Penicillin allergy - severe', 'moderate').checkReasons).toContain('field_not_on_paper');
      expect(allergy('Penicillin allergy - severely', 'severe').checkReasons).toContain('field_not_on_paper');
    });

    it('does not let a no-known-allergies statement carry a severity', () => {
      const item = check(readPage(1, ['Allergies: NKDA']), modelPage([modelItem({ kind: 'allergy', asWritten: 'NKDA',
        lineIds: ['p1-l1'], noKnownAllergies: true, severity: 'severe' })])).items[0]!;
      expect(item.fields).toMatchObject({ severity: null, noKnownAllergies: true });
      expect(item.checkReasons).toContain('nkda_conflicts');
    });

    it("holds each allergy's severity and reaction to its own part of a shared line", () => {
      const text = 'Allergies: Sulfa - mild rash, Penicillin - anaphylaxis';
      const read = (penicillin: object, sulfa: object) => check(readPage(1, [text]), modelPage([
        modelItem({ kind: 'allergy', asWritten: 'Penicillin - anaphylaxis', lineIds: ['p1-l1'], substance: 'Penicillin',
          plain: 'Penicillin allergy', ...penicillin }),
        modelItem({ kind: 'allergy', asWritten: 'Sulfa - mild rash', lineIds: ['p1-l1'], substance: 'Sulfa',
          plain: 'Sulfa allergy', ...sulfa }),
      ])).items;
      const swapped = read({ severity: 'mild', reaction: 'rash' }, { severity: 'severe', reaction: 'anaphylaxis' });
      expect(swapped.map((item) => item.confidence)).toEqual(['check_carefully', 'check_carefully']);
      for (const item of swapped) expect(item.checkReasons).toContain('field_not_on_paper');
      const right = read({ severity: 'severe', reaction: 'anaphylaxis' }, { severity: 'mild', reaction: 'rash' });
      expect(right.map((item) => [item.confidence, item.checkReasons])).toEqual([['clear', []], ['clear', []]]);
    });

    it('does not take a negated or hyphen-joined severity word as the severity', () => {
      expect(allergy('Penicillin - non-severe rash', 'severe').checkReasons).toContain('field_not_on_paper');
      expect(allergy('Penicillin - non severe rash', 'severe').checkReasons).toContain('field_not_on_paper');
      expect(allergy('Penicillin - not severe', 'severe').checkReasons).toContain('field_not_on_paper');
      expect(allergy('Penicillin - rash, no anaphylaxis', 'severe').checkReasons).toContain('field_not_on_paper');
      expect(allergy('Penicillin - rash - severe', 'severe').checkReasons).toEqual([]);
    });

    it("keeps 'unknown' only where the paper says the severity is not known", () => {
      expect(allergy('Penicillin allergy', 'unknown').checkReasons).toContain('field_not_on_paper');
      expect(allergy('Penicillin allergy, severity not known', 'unknown').checkReasons).toEqual([]);
      expect(allergy('Penicillin allergy, severity unknown', 'unknown').checkReasons).toEqual([]);
    });
  });

  describe('units written straight after a number, and combined strengths', () => {
    const vital = (line: string, measure: 'oxygen_saturation' | 'temperature', value: string, unit: string) =>
      reasons(readPage(1, [line]), { kind: 'vital', asWritten: line, lineIds: ['p1-l1'], measure, value, unit })[0]!;
    const lab = (line: string, value: string, unit: string) =>
      reasons(readPage(1, [line]), { kind: 'lab_result', asWritten: line, lineIds: ['p1-l1'], test: 'PCV', value,
        unit })[0]!;

    it('finds "%" and "°C" written straight after the reading', () => {
      expect(vital('SpO2: 97%', 'oxygen_saturation', '97', '%')).toEqual([]);
      expect(vital('SpO2: 97 %', 'oxygen_saturation', '97', '%')).toEqual([]);
      expect(vital('SpO2 (%): 97', 'oxygen_saturation', '97', '%')).toEqual([]);
      expect(vital('T 36.1°C', 'temperature', '36.1', '°C')).toEqual([]);
      expect(vital('T 36.1°C', 'temperature', '36.1', 'C')).toEqual([]);
      expect(vital('T 36.1C', 'temperature', '36.1', '°C')).toEqual([]);
      expect(lab('PCV: 32%', '32', '%')).toEqual([]);
    });

    it('still refuses another number, a part of one, or another unit', () => {
      expect(vital('SpO2: 197%', 'oxygen_saturation', '97', '%')).toContain('value_mismatch');
      expect(vital('SpO2: 197%', 'oxygen_saturation', '97', '%')).toContain('unit_mismatch');
      expect(vital('SpO2: 9.7%', 'oxygen_saturation', '97', '%')).toContain('value_mismatch');
      expect(vital('T 36.1°F', 'temperature', '36.1', '°C')).toContain('unit_mismatch');
      expect(vital('T 36.1°C', 'temperature', '36.1', '°F')).toContain('unit_mismatch');
      // The "%" is 32's, not 97's.
      expect(reasons(readPage(1, ['SpO2 97 PCV 32%']), { kind: 'vital', asWritten: 'SpO2 97 PCV 32%',
        lineIds: ['p1-l1'], measure: 'oxygen_saturation', value: '97', unit: '%' })[0]).toContain('unit_mismatch');
    });

    it('refuses a fragment of a number OCR split or joined, and one end of a range', () => {
      // A number split by a space, or broken after its decimal point: "97" of "1 97%" is not the reading.
      expect(vital('SpO2: 1 97%', 'oxygen_saturation', '97', '%')).toContain('unit_mismatch');
      expect(vital('T 3 6.1°C', 'temperature', '6.1', '°C')).toContain('unit_mismatch');
      expect(lab('PCV: 3 2%', '2', '%')).toContain('unit_mismatch');
      expect(vital('SpO2 9. 7%', 'oxygen_saturation', '7', '%')).toContain('unit_mismatch');
      expect(vital('T 36. 1°C', 'temperature', '1', '°C')).toContain('unit_mismatch');
      // A range with a dash or a spaced hyphen, and a decimal written with a middle dot.
      expect(vital('SpO2 92–97%', 'oxygen_saturation', '97', '%')).toContain('unit_mismatch');
      expect(vital('SpO2 92 - 97%', 'oxygen_saturation', '97', '%')).toContain('unit_mismatch');
      expect(lab('PCV 30 – 32%', '32', '%')).toContain('unit_mismatch');
      expect(vital('T 36·1°C', 'temperature', '1', '°C')).toContain('unit_mismatch');
      expect(vital('T 36·1°C', 'temperature', '36', '°C')).toContain('unit_mismatch');
      // A digit ending a word is not a number of its own.
      expect(vital('SpO2 97%', 'oxygen_saturation', '97', '%')).toEqual([]);
    });

    it('does not credit one reading\'s unit to the same number written again for another', () => {
      expect(reasons(readPage(1, ['SpO2 97% HR 97']), { kind: 'vital', asWritten: 'SpO2 97% HR 97',
        lineIds: ['p1-l1'], measure: 'pulse', value: '97', unit: '%' })[0]).toContain('unit_mismatch');
      expect(vital('SpO2 97% (97%)', 'oxygen_saturation', '97', '%')).toEqual([]);
    });

    const artemether = (line: string, overrides: Parameters<typeof modelItem>[0]) =>
      reasons(readPage(1, [line]), { kind: 'medicine', asWritten: line, lineIds: ['p1-l1'],
        name: 'Artemether/Lumefantrine', strength: '80/480mg', frequency: 'bd', status: 'current', ...overrides })[0]!;

    it('accepts a combined strength restated whole in the plain reading or the fields', () => {
      const line = 'Artemether/Lumefantrine 80/480mg bd';
      expect(artemether(line, { plain: 'Artemether/Lumefantrine 80/480 mg twice a day' })).toEqual([]);
      expect(artemether(line, { plain: 'Artemether/Lumefantrine 80 mg/480 mg twice a day' })).toEqual([]);
      expect(artemether(line, { plain: 'Artemether/Lumefantrine 80/480mg twice a day', strength: '80 mg/480 mg' }))
        .toEqual([]);
      expect(artemether('Artemether/Lumefantrine 80/480 mg bd',
        { plain: 'Artemether/Lumefantrine 80 mg/480 mg twice a day', strength: '80/480 mg' })).toEqual([]);
    });

    it('refuses a different combined strength, or a part of a longer number', () => {
      const line = 'Artemether/Lumefantrine 80/480mg bd';
      expect(artemether(line, { plain: 'Artemether/Lumefantrine 20/120 mg twice a day' })).toContain('plain_mismatch');
      expect(artemether(line, { plain: 'Artemether/Lumefantrine 80/480 mg twice a day', strength: '20/120mg' }))
        .toEqual(expect.arrayContaining(['strength_mismatch', 'strength_not_as_written']));
      expect(artemether('Artemether/Lumefantrine 1480 mg bd', { strength: '1480 mg',
        plain: 'Artemether/Lumefantrine 480 mg twice a day' })).toContain('plain_mismatch');
      expect(reasons(readPage(1, ['Bisoprolol 2.5 mg od']), { kind: 'medicine', asWritten: 'Bisoprolol 2.5 mg od',
        lineIds: ['p1-l1'], name: 'Bisoprolol', strength: '2.5 mg', frequency: 'od', status: 'current',
        plain: 'Bisoprolol 5 mg once a day' })[0]).toContain('plain_mismatch');
    });

    it('refuses one part of a combined strength written with a unit on each part', () => {
      const spaced = 'Artemether/Lumefantrine 80 mg/480 mg bd';
      const glued = 'Artemether/Lumefantrine 80mg/480mg bd';
      // A plain reading that gives one part as the dose.
      expect(artemether(spaced, { strength: '80/480 mg', plain: 'Artemether/Lumefantrine 480 mg twice a day' }))
        .toContain('plain_mismatch');
      expect(artemether(spaced, { plain: 'Artemether/Lumefantrine 80 mg twice a day' })).toContain('plain_mismatch');
      expect(artemether(glued, { plain: 'Artemether/Lumefantrine 480mg twice a day' })).toContain('plain_mismatch');
      // A strength field that takes one part for the whole.
      for (const strength of ['80mg', '80 mg', '480mg', '480 mg']) {
        expect(artemether(spaced, { strength, plain: `Artemether/Lumefantrine ${strength} twice a day` }))
          .toContain('strength_not_as_written');
        expect(artemether(glued, { strength, plain: `Artemether/Lumefantrine ${strength} twice a day` }))
          .toContain('strength_not_as_written');
      }
      // The whole combined strength still reads clear on either paper.
      expect(artemether(spaced, { strength: '80/480 mg', plain: 'Artemether/Lumefantrine 80/480 mg twice a day' }))
        .toEqual([]);
      expect(artemether(glued, { plain: 'Artemether/Lumefantrine 80 mg/480 mg twice a day' })).toEqual([]);
    });

    it('does not re-read a page whose readings are only written this way', () => {
      const page = readPage(1, ['SpO2: 97%', 'T 36.1°C', 'PCV: 32%', 'Artemether/Lumefantrine 80/480mg bd']);
      const result = check(page, modelPage([
        modelItem({ kind: 'vital', asWritten: 'SpO2: 97%', lineIds: ['p1-l1'], measure: 'oxygen_saturation',
          value: '97', unit: '%' }),
        modelItem({ kind: 'vital', asWritten: 'T 36.1°C', lineIds: ['p1-l2'], measure: 'temperature', value: '36.1',
          unit: '°C' }),
        modelItem({ kind: 'lab_result', asWritten: 'PCV: 32%', lineIds: ['p1-l3'], test: 'PCV', value: '32',
          unit: '%' }),
        modelItem({ kind: 'medicine', asWritten: 'Artemether/Lumefantrine 80/480mg bd', lineIds: ['p1-l4'],
          name: 'Artemether/Lumefantrine', strength: '80/480mg', frequency: 'bd', status: 'current',
          plain: 'Artemether/Lumefantrine 80/480 mg twice a day' }),
      ]));
      expect(result.items.map((item) => item.checkReasons)).toEqual([[], [], [], []]);
      expect(result.rereadReasons).toEqual([]);
      expect(result.flagReasons).not.toContain('low_confidence');
    });
  });
});

describe('checkPage holds each reading to its own label, dose and wording', () => {
  const one = (line: string | string[], item: Parameters<typeof modelItem>[0]) => {
    const lines = typeof line === 'string' ? [line] : line;
    const result = check(readPage(1, lines), modelPage([modelItem({ lineIds: lines.map((_, n) => `p1-l${n + 1}`),
      ...item })]));
    return result.items[0]!;
  };

  it('flags a vital with another reading\'s number or a measure the paper does not label', () => {
    const line = 'Temp 38.5 Pulse 110';
    const temp = one(line, { kind: 'vital', asWritten: line, measure: 'temperature', value: '110' });
    expect(temp.confidence).toBe('check_carefully');
    expect(temp.checkReasons).toContain('value_mismatch');
    expect(one('T 37 P 88', { kind: 'vital', asWritten: 'T 37 P 88', measure: 'pulse', value: '37' }).checkReasons)
      .toContain('value_mismatch');
    const height = one('Wt 70', { kind: 'vital', asWritten: 'Wt 70', measure: 'height', value: '70' });
    expect(height.checkReasons).toContain('measure_mismatch');
    expect(height.checkReason).toBe("What was measured doesn't match the label on the paper.");
    // Each reading under its own label stays clear.
    expect(one(line, { kind: 'vital', asWritten: line, measure: 'temperature', value: '38.5' }).checkReasons).toEqual([]);
    expect(one(line, { kind: 'vital', asWritten: line, measure: 'pulse', value: '110' }).checkReasons).toEqual([]);
    expect(one('T 37 P 88', { kind: 'vital', asWritten: 'T 37 P 88', measure: 'pulse', value: '88' }).checkReasons)
      .toEqual([]);
    expect(one('BP 120/80 mmHg', { kind: 'vital', asWritten: 'BP 120/80 mmHg', measure: 'blood_pressure',
      value: '120/80', unit: 'mmHg' }).checkReasons).toEqual([]);
  });

  it('flags a lab value that belongs to another test on the same words', () => {
    const line = 'Hb 9.8 WBC 12.4';
    const hb = one(line, { kind: 'lab_result', asWritten: line, test: 'Hb', value: '12.4' });
    expect(hb.confidence).toBe('check_carefully');
    expect(hb.checkReasons).toContain('value_mismatch');
    expect(one(line, { kind: 'lab_result', asWritten: line, test: 'Hb', value: '9.8' }).checkReasons).toEqual([]);
    expect(one(line, { kind: 'lab_result', asWritten: line, test: 'WBC', value: '12.4' }).checkReasons).toEqual([]);
    expect(one('HIV -ve HBsAg +ve', { kind: 'lab_result', asWritten: 'HIV -ve HBsAg +ve', test: 'HIV', value: '+ve' })
      .checkReasons).toContain('value_mismatch');
  });

  it('puts a ruled-out diagnosis, a stopped or withheld medicine and a negated allergy in doubt', () => {
    const cases: [string, Parameters<typeof modelItem>[0]][] = [
      ['No malaria', { kind: 'diagnosis', asWritten: 'malaria', name: 'malaria', status: 'confirmed' }],
      ['Malaria RDT negative', { kind: 'diagnosis', asWritten: 'Malaria', name: 'Malaria', status: 'confirmed' }],
      ['Not hypertensive', { kind: 'diagnosis', asWritten: 'hypertensive', name: 'hypertensive', status: 'confirmed' }],
      ['Stop Metformin 500mg bd', { kind: 'medicine', asWritten: 'Metformin 500mg bd', name: 'Metformin',
        strength: '500mg', frequency: 'bd', status: 'current' }],
      ['Metformin 500mg bd - withheld', { kind: 'medicine', asWritten: 'Metformin 500mg bd', name: 'Metformin',
        strength: '500mg', frequency: 'bd', status: 'current' }],
      ['Allergies: no penicillin allergy', { kind: 'allergy', asWritten: 'penicillin', substance: 'penicillin' }],
      ['Penicillin -ve', { kind: 'allergy', asWritten: 'Penicillin', substance: 'Penicillin' }],
    ];
    for (const [line, item] of cases) {
      const read = one(line, item);
      expect([line, read.confidence, read.checkReasons]).toEqual([line, 'check_carefully', ['status_cue_on_line']]);
    }
    // An allergy the paper states plainly, and one beside a negated severity, stay clear.
    expect(one('Allergies: Penicillin - rash', { kind: 'allergy', asWritten: 'Penicillin - rash',
      substance: 'Penicillin', reaction: 'rash' }).checkReasons).toEqual([]);
    expect(one('Allergies: Penicillin - rash, not severe', { kind: 'allergy', asWritten: 'Penicillin - rash',
      substance: 'Penicillin', reaction: 'rash' }).checkReasons).toEqual([]);
  });

  it('holds a medicine\'s dose and frequency to its own line and its own place on a line', () => {
    const lines = ['Amlodipine 5mg od', 'Lisinopril 10mg od'];
    const twoLines = check(readPage(1, lines), modelPage([modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg od',
      lineIds: ['p1-l1', 'p1-l2'], name: 'Amlodipine', strength: '10mg', frequency: 'od', status: 'current' })]));
    expect(twoLines.items[0]!.confidence).toBe('check_carefully');
    expect(twoLines.items[0]!.checkReasons).toEqual(expect.arrayContaining(['strength_mismatch',
      'strength_not_as_written']));
    const line = 'Paracetamol 1g tds Ibuprofen 400mg bd';
    const wrong = one(line, { kind: 'medicine', asWritten: line, name: 'Paracetamol', strength: '400mg', frequency: 'bd',
      status: 'current' });
    expect(wrong.confidence).toBe('check_carefully');
    expect(wrong.checkReasons).toEqual(expect.arrayContaining(['strength_not_as_written', 'frequency_mismatch']));
    expect(one(line, { kind: 'medicine', asWritten: 'Paracetamol 1g tds', name: 'Paracetamol', strength: '400mg',
      frequency: 'tds', status: 'current' }).checkReasons).toContain('strength_not_as_written');
    expect(one(line, { kind: 'medicine', asWritten: line, name: 'Paracetamol', strength: '1g', frequency: 'tds',
      status: 'current' }).checkReasons).toEqual([]);
    expect(one('Paracetamol 500mg 2 tabs tds', { kind: 'medicine', asWritten: 'Paracetamol 500mg 2 tabs tds',
      name: 'Paracetamol', strength: '500mg', frequency: 'tds', status: 'current' }).checkReasons).toEqual([]);
  });

  it('reads "5/7" in a duration as 5 days, and a unit spelled out in plain as its abbreviation', () => {
    const line = 'Amoxicillin 500mg tds x 5/7';
    const base = { kind: 'medicine' as const, asWritten: line, name: 'Amoxicillin', strength: '500mg', frequency: 'tds',
      duration: '5/7', status: 'new' as const };
    expect(one(line, { ...base, plain: 'Amoxicillin 500 mg three times a day for 7 days' }).checkReasons)
      .toContain('plain_mismatch');
    expect(one(line, { ...base, plain: 'Amoxicillin 500 mg three times a day for 5 days' }).checkReasons).toEqual([]);
    const tds = { ...base, asWritten: 'Amoxicillin 500mg tds', duration: '' };
    expect(one('Amoxicillin 500mg tds', { ...tds, plain: 'Amoxicillin 500 micrograms three times a day' }).checkReasons)
      .toContain('plain_mismatch');
    expect(one('Amoxicillin 500mg tds', { ...tds, plain: 'Amoxicillin 500 milligrams three times a day' }).checkReasons)
      .toEqual([]);
  });

  it('flags a plain reading that reverses a result or adds a severity the paper does not give', () => {
    expect(one('MP -ve', { kind: 'lab_result', asWritten: 'MP -ve', test: 'MP', value: '-ve',
      plain: 'Malaria parasite positive' }).checkReasons).toEqual(['plain_contradicts']);
    expect(one('MP: negative', { kind: 'lab_result', asWritten: 'MP: negative', test: 'MP', value: 'negative',
      plain: 'Malaria parasite test positive' }).checkReasons).toEqual(['plain_contradicts']);
    expect(one('MP -ve', { kind: 'lab_result', asWritten: 'MP -ve', test: 'MP', value: '-ve',
      plain: 'Malaria parasite test negative (not seen)' }).checkReasons).toEqual([]);
    const allergy = one('Allergy: penicillin - rash', { kind: 'allergy', asWritten: 'penicillin - rash',
      substance: 'penicillin', reaction: 'rash', plain: 'Allergic to penicillin, severe' });
    expect(allergy.checkReasons).toEqual(['plain_contradicts']);
    expect(allergy.checkReason).toBe("The plain reading says something the paper doesn't.");
    expect(one('Allergy: penicillin - rash', { kind: 'allergy', asWritten: 'penicillin - rash', substance: 'penicillin',
      reaction: 'rash', plain: 'Allergic to penicillin (rash)' }).checkReasons).toEqual([]);
  });
});
