import { checkPage, checkReasonSentence, itemId, mergeIdentity, mergeReread, uniqueItemIds } from './items';
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

describe('checkPage for a page read from its picture (image re-read)', () => {
  const hard = { handwritten: true, confidence: 0.55 };
  // Line boxes (fixtures): left 0.1, width 0.5, height 0.02, top 0.05 x line number.
  const page = readPage(1, [['Amlodipne 5rng od', hard], ['Metformin 500mg bd', { handwritten: true, confidence: 0.9 }],
    ['Paracetamol 1g tds', hard], 'Dx: Hypertension']);
  const fromImage = (answer: ModelPage) => checkPage({ page: 1, lines: page.lines, answer, sourceSha256Hex: SOURCE_SHA,
    readBy: 'reread', masker: createMasker(), fromImage: true });
  const onLine = (n: number) => ({ left: 0.12, top: 0.05 * n, width: 0.3, height: 0.02 });

  it('keeps an item whose box sits on its cited lines, check_carefully, with its own box and the picture reason', () => {
    const result = fromImage(modelPage([modelItem({ kind: 'medicine', asWritten: 'Metformin 500mg bd', lineIds: ['p1-l2'],
      name: 'Metformin', strength: '500mg', frequency: 'bd', status: 'current', plain: 'Metformin 500 mg twice a day',
      box: onLine(2) })]));
    expect(result.droppedUngrounded).toBe(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ readBy: 'reread', confidence: 'check_carefully', box: onLine(2),
      checkReason: 'This was read from the picture of the page; check it against the paper.' });
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(['read_from_image', 'handwritten']));
    expect(result.items[0]!.checkReasons).not.toContain('number_not_in_text_read');
  });

  it('keeps an item the service misread (no text match needed), with the picture sentence, not a dose disagreement', () => {
    const result = fromImage(modelPage([modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg od', lineIds: ['p1-l1'],
      name: 'Amlodipine', strength: '5mg', frequency: 'od', status: 'current', box: onLine(1) })]));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.asWritten).toBe('Amlodipine 5mg od');
    // Held to what was read in the picture, not to the line text "Amlodipne 5rng od".
    expect(result.items[0]!.checkReasons).toEqual(['low_ocr_confidence_handwritten', 'handwritten', 'read_from_image']);
    expect(result.items[0]!.checkReason).toBe('This was read from the picture of the page; check it against the paper.');
    expect(result.items[0]!.fields).toMatchObject({ name: 'Amlodipine', strength: '5mg', frequency: 'od' });
    // The corrected item does not make its page look as if it left something out of its line (a one-line page,
    // so no uncited line counts either).
    const alone = checkPage({ page: 1, lines: page.lines.slice(0, 1), sourceSha256Hex: SOURCE_SHA, readBy: 'reread',
      masker: createMasker(), fromImage: true, answer: modelPage([modelItem({ kind: 'medicine',
        asWritten: 'Amlodipine 5mg od', lineIds: ['p1-l1'], name: 'Amlodipine', strength: '5mg', frequency: 'od',
        status: 'current', box: onLine(1) })]) });
    expect(alone.items).toHaveLength(1);
    expect(alone.flagReasons).not.toContain('possible_missed_item');
    // The same answer read from the text alone is not grounded and is dropped.
    const textOnly = checkPage({ page: 1, lines: page.lines, sourceSha256Hex: SOURCE_SHA, readBy: 'reread',
      masker: createMasker(), answer: modelPage([modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg od',
        lineIds: ['p1-l1'], name: 'Amlodipine', strength: '5mg', frequency: 'od', status: 'current' })]) });
    expect(textOnly.items).toEqual([]);
    expect(textOnly.droppedUngrounded).toBe(1);
  });

  it('drops an item placed away from its cited lines, citing an unknown line or one on another page, or with no box', () => {
    const base = { kind: 'note' as const, asWritten: 'Hypertension', noteText: 'Hypertension' };
    const result = fromImage(modelPage([
      modelItem({ ...base, lineIds: ['p1-l4'], box: { left: 0.1, top: 0.8, width: 0.3, height: 0.05 } }),
      modelItem({ ...base, lineIds: ['p1-l4', 'p1-l9'], box: onLine(4) }),
      modelItem({ ...base, lineIds: ['p2-l4'], box: onLine(4) }),
      modelItem({ ...base, lineIds: ['p1-l4'] }),
      modelItem({ ...base, lineIds: [], box: onLine(4) }),
      modelItem({ ...base, lineIds: ['p1-l4'], box: { left: 1.2, top: 0.2, width: 0.3, height: 0.02 } }),
    ]));
    expect(result.items).toEqual([]);
    expect(result.droppedUngrounded).toBe(6);
    expect(JSON.stringify(result)).not.toContain('Hypertension');
  });

  it("still holds an item's own fields to what it read in the picture", () => {
    const result = fromImage(modelPage([modelItem({ kind: 'medicine', asWritten: 'Amlodipine 5mg od', lineIds: ['p1-l1'],
      name: 'Amlodipine', strength: '10mg', frequency: 'od', status: 'current', box: onLine(1) })]));
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(['strength_mismatch', 'read_from_image',
      'number_not_in_text_read']));
  });

  describe('place: each cited line on its own, little on uncited lines, a real box, a text anchor', () => {
    const note = (lineIds: string[], box: { left: number; top: number; width: number; height: number },
      asWritten = 'Paracetamol tds') => modelItem({ kind: 'note', asWritten, noteText: asWritten, lineIds, box });

    it('drops an item citing lines 1 and 4 whose box sits on the uncited line 3', () => {
      const result = fromImage(modelPage([note(['p1-l1', 'p1-l4'], onLine(3), 'Amlodipne Hypertension')]));
      expect(result.items).toEqual([]);
      expect(result.droppedUngrounded).toBe(1);
    });

    it('drops a tiny box inside a cited line', () => {
      expect(fromImage(modelPage([note(['p1-l2'], { left: 0.2, top: 0.105, width: 0.001, height: 0.001 },
        'Metformin')])).items).toEqual([]);
    });

    it('drops a made-up item with a cited line box copied, when it shares no word or number with that line', () => {
      const lineBox = page.lines[0]!.box!;
      const result = fromImage(modelPage([modelItem({ kind: 'medicine', asWritten: 'Warfarin 10mg bd', lineIds: ['p1-l1'],
        name: 'Warfarin', strength: '10mg', frequency: 'bd', status: 'current', box: lineBox })]));
      expect(result.items).toEqual([]);
      expect(result.droppedUngrounded).toBe(1);
      expect(JSON.stringify(result)).not.toContain('Warfarin');
    });

    it('drops an item over two cited lines that are not adjacent, and one on a cited line that lies mostly on an uncited one', () => {
      // Lines 2 and 3 are a line and a half apart (gap 0.03, height 0.02): not together, so dropped.
      const apart = fromImage(modelPage([note(['p1-l2', 'p1-l3'], { left: 0.12, top: 0.1, width: 0.3, height: 0.07 },
        'Metformin Paracetamol')]));
      expect(apart.items).toEqual([]);
      // Cites line 2 only, but most of the line area under the box is line 3's.
      const spill = fromImage(modelPage([note(['p1-l2'], { left: 0.12, top: 0.11, width: 0.3, height: 0.06 }, 'Metformin')]));
      expect(spill.items).toEqual([]);
    });
  });

  describe('limits: at most three lines, lying together, and a box not much larger than its lines', () => {
    // Lines 1-4 one under the other (gap 0.005, height 0.02); line 5 short and alone lower down.
    const at = (top: number, width = 0.5) => ({ box: { left: 0.1, top, width, height: 0.02 } });
    const dense = readPage(1, [['Amlodipne 5rng od', { ...hard, ...at(0.1) }],
      ['Metformin 500mg bd', { ...hard, ...at(0.125) }], ['Paracetamol 1g tds', { ...hard, ...at(0.15) }],
      ['Dx: Hypertension', at(0.175)], ['BP 140/90', { ...hard, ...at(0.5, 0.1) }],
      ['Weight 70kg', { ...hard, ...at(0.7) }]]);
    const read = (lineIds: string[], box: { left: number; top: number; width: number; height: number },
      asWritten = 'Metformin Paracetamol') => checkPage({ page: 1, lines: dense.lines, sourceSha256Hex: SOURCE_SHA,
      readBy: 'reread', masker: createMasker(), fromImage: true,
      answer: modelPage([modelItem({ kind: 'note', asWritten, noteText: asWritten, lineIds, box })]) });

    it('drops a whole-page box that cites every line', () => {
      const result = read(dense.lines.map((line) => line.id), { left: 0, top: 0, width: 1, height: 1 });
      expect(result.items).toEqual([]);
      expect(result.droppedUngrounded).toBe(1);
    });

    it('drops an item citing four lines, even with a box just around them', () => {
      const result = read(['p1-l1', 'p1-l2', 'p1-l3', 'p1-l4'], { left: 0.1, top: 0.1, width: 0.5, height: 0.095 });
      expect(result.items).toEqual([]);
      expect(result.droppedUngrounded).toBe(1);
      // The same box citing three of those lines is kept.
      expect(read(['p1-l1', 'p1-l2', 'p1-l3'], { left: 0.1, top: 0.1, width: 0.5, height: 0.07 }).items).toHaveLength(1);
    });

    it('keeps an item over two adjacent lines, and drops one over two lines that are not together', () => {
      const kept = read(['p1-l2', 'p1-l3'], { left: 0.1, top: 0.125, width: 0.5, height: 0.045 });
      expect(kept.items).toHaveLength(1);
      expect(kept.items[0]!.lineIds).toEqual(['p1-l2', 'p1-l3']);
      expect(kept.droppedUngrounded).toBe(0);
      // Lines 2 and 5: far apart, so a box over both (and the lines between) is dropped.
      expect(read(['p1-l2', 'p1-l5'], { left: 0.1, top: 0.125, width: 0.5, height: 0.395 }, 'Metformin 140/90').items)
        .toEqual([]);
    });

    it('drops an item citing one line whose box also lies on an uncited neighbour line', () => {
      const vitals = readPage(1, [['BP 120/80', { box: { left: 0.1, top: 0.5, width: 0.3, height: 0.02 } }],
        ['Pulse 72', { box: { left: 0.1, top: 0.525, width: 0.3, height: 0.02 } }]]);
      const check = (box: { left: number; top: number; width: number; height: number }) => checkPage({ page: 1,
        lines: vitals.lines, sourceSha256Hex: SOURCE_SHA, readBy: 'reread', masker: createMasker(), fromImage: true,
        answer: modelPage([modelItem({ kind: 'note', asWritten: 'BP 120/80 Pulse 72', noteText: 'BP 120/80 Pulse 72',
          lineIds: ['p1-l1'], box })]) });
      // Over both lines (within the area limit): dropped, because it covers "Pulse 72", which it does not cite.
      const both = check({ left: 0.1, top: 0.5, width: 0.3, height: 0.045 });
      expect(both.items).toEqual([]);
      expect(both.droppedUngrounded).toBe(1);
      // On its own line only: kept.
      expect(check({ left: 0.1, top: 0.5, width: 0.3, height: 0.02 }).items).toHaveLength(1);
    });

    it('allows at most 2 x the line area plus 0.002 of the page', () => {
      // Line 5: width 0.1, height 0.02 (area 0.002), so the allowed area is 2 x 0.002 + 0.002 = 0.006.
      expect(read(['p1-l5'], { left: 0.1, top: 0.48, width: 0.1, height: 0.059 }, 'BP 140/90').items).toHaveLength(1);
      expect(read(['p1-l5'], { left: 0.1, top: 0.48, width: 0.1, height: 0.062 }, 'BP 140/90').items).toEqual([]);
      // Line 6: width 0.5, height 0.02 (area 0.01), allowed 0.022. A box three times the line's height (0.03) is
      // dropped; one just inside the limit, and inside the side limit, is kept.
      expect(read(['p1-l6'], { left: 0.1, top: 0.68, width: 0.5, height: 0.06 }, 'Weight 70kg').items).toEqual([]);
      expect(read(['p1-l6'], { left: 0.04, top: 0.6925, width: 0.6, height: 0.035 }, 'Weight 70kg').items).toHaveLength(1);
    });

    it("lets a box run past its lines' left and right edges by at most a quarter of their width in total", () => {
      // Line 5 runs 0.1-0.2. A box 2.2 times as wide (into blank space, within the area limit) is dropped.
      expect(read(['p1-l5'], { left: 0.05, top: 0.5, width: 0.22, height: 0.02 }, 'BP 140/90').items).toEqual([]);
      // 0.025 past its edges in total: kept; 0.03: dropped.
      expect(read(['p1-l5'], { left: 0.09, top: 0.5, width: 0.125, height: 0.02 }, 'BP 140/90').items).toHaveLength(1);
      expect(read(['p1-l5'], { left: 0.085, top: 0.5, width: 0.13, height: 0.02 }, 'BP 140/90').items).toEqual([]);
    });

    it('drops a box much larger than its cited line, and keeps one a little larger than a short line', () => {
      const large = read(['p1-l5'], { left: 0.05, top: 0.47, width: 0.5, height: 0.08 }, 'BP 140/90');
      expect(large.items).toEqual([]);
      expect(large.droppedUngrounded).toBe(1);
      expect(read(['p1-l5'], { left: 0.095, top: 0.497, width: 0.11, height: 0.026 }, 'BP 140/90').items).toHaveLength(1);
    });
  });

  it('stores the model box clipped to the page, and flags a number the text read does not have', () => {
    const result = fromImage(modelPage([modelItem({ kind: 'medicine', asWritten: 'Paracetamol 1g qds 5/7', lineIds: ['p1-l3'],
      name: 'Paracetamol', strength: '1g', frequency: 'qds', duration: '5/7', status: 'new',
      box: { left: -0.05, top: 0.14, width: 0.5, height: 0.04 } })]));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.box).toEqual({ left: 0, top: 0.14, width: 0.45, height: 0.04 });
    expect(result.items[0]!.checkReasons).toEqual(expect.arrayContaining(['read_from_image', 'number_not_in_text_read']));
    expect(result.items[0]!.confidence).toBe('check_carefully');
  });

  it('does not count read_from_image as a shaky first pass on its own', () => {
    const result = fromImage(modelPage([modelItem({ kind: 'note', asWritten: 'Hypertension', noteText: 'Hypertension',
      lineIds: ['p1-l4'], box: { left: 0.1, top: 0.2, width: 0.3, height: 0.02 } })]));
    expect(result.items[0]!.checkReasons).toEqual(['read_from_image']);
    expect(result.rereadReasons).not.toContain('many_check_carefully');
  });
});

describe('the not_in_picture_reading sentence', () => {
  const sentence = 'The second reading, from the picture, did not find this; check it against the paper.';
  it('comes after disagreements and status warnings, and before legibility and handwriting', () => {
    expect(checkReasonSentence(['not_in_picture_reading'])).toBe(sentence);
    expect(checkReasonSentence(['not_in_picture_reading', 'strength_mismatch'])).toBe("A dose on the paper doesn't match what was read.");
    expect(checkReasonSentence(['not_in_picture_reading', 'status_not_active']))
      .toBe('This may not be current (for example past, stopped or suspected).');
    expect(checkReasonSentence(['not_in_picture_reading', 'duplicate_source_span']))
      .toBe('Another item was read from the same words; check nothing was missed.');
    expect(checkReasonSentence(['handwritten', 'low_ocr_confidence_handwritten', 'not_in_picture_reading'])).toBe(sentence);
    expect(checkReasonSentence(['not_in_second_reading'])).toBe('The second reading did not find this; check it against the paper.');
    expect(checkReasonSentence(['not_in_second_reading', 'differs_from_second_reading', 'handwritten']))
      .toBe('The second reading differs from this one; compare both with the paper.');
    expect(checkReasonSentence(['differs_from_second_reading', 'strength_mismatch']))
      .toBe("A dose on the paper doesn't match what was read.");
  });
});

describe('mergeReread', () => {
  it('works out possible_missed_item again from every kept item, so a line a kept first-pass item cites is not missed', () => {
    const page = readPage(1, [['Amlodipne 5rng od', { handwritten: true, confidence: 0.55 }], 'Dx: Hypertension']);
    const base = { page: 1, lines: page.lines, sourceSha256Hex: SOURCE_SHA, masker: createMasker() };
    const first = checkPage({ ...base, readBy: 'first_pass', answer: modelPage([modelItem({ kind: 'diagnosis',
      asWritten: 'Hypertension', lineIds: ['p1-l2'], name: 'Hypertension', status: 'confirmed' })]) });
    const image = checkPage({ ...base, readBy: 'reread', fromImage: true, answer: modelPage([modelItem({
      kind: 'medicine', asWritten: 'Amlodipine 5mg od', lineIds: ['p1-l1'], name: 'Amlodipine', status: 'current',
      box: { left: 0.12, top: 0.05, width: 0.3, height: 0.02 } })]) });
    // The picture reading alone leaves "Dx: Hypertension" uncited.
    expect(image.flagReasons).toContain('possible_missed_item');
    const merged = mergeReread(first, image, page.lines, 'image');
    expect(merged.items.map((item) => item.kind)).toEqual(['medicine', 'diagnosis']);
    expect(merged.flagReasons).not.toContain('possible_missed_item');
    expect(merged.flagReasons).toContain('handwriting');
    expect(merged.droppedUngrounded).toBe(image.droppedUngrounded);
  });
});

describe('mergeReread keeps every first-pass item that is not an exact twin of a picture item', () => {
  const onLine2 = { left: 0.12, top: 0.1, width: 0.3, height: 0.02 };
  type Raw = Parameters<typeof modelItem>[0];
  function merge(text: string, firstItems: Raw[], pictureItems: Raw[]) {
    const page = readPage(1, ['Name: Test Patient Adaeze Example', [text, { handwritten: true, confidence: 0.6 }]]);
    const base = { page: 1, lines: page.lines, sourceSha256Hex: SOURCE_SHA, masker: createMasker() };
    const first = checkPage({ ...base, readBy: 'first_pass', answer: modelPage(firstItems.map((item) =>
      modelItem({ lineIds: ['p1-l2'], ...item }))) });
    const image = checkPage({ ...base, readBy: 'reread', fromImage: true, answer: modelPage(pictureItems.map((item) =>
      modelItem({ lineIds: ['p1-l2'], box: onLine2, ...item }))) });
    expect(first.items).toHaveLength(new Set(firstItems.map((item) => item.asWritten)).size);
    expect(image.items).toHaveLength(pictureItems.length);
    return mergeReread(first, image, page.lines, 'image');
  }
  const shape = (items: readonly { kind: string; readBy: string; asWritten: string }[]) =>
    items.map((item) => [item.readBy, item.asWritten]);

  const med = (asWritten: string, name: string, strength: string, frequency: string): Raw =>
    ({ kind: 'medicine', asWritten, name, strength, frequency, status: 'current' });
  const lab = (asWritten: string, test: string, value: string, unit: string): Raw =>
    ({ kind: 'lab_result', asWritten, test, value, unit });
  const note = (asWritten: string): Raw => ({ kind: 'note', asWritten, noteText: asWritten });
  const probes: Array<[string, Raw, Raw]> = [
    ['Vitamin C 100mg od, Vitamin B complex 1 tab od', med('Vitamin C 100mg od', 'Vitamin C', '100mg', 'od'),
      med('Vitamin B complex 1 tab od', 'Vitamin B complex', '1 tab', 'od')],
    ['Paracetamol 1g stat then Paracetamol 500mg tds', med('Paracetamol 1g stat', 'Paracetamol', '1g', 'stat'),
      med('Paracetamol 500mg tds', 'Paracetamol', '500mg', 'tds')],
    ['Insulin glargine 10 units nocte, Insulin soluble 4 units tds',
      med('Insulin glargine 10 units nocte', 'Insulin glargine', '10 units', 'nocte'),
      med('Insulin soluble 4 units tds', 'Insulin soluble', '4 units', 'tds')],
    ['WBC 5.0 x10^9/L Plt 250 x10^9/L', lab('WBC 5.0 x10^9/L', 'WBC', '5.0', 'x10^9/L'),
      lab('Plt 250 x10^9/L', 'Plt', '250', 'x10^9/L')],
    ['Review in the clinic. Refer to the eye unit', note('Review in the clinic.'), note('Refer to the eye unit')],
  ];

  it.each(probes)('keeps the second item on "%s" when the picture reads only the first', (text, one, two) => {
    const merged = merge(text, [one, two], [one]);
    // The exact twin is replaced by the picture's item; the second stays. Only a pair with the same name (here the
    // two Paracetamol doses) is marked to compare; otherwise the second is only not found by the picture.
    expect(shape(merged.items)).toEqual([['reread', one.asWritten], ['first_pass', two.asWritten]]);
    expect(merged.items[1]!.checkReasons).toContain('not_in_picture_reading');
    expect(merged.items[1]!.confidence).toBe('check_carefully');
    const pair = one.name === two.name && one.name !== undefined;
    expect(merged.items[1]!.checkReasons.includes('differs_from_second_reading')).toBe(pair);
    expect(merged.items[0]!.checkReasons.includes('differs_from_second_reading')).toBe(pair);
    for (const item of merged.items) expect(item.checkReasons).not.toContain('duplicate_source_span');
    // Two readings that differ are not a sign of a missed item.
    expect(merged.flagReasons).not.toContain('possible_missed_item');
  });

  it('replaces an exact twin, amounts and spacing normalised, and keeps a near one', () => {
    const exact = merge('Amlodipine 5mg od', [med('Amlodipine 5mg od', 'Amlodipine', '5mg', 'od')],
      [med('Amlodipine 5mg od', 'AMLODIPINE', '5 mg', 'od')]);
    expect(shape(exact.items)).toEqual([['reread', 'Amlodipine 5mg od']]);
    expect(exact.items[0]!.checkReasons).not.toContain('differs_from_second_reading');
    // The first probe's first item read with another strength is not a twin: both stay.
    const [text, one, two] = probes[0]!;
    const near = merge(text, [one, two], [{ ...one, strength: '1000mg' }]);
    expect(shape(near.items)).toEqual([['reread', one.asWritten], ['first_pass', one.asWritten],
      ['first_pass', two.asWritten]]);
  });

  it.each<[string, Raw, Raw]>([
    ['Amoxicillin 500mg tds x 5/7', med('Amoxicillin 500mg tds x 5/7', 'Amoxicillin', '500mg', 'tds'),
      med('Amoxicillin 500mg tds', 'Amoxicillin', '500mg', 'tds')],
    ['Penicillin - anaphylaxis', { kind: 'allergy', asWritten: 'Penicillin - anaphylaxis', substance: 'Penicillin',
      reaction: 'anaphylaxis', severity: 'severe' }, { kind: 'allergy', asWritten: 'Penicillin', substance: 'Penicillin' }],
    ['Hb 7.2 g/dl L (12-16)', { ...lab('Hb 7.2 g/dl L (12-16)', 'Hb', '7.2', 'g/dl'), flag: 'L', referenceRange: '12-16' },
      lab('Hb 7.2 g/dl', 'Hb', '7.2', 'g/dl')],
  ])('keeps the fuller first-pass item on "%s" when the picture item leaves fields out', (text, full, less) => {
    const merged = merge(text, [text.startsWith('Amoxicillin') ? { ...full, duration: '5/7' } : full], [less]);
    expect(shape(merged.items)).toEqual([['reread', less.asWritten], ['first_pass', full.asWritten]]);
    const kept = merged.items[1]!;
    if (kept.kind === 'medicine') expect(kept.fields.duration).toBe('5/7');
    if (kept.kind === 'allergy') expect(kept.fields).toMatchObject({ reaction: 'anaphylaxis', severity: 'severe' });
    if (kept.kind === 'lab_result') expect(kept.fields).toMatchObject({ flag: 'L', referenceRange: '12-16' });
    expect(kept.checkReasons).toEqual(expect.arrayContaining(['differs_from_second_reading', 'not_in_picture_reading']));
  });

  it('compares the date and the prescription too', () => {
    const one = { ...med('Amlodipine 5mg od 03/04/2026', 'Amlodipine', '5mg', 'od'), dateAsWritten: '03/04/2026' };
    const merged = merge('Amlodipine 5mg od 03/04/2026', [one], [{ ...one, dateAsWritten: '' }]);
    expect(merged.items).toHaveLength(2);
  });

  it('keeps both a misread name and the picture reading of it (not the same name, so not paired)', () => {
    const merged = merge('Amlodipne 5mg od', [med('Amlodipne 5mg od', 'Amlodipne', '5mg', 'od')],
      [med('Amlodipine 5mg od', 'Amlodipine', '5mg', 'od')]);
    expect(shape(merged.items)).toEqual([['reread', 'Amlodipine 5mg od'], ['first_pass', 'Amlodipne 5mg od']]);
    expect(merged.items[1]!.checkReasons).toContain('not_in_picture_reading');
    for (const item of merged.items) expect(item.checkReasons).not.toContain('differs_from_second_reading');
    expect(merged.flagReasons).not.toContain('possible_missed_item');
  });

  describe('three medicines on one line, re-read from the text', () => {
    const text = 'Amlodipine 5mg od, Metformin 500mg bd oral, Aspirin 75mg od';
    const amlodipine = med('Amlodipine 5mg od', 'Amlodipine', '5mg', 'od');
    const metformin = med('Metformin 500mg bd', 'Metformin', '500mg', 'bd');
    const aspirin = med('Aspirin 75mg od', 'Aspirin', '75mg', 'od');
    function textMerge(second: Raw[]) {
      const page = readPage(1, ['Name: Test Patient Adaeze Example', text]);
      const base = { page: 1, lines: page.lines, sourceSha256Hex: SOURCE_SHA, masker: createMasker() };
      const toPage = (items: Raw[], readBy: 'first_pass' | 'reread') => checkPage({ ...base, readBy,
        answer: modelPage(items.map((item) => modelItem({ lineIds: ['p1-l2'], ...item }))) });
      return mergeReread(toPage([amlodipine, metformin, aspirin], 'first_pass'), toPage(second, 'reread'), page.lines,
        'text');
    }

    it('replaces each first-pass medicine by its twin, or by a reading that only adds a field it left empty', () => {
      const merged = textMerge([amlodipine, { ...metformin, asWritten: 'Metformin 500mg bd oral', route: 'oral' }, aspirin]);
      expect(shape(merged.items)).toEqual([['reread', 'Amlodipine 5mg od'], ['reread', 'Metformin 500mg bd oral'],
        ['reread', 'Aspirin 75mg od']]);
      expect(merged.items[1]!.fields).toMatchObject({ name: 'Metformin', route: 'oral' });
      for (const item of [merged.items[0]!, merged.items[2]!]) expect(item.confidence).toBe('clear');
      for (const item of merged.items) {
        expect(item.checkReasons).not.toContain('differs_from_second_reading');
        expect(item.checkReasons).not.toContain('not_in_second_reading');
      }
    });

    it('marks only the Metformin pair when the second reading has another strength', () => {
      const merged = textMerge([amlodipine, { ...metformin, strength: '850mg' }, aspirin]);
      // On the same line the second reading's items come first, then the kept first-pass one.
      expect(shape(merged.items)).toEqual([['reread', 'Amlodipine 5mg od'], ['reread', 'Metformin 500mg bd'],
        ['reread', 'Aspirin 75mg od'], ['first_pass', 'Metformin 500mg bd']]);
      const marked = merged.items.filter((item) => item.checkReasons.includes('differs_from_second_reading'));
      expect(marked.map((item) => [item.readBy, item.fields])).toEqual([
        ['reread', expect.objectContaining({ name: 'Metformin', strength: '850mg' })],
        ['first_pass', expect.objectContaining({ name: 'Metformin', strength: '500mg' })]]);
      // A real disagreement (the route on the line that this reading left out) still comes first.
      expect(merged.items[3]!.checkReason).toBe("The paper says how it is given, but that wasn't read.");
      expect(merged.items[3]!.checkReasons).toContain('not_in_second_reading');
      expect(merged.flagReasons).not.toContain('possible_missed_item');
    });

    it('never treats a reading with a field the first pass filled in left out as carrying it', () => {
      const merged = textMerge([amlodipine, { ...metformin, frequency: '' }, aspirin]);
      expect(merged.items.filter((item) => item.asWritten === 'Metformin 500mg bd')).toHaveLength(2);
    });
  });

  it('lets one picture item remove at most one of two identical first-pass items, with unique, repeatable ids', () => {
    const text = 'Paracetamol 1g tds; repeat Paracetamol 1g tds';
    const items = [med('Paracetamol 1g tds', 'Paracetamol', '1g', 'tds'),
      med('repeat Paracetamol 1g tds', 'Paracetamol', '1g', 'tds')];
    const merged = merge(text, items, [items[0]!]);
    expect(shape(merged.items)).toEqual([['reread', 'Paracetamol 1g tds'], ['first_pass', 'repeat Paracetamol 1g tds']]);
    expect(new Set(merged.items.map((item) => item.id)).size).toBe(merged.items.length);
    expect(merge(text, items, [items[0]!]).items.map((item) => item.id)).toEqual(merged.items.map((item) => item.id));
  });
});

describe('placement floors for a short item', () => {
  // A 1240 x 1754 page: 1 px is about 0.0008 of its width and 0.0006 of its height.
  const page = readPage(1, [['Fe 200mg', { handwritten: true, confidence: 0.6,
    box: { left: 0.1, top: 0.3, width: 0.03, height: 0.012 } }]]);
  const read = (box: { left: number; top: number; width: number; height: number }) => checkPage({ page: 1,
    lines: page.lines, sourceSha256Hex: SOURCE_SHA, readBy: 'reread', masker: createMasker(), fromImage: true,
    answer: modelPage([modelItem({ kind: 'medicine', asWritten: 'Fe 200mg', name: 'Fe', strength: '200mg',
      status: 'current', lineIds: ['p1-l1'], box })]) });

  it('keeps a short line read with about 5 px of padding on each side (10 px in all)', () => {
    expect(read({ left: 0.096, top: 0.29715, width: 0.038, height: 0.0177 }).items).toHaveLength(1);
  });

  it('keeps a 0.02-wide line read with 8 px of padding on each side (0.01 of the page width allowed per side)', () => {
    const narrow = readPage(1, [['Fe 200mg', { handwritten: true, confidence: 0.6,
      box: { left: 0.1, top: 0.3, width: 0.02, height: 0.012 } }]]);
    const pad = 8 / 1240;
    const result = checkPage({ page: 1, lines: narrow.lines, sourceSha256Hex: SOURCE_SHA, readBy: 'reread',
      masker: createMasker(), fromImage: true, answer: modelPage([modelItem({ kind: 'note', asWritten: 'Fe 200mg',
        noteText: 'Fe 200mg', lineIds: ['p1-l1'], box: { left: 0.1 - pad, top: 0.3 - 5 / 1754, width: 0.02 + 2 * pad,
          height: 0.012 + 10 / 1754 } })]) });
    expect(result.items).toHaveLength(1);
  });

  it('still drops a box twice as wide as the short line', () => {
    const result = read({ left: 0.085, top: 0.3, width: 0.06, height: 0.012 });
    expect(result.items).toEqual([]);
    expect(result.droppedUngrounded).toBe(1);
  });
});

describe('mergeIdentity', () => {
  const first = { nameAsWritten: 'Test Patient Adaeze Example', dateOfBirthAsWritten: '01/01/1990',
    folderNumberAsWritten: null, sexAsWritten: 'F', lineIds: ['p1-l1'],
    box: { left: 0.1, top: 0.05, width: 0.5, height: 0.02 } };
  const blank = { nameAsWritten: null, dateOfBirthAsWritten: null, folderNumberAsWritten: null, sexAsWritten: null,
    lineIds: [], box: null };

  it('fills a field only the second reading has, keeps the first pass where they agree, with both lines and boxes', () => {
    const second = { nameAsWritten: 'test patient  adaeze example', dateOfBirthAsWritten: null,
      folderNumberAsWritten: 'TEST-0001', sexAsWritten: null, lineIds: ['p1-l3'],
      box: { left: 0.2, top: 0.15, width: 0.3, height: 0.02 } };
    expect(mergeIdentity(first, second)).toEqual({ conflict: false, identity: { nameAsWritten: 'Test Patient Adaeze Example',
      dateOfBirthAsWritten: '01/01/1990', folderNumberAsWritten: 'TEST-0001', sexAsWritten: 'F',
      lineIds: ['p1-l1', 'p1-l3'], box: { left: 0.1, top: 0.05, width: 0.5, height: 0.12 } } });
    expect(mergeIdentity(first, blank)).toEqual({ conflict: false, identity: first });
    expect(mergeIdentity(blank, blank)).toEqual({ conflict: false, identity: blank });
  });

  it('keeps the first-pass value where the readings disagree, and says so', () => {
    const merged = mergeIdentity(first, { ...first, nameAsWritten: 'Test Patient Adaeze Exampel', sexAsWritten: 'M' });
    expect(merged.conflict).toBe(true);
    expect(merged.identity).toMatchObject({ nameAsWritten: 'Test Patient Adaeze Example', sexAsWritten: 'F' });
  });

  it('flags the page ai_unsure when the re-read gives a different identity', () => {
    const page = readPage(1, ['Name: Test Patient Adaeze Example  Folder: TEST-0001', 'Folder: TEST-0002',
      'Dx: Hypertension']);
    const base = { page: 1, lines: page.lines, sourceSha256Hex: SOURCE_SHA, masker: createMasker() };
    const dx = modelItem({ kind: 'diagnosis', asWritten: 'Hypertension', lineIds: ['p1-l3'], name: 'Hypertension',
      status: 'confirmed' });
    const reading = (folder: string, line: string, readBy: 'first_pass' | 'reread') => checkPage({ ...base, readBy,
      answer: modelPage([dx], { identity: { name: '', dateOfBirth: '', folderNumber: folder, sex: '', lineIds: [line] } }) });
    const merged = mergeReread(reading('TEST-0001', 'p1-l1', 'first_pass'), reading('TEST-0002', 'p1-l2', 'reread'),
      page.lines, 'text');
    expect(merged.identity.folderNumberAsWritten).toBe('TEST-0001');
    expect(merged.flagReasons).toContain('ai_unsure');
    const agreed = mergeReread(reading('TEST-0001', 'p1-l1', 'first_pass'), reading('TEST-0001', 'p1-l1', 'reread'),
      page.lines, 'text');
    expect(agreed.flagReasons).not.toContain('ai_unsure');
  });
});
