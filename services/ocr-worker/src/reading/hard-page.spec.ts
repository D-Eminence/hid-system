import { paperReadingPayloadSchema, type PaperItem } from './contract';
import { forMatching } from './grounding';
import { markGuess, mergeAsWritten, mergeHardReadings, normaliseDose, normaliseFrequency, prepareHardAnswer, strengthOf,
  type HardReading } from './hard-page';
import { checkPage, checkReasonSentence, mergeReread } from './items';
import { createMasker } from './masking';
import type { BasisField, FieldBasis, ModelItem, ModelPage } from './prompt';
import { modelItem, modelPage, readPage, SOURCE_SHA } from './test-fixtures';
import type { ReadPage } from '../types';

/** A fictional hard page: two handwritten lines the text service could barely read. */
const PAGE = readPage(1, [['Metrnidazle 400 rng tds', { handwritten: true, confidence: 0.45 }],
  ['Pyrmthmn 25 rng od', { handwritten: true, confidence: 0.4 }], 'Dx: Toxoplasmosis']);
const onLine = (line: number) => ({ left: 0.12, top: Math.round(5 * line) / 100, width: 0.3, height: 0.02 });
const letters = (overrides: Partial<Record<BasisField, FieldBasis>> = {}): Record<BasisField, FieldBasis> => ({
  name: 'letters', dose: 'letters', unit: 'letters', route: 'empty', frequency: 'letters', duration: 'empty',
  value: 'empty', other: 'empty', ...overrides });

function medicine(line: number, name: string, dose: string, unit: string, frequency: string,
  options: { asWritten?: string; basis?: Partial<Record<BasisField, FieldBasis>>; box?: ModelItem['box'] } = {}): ModelItem {
  return { ...modelItem({ kind: 'medicine', asWritten: options.asWritten ?? `${name} ${dose} ${unit} ${frequency}`,
    lineIds: [`p1-l${line}`], name, strength: `${dose}${unit}`, frequency, status: 'new',
    plain: `${name} plain words from the model` }),
  box: options.box ?? onLine(line), hard: { dose, doseUnit: unit, basis: letters(options.basis) } };
}

function reading(answer: ModelPage): HardReading {
  const prepared = prepareHardAnswer(answer);
  return { answer: prepared, check: checkPage({ page: 1, lines: PAGE.lines, answer: prepared, sourceSha256Hex: SOURCE_SHA,
    readBy: 'reread', masker: createMasker(), fromImage: true }) };
}
const merge = (...answers: ModelPage[]) => mergeHardReadings(answers.map(reading), SOURCE_SHA);
const fieldsOf = (item: PaperItem) => item.fields as Record<string, unknown>;

describe('hard-page answers, before they are held to the page', () => {
  it('keeps frequency only from the allowed set, a dose only as a number, and rebuilds the strength', () => {
    expect(['od', 'BD', 'tds?', 'q.d.s', '6 hrly', '8-hourly', 'nocte', 'stat', 'prn', '12hrly'].map(normaliseFrequency))
      .toEqual(['od', 'bd', 'tds?', 'qds', '6hrly', '8hrly', 'nocte', 'stat', 'prn', '12hrly']);
    expect(['three times', 'mane', 'weekly', '[unreadable]'].map(normaliseFrequency)).toEqual(Array(4).fill('[unreadable]'));
    expect(normaliseFrequency('')).toBe('');
    expect(['400', '0.5', '400?', ' 25 '].map(normaliseDose)).toEqual(['400', '0.5', '400?', '25']);
    expect(['4OO', 'one', '1/2', '[unreadable]'].map(normaliseDose)).toEqual(Array(4).fill('[unreadable]'));
    expect(strengthOf('400?', 'mg')).toBe('400? mg');
    expect(strengthOf('', 'mg')).toBe('[unreadable] mg');
    expect(strengthOf('', '')).toBe('');
  });

  it('shows a listed drug name in its list spelling with "?", a brand with its generic, an unlisted one as unreadable', () => {
    const prepared = prepareHardAnswer(modelPage([medicine(1, 'Metronidazol', '400', 'mg', 'tds'),
      medicine(1, 'Flagyl', '400', 'mg', 'tds'), medicine(1, 'Fictionalmab', '400', 'mg', 'three times daily')]));
    expect(prepared.items.map((item) => [item.name, item.frequency, item.hard?.generic])).toEqual([
      ['Metronidazole?', 'tds', 'metronidazole'], ['Flagyl? (metronidazole)', 'tds', 'metronidazole'],
      ['[unreadable]', '[unreadable]', null]]);
    // asWritten keeps what the model read: the transcription the clinician compares with the paper.
    expect(prepared.items[2]!.asWritten).toBe('Fictionalmab 400 mg three times daily');
  });

  it('puts "?" on every filled field whose basis is context, so a guess shows in the field itself', () => {
    const [guessed] = prepareHardAnswer(modelPage([{ ...medicine(1, 'Metronidazole', '1', 'g', 'tds',
      { basis: { dose: 'context', unit: 'context', frequency: 'context', route: 'context', duration: 'context' } }),
    route: 'oral', duration: '5 days' }])).items;
    expect(guessed).toMatchObject({ strength: '1? g?', frequency: 'tds?', route: 'oral?', duration: '5 days?',
      hard: { dose: '1?', doseUnit: 'g?' } });
    // Read from the letters, empty, already unsure or unreadable: left as it is.
    expect([markGuess('tds', 'letters'), markGuess('', 'context'), markGuess('tds?', 'context'),
      markGuess('[unreadable]', 'context')]).toEqual(['tds', '', 'tds?', '[unreadable]']);
  });

  it('puts "?" on a diagnosis name and an allergy reaction from context, and says so for an enum from context', () => {
    const page = readPage(1, [['Dx Toxoplasmosis', { handwritten: true, confidence: 0.45 }],
      ['Allergy: Sulfa - rash', { handwritten: true, confidence: 0.4 }]]);
    const extras = (basis: Partial<Record<BasisField, FieldBasis>>) => ({ dose: '', doseUnit: '',
      basis: letters({ dose: 'empty', unit: 'empty', frequency: 'empty', ...basis }) });
    const diagnosis: ModelItem = { ...modelItem({ kind: 'diagnosis', asWritten: 'Dx Toxoplasmosis', lineIds: ['p1-l1'],
      name: 'Toxoplasmosis', status: 'confirmed' }), box: onLine(1), hard: extras({ name: 'context', other: 'letters' }) };
    const allergy: ModelItem = { ...modelItem({ kind: 'allergy', asWritten: 'Allergy: Sulfa - rash', lineIds: ['p1-l2'],
      substance: 'Sulfa', reaction: 'rash' }), box: onLine(2), hard: extras({ name: 'empty', other: 'context' }) };
    // A diagnosis whose only context field is its status (an enum): no "?" can go on it, the reason says so.
    const status: ModelItem = { ...diagnosis, hard: extras({ name: 'letters', other: 'context' }) };
    const prepared = prepareHardAnswer(modelPage([diagnosis, allergy, status]));
    expect(prepared.items.map((item) => [item.name, item.substance, item.reaction, item.status])).toEqual([
      ['Toxoplasmosis?', '', '', 'confirmed'], ['', 'Sulfa?', 'rash?', 'none'], ['Toxoplasmosis', '', '', 'confirmed']]);
    const check = checkPage({ page: 1, lines: page.lines, answer: prepared, sourceSha256Hex: SOURCE_SHA,
      readBy: 'reread', masker: createMasker(), fromImage: true });
    const { check: merged } = mergeHardReadings([{ answer: prepared, check }], SOURCE_SHA);
    expect(merged.items.map((item) => [item.kind, fieldsOf(item)])).toEqual(expect.arrayContaining([
      ['diagnosis', { name: 'Toxoplasmosis?', status: 'confirmed' }],
      ['diagnosis', { name: 'Toxoplasmosis', status: 'confirmed' }],
      ['allergy', { substance: 'Sulfa?', reaction: 'rash?', severity: null, noKnownAllergies: false }]]));
    expect(merged.items).toHaveLength(3);
    expect(merged.items.every((item) => item.checkReasons.includes('field_from_context'))).toBe(true);
  });
});

/** One hard-page reading of a page, prepared and held to it. */
function heldOn(page: ReadPage, answer: ModelPage): HardReading {
  const prepared = prepareHardAnswer(answer);
  return { answer: prepared, check: checkPage({ page: 1, lines: page.lines, answer: prepared, sourceSha256Hex: SOURCE_SHA,
    readBy: 'reread', masker: createMasker(), fromImage: true }) };
}
const hardItem = (overrides: Partial<ModelItem>, line: number, basis: Partial<Record<BasisField, FieldBasis>>): ModelItem => ({
  ...modelItem({ lineIds: [`p1-l${line}`], ...overrides }), box: onLine(line),
  hard: { dose: '', doseUnit: '', basis: letters({ name: 'empty', dose: 'empty', unit: 'empty', frequency: 'empty',
    ...basis }) } });

describe('guess marks are kept in the field but taken off for every check against the page', () => {
  it('takes off a "?" after a word or number only', () => {
    expect(['Sulfa?', '400? mg', 'Flagyl? (metronidazole)', 'A? / B?', '?TB', '[unreadable]'].map(forMatching))
      .toEqual(['Sulfa', '400 mg', 'Flagyl (metronidazole)', 'A / B', '?TB', '[unreadable]']);
  });

  it('keeps a query written on the paper, "[?]", apart from the reading\'s own "?"', () => {
    expect(['TB[?]', '[?]TB', 'Dx [?]TB?'].map(forMatching)).toEqual(['TB[?]', '[?]TB', 'Dx [?]TB']);
    const page = readPage(1, [['Dx TB?', { handwritten: true, confidence: 0.45 }]]);
    const diagnosis = (asWritten: string, name: string) => heldOn(page, modelPage([hardItem({ kind: 'diagnosis',
      asWritten, name, status: 'confirmed' }, 1, { name: 'letters' })])).check.items[0]!;
    // A query on the paper: the confirmed status is never shown without the cue.
    for (const [asWritten, name] of [['Dx TB[?]', 'TB[?]'], ['Dx [?]TB', '[?]TB']] as const) {
      const queried = diagnosis(asWritten, name);
      expect(fieldsOf(queried)).toMatchObject({ name, status: 'confirmed' });
      expect(queried.checkReasons).toContain('status_cue_on_line');
    }
    // The reading's own "?": a best guess, not a query.
    const { check } = mergeHardReadings([heldOn(page, modelPage([hardItem({ kind: 'diagnosis', asWritten: 'Dx TB?',
      name: 'TB?', status: 'confirmed' }, 1, { name: 'letters' })]))], SOURCE_SHA);
    expect(check.items[0]!.checkReasons).not.toContain('status_cue_on_line');
    expect(check.items[0]!.checkReasons).toContain('best_guess_from_picture');
    // The text path is unchanged: a "?" on a text line is a query cue.
    const text = readPage(1, ['Dx ?TB']);
    const read = checkPage({ page: 1, lines: text.lines, sourceSha256Hex: SOURCE_SHA, readBy: 'first_pass',
      masker: createMasker(), fromImage: false, answer: modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Dx ?TB',
        name: 'TB', status: 'confirmed', lineIds: ['p1-l1'] })]) });
    expect(read.items[0]!.checkReasons).toContain('status_cue_on_line');
  });

  it('still finds "No sulfa allergy" for a substance "Sulfa?" from context', () => {
    const page = readPage(1, [['No sulfa allergy', { handwritten: true, confidence: 0.45 }]]);
    const { check } = heldOn(page, modelPage([hardItem({ kind: 'allergy', asWritten: 'No sulfa allergy',
      substance: 'Sulfa' }, 1, { other: 'context' })]));
    expect(fieldsOf(check.items[0]!).substance).toBe('Sulfa?');
    expect(check.items[0]!.checkReasons).toContain('status_cue_on_line');
    expect(check.items[0]!.checkReasons).not.toContain('text_corrected');
  });

  it('binds the value of an "Hb?" test to it, without noise from the mark alone', () => {
    const page = readPage(1, [['Hb 11.2 g/dL WBC 6.1', { handwritten: true, confidence: 0.45 }]]);
    const lab = (value: string) => hardItem({ kind: 'lab_result', asWritten: 'Hb 11.2 g/dL WBC 6.1', test: 'Hb', value,
      unit: 'g/dL' }, 1, { other: 'context', value: 'letters', unit: 'letters' });
    const right = heldOn(page, modelPage([lab('11.2')])).check.items[0]!;
    expect(fieldsOf(right)).toMatchObject({ test: 'Hb?', value: '11.2', unit: 'g/dL' });
    for (const code of ['text_corrected', 'value_mismatch', 'unit_mismatch', 'field_not_on_paper']) {
      expect(right.checkReasons).not.toContain(code);
    }
    // The next test's number is not Hb's: the value check still works on a marked test.
    expect(heldOn(page, modelPage([lab('6.1')])).check.items[0]!.checkReasons).toContain('value_mismatch');
  });

  it('pairs a diagnosis "Toxoplasmosis?" with the first pass\'s "Toxoplasmosis" as twins in the re-read merge', () => {
    const page = readPage(1, [['Dx Toxoplasmosis', { handwritten: true, confidence: 0.45 }]]);
    const diagnosis = (status: 'confirmed' | 'suspected') => ({ kind: 'diagnosis' as const, asWritten: 'Dx Toxoplasmosis',
      name: 'Toxoplasmosis', status });
    const first = checkPage({ page: 1, lines: page.lines, sourceSha256Hex: SOURCE_SHA, readBy: 'first_pass',
      masker: createMasker(), fromImage: false,
      answer: modelPage([modelItem({ ...diagnosis('confirmed'), lineIds: ['p1-l1'] })]) });
    const hard = (status: 'confirmed' | 'suspected') => mergeHardReadings([heldOn(page,
      modelPage([hardItem(diagnosis(status), 1, { name: 'context' })]))], SOURCE_SHA).check;
    const twin = mergeReread(first, hard('confirmed'), page.lines, 'image');
    expect(twin.items).toHaveLength(1);
    expect(fieldsOf(twin.items[0]!).name).toBe('Toxoplasmosis?');
    expect(twin.items[0]!.checkReasons).not.toContain('differs_from_second_reading');
    // Another field differs: both kept, compared as the same diagnosis.
    const differs = mergeReread(first, hard('suspected'), page.lines, 'image');
    expect(differs.items).toHaveLength(2);
    expect(differs.items.every((item) => item.checkReasons.includes('differs_from_second_reading'))).toBe(true);
  });
});

describe('two readings of a hard page', () => {
  it('keeps what both readings agree on, with "?" where either was unsure, and marks every item a best guess', () => {
    const { check, agreement } = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazole', '400?', 'mg', 'tds')]));
    expect(check.items).toHaveLength(1);
    const item = check.items[0]!;
    expect(fieldsOf(item)).toMatchObject({ name: 'Metronidazole?', strength: '400? mg', frequency: 'tds', status: 'new' });
    expect(item).toMatchObject({ readBy: 'reread', confidence: 'check_carefully', plain: 'Metronidazole? 400? mg tds' });
    expect(item.checkReasons).toEqual(expect.arrayContaining(['best_guess_from_picture', 'read_from_image']));
    expect(item.checkReasons).not.toContain('readings_disagree');
    expect(item.checkReasons).not.toContain('single_reading_only');
    expect(item.checkReason).toBe('This is a best guess from the picture; check every word against the paper.');
    expect(agreement).toMatchObject({ itemsPaired: 1, itemsSingle: 0 });
    expect(agreement.fieldsCompared).toBeGreaterThan(0);
    expect(agreement.fieldsAgreed).toBe(agreement.fieldsCompared);
  });

  it('treats a brand and its generic as the same medicine', () => {
    const { check } = merge(modelPage([medicine(1, 'Flagyl', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]));
    expect(fieldsOf(check.items[0]!).name).toBe('Flagyl? (metronidazole)');
    expect(check.items[0]!.checkReasons).not.toContain('readings_disagree');
  });

  it('shows "A? / B?" for a drug name the two readings disagree on when both are listed and read from the letters', () => {
    const { check, agreement } = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Tinidazole', '400', 'mg', 'tds')]));
    const item = check.items[0]!;
    expect(fieldsOf(item).name).toBe('Metronidazole? / Tinidazole?');
    expect(item.checkReasons).toContain('readings_disagree');
    expect(item.checkReason).toBe('Two readings of the picture disagree on part of this; check it against the paper.');
    expect(item.asWritten).toBe('[unreadable] 400 mg tds');
    expect(agreement.fieldsAgreed).toBe(agreement.fieldsCompared - 1);
  });

  it('makes a disagreeing drug name unreadable when one side is not on the list', () => {
    const { check } = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metrofictional', '400', 'mg', 'tds')]));
    expect(fieldsOf(check.items[0]!).name).toBe('[unreadable]');
    expect(check.items[0]!.checkReasons).toContain('readings_disagree');
  });

  it('never shows two doses: a disagreeing dose, unit, route or frequency becomes unreadable', () => {
    const { check } = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazole', '200', 'mg', 'bd')]));
    const item = check.items[0]!;
    expect(fieldsOf(item)).toMatchObject({ name: 'Metronidazole?', strength: '[unreadable] mg', frequency: '[unreadable]' });
    expect(JSON.stringify(item)).not.toMatch(/200/);
    expect(item.asWritten).toBe('Metronidazole [unreadable] mg [unreadable]');
    expect(item.plain).toBe('Metronidazole? [unreadable] mg [unreadable]');
    const unit = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazole', '400', 'g', 'tds')]));
    expect(fieldsOf(unit.check.items[0]!).strength).toBe('400 [unreadable]');
  });

  it('keeps an item only one reading found, when it holds to the page, saying so', () => {
    const { check, agreement } = merge(
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds'), medicine(2, 'Pyrimethamine', '25', 'mg', 'od')]),
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds'),
        // Placed on no line of the page: dropped by the placement rules, as any picture item.
        medicine(2, 'Paracetamol', '1', 'g', 'tds', { box: { left: 0.1, top: 0.8, width: 0.3, height: 0.02 } })]));
    expect(check.items.map((item) => fieldsOf(item).name)).toEqual(['Metronidazole?', 'Pyrimethamine?']);
    const only = check.items[1]!;
    expect(only.checkReasons).toEqual(expect.arrayContaining(['single_reading_only', 'best_guess_from_picture']));
    expect(only.checkReason).toBe('Only one of two readings of the picture found this; check it against the paper.');
    expect(agreement).toMatchObject({ itemsPaired: 1, itemsSingle: 1 });
  });

  it('marks a single-reading medicine whose dose or unit came from context', () => {
    for (const basis of [{ unit: 'context' as const }, { dose: 'context' as const }]) {
      const { check } = mergeHardReadings([reading(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds',
        { basis })]))], SOURCE_SHA);
      expect(check.items[0]!.checkReasons).toEqual(expect.arrayContaining(['field_from_context', 'single_reading_only']));
    }
  });

  it('treats two different spellings respelled to one listed medicine as disagreement', () => {
    const { check } = merge(modelPage([medicine(1, 'Metronidazol', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]));
    expect(fieldsOf(check.items[0]!).name).toBe('[unreadable]');
    expect(check.items[0]!.checkReasons).toContain('readings_disagree');
    // The same spelling in both readings is agreement.
    const same = merge(modelPage([medicine(1, 'Metronidazol', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazol', '400', 'mg', 'tds')]));
    expect(fieldsOf(same.check.items[0]!).name).toBe('Metronidazole?');
    expect(same.check.items[0]!.checkReasons).not.toContain('readings_disagree');
  });

  it('pairs the same listed medicine read on neighbouring lines, so it is never shown twice with two doses', () => {
    const page = readPage(1, [['Metrnidazle 200', { handwritten: true, confidence: 0.45 }],
      ['Metro 400 rng tds', { handwritten: true, confidence: 0.45 }], 'Dx: Toxoplasmosis']);
    const held = (answer: ModelPage): HardReading => {
      const prepared = prepareHardAnswer(answer);
      return { answer: prepared, check: checkPage({ page: 1, lines: page.lines, answer: prepared,
        sourceSha256Hex: SOURCE_SHA, readBy: 'reread', masker: createMasker(), fromImage: true }) };
    };
    const { check, agreement } = mergeHardReadings([
      held(modelPage([medicine(1, 'Metronidazole', '200', 'mg', 'tds', { asWritten: 'Metrnidazle 200',
        box: { left: 0.12, top: 0.05, width: 0.3, height: 0.02 } })])),
      held(modelPage([medicine(2, 'Metronidazole', '400', 'mg', 'tds', { asWritten: 'Metro 400 rng tds',
        box: { left: 0.2, top: 0.1, width: 0.3, height: 0.02 } })]))], SOURCE_SHA);
    expect(check.items.filter((item) => item.kind === 'medicine')).toHaveLength(1);
    const item = check.items[0]!;
    expect(fieldsOf(item)).toMatchObject({ name: 'Metronidazole?', strength: '[unreadable] mg' });
    expect(item.checkReasons).toContain('readings_disagree');
    expect(item.lineIds).toEqual(['p1-l1', 'p1-l2']);
    expect(agreement).toMatchObject({ itemsPaired: 1, itemsSingle: 0 });
    expect(JSON.stringify(fieldsOf(item))).not.toMatch(/200|400/);
  });

  it('says field_from_context for a guessed date or prescriber, which carry no "?"', () => {
    const page = readPage(1, [['5.2 mmol/L 03/04/2026', { handwritten: true, confidence: 0.45 }],
      ['Metronidazole 400 mg tds Dr Test Prescriber', { handwritten: true, confidence: 0.45 }]]);
    const held = (answer: ModelPage): HardReading => {
      const prepared = prepareHardAnswer(answer);
      return { answer: prepared, check: checkPage({ page: 1, lines: page.lines, answer: prepared,
        sourceSha256Hex: SOURCE_SHA, readBy: 'reread', masker: createMasker(), fromImage: true }) };
    };
    // A result with no test named: its date is its only field under "other".
    const lab = (other: FieldBasis): ModelItem => ({ ...modelItem({ kind: 'lab_result',
      asWritten: '5.2 mmol/L 03/04/2026', lineIds: ['p1-l1'], value: '5.2', unit: 'mmol/L',
      dateAsWritten: '03/04/2026' }), box: onLine(1), hard: { dose: '', doseUnit: '',
      basis: letters({ name: 'empty', dose: 'empty', frequency: 'empty', value: 'letters', unit: 'letters', other }) } });
    const prescribed = (other: FieldBasis): ModelItem => ({ ...medicine(2, 'Metronidazole', '400', 'mg', 'tds',
      { asWritten: 'Metronidazole 400 mg tds Dr Test Prescriber', basis: { other } }),
    prescriberAsWritten: 'Dr Test Prescriber' });
    const dated = (item: PaperItem) => item.kind === 'lab_result';
    for (const result of [mergeHardReadings([held(modelPage([lab('context'), prescribed('context')]))], SOURCE_SHA),
      mergeHardReadings([held(modelPage([lab('context'), prescribed('context')])),
        held(modelPage([lab('letters'), prescribed('letters')]))], SOURCE_SHA)]) {
      const [date, medicineItem] = [result.check.items.find(dated)!, result.check.items.find((item) => !dated(item))!];
      expect(date.dateAsWritten).toBe('03/04/2026');
      expect(medicineItem.prescription?.prescriberAsWritten).toBe('Dr Test Prescriber');
      expect(date.checkReasons).toContain('field_from_context');
      expect(medicineItem.checkReasons).toContain('field_from_context');
    }
    // Read from the letters in both readings: no context reason.
    const read = mergeHardReadings([held(modelPage([lab('letters')])), held(modelPage([lab('letters')]))], SOURCE_SHA);
    expect(read.check.items[0]!.checkReasons).not.toContain('field_from_context');
  });

  it('pairs two fragments of one written line side by side, each found by one reading', () => {
    const page = readPage(1, [['Metronidazole', { handwritten: true, confidence: 0.45,
      box: { left: 0.1, top: 0.05, width: 0.2, height: 0.02 } }],
    ['400 mg tds', { handwritten: true, confidence: 0.45, box: { left: 0.32, top: 0.05, width: 0.2, height: 0.02 } }]]);
    const { check, agreement } = mergeHardReadings([
      heldOn(page, modelPage([medicine(1, 'Metronidazole', '', '', '', { asWritten: 'Metronidazole',
        box: { left: 0.1, top: 0.05, width: 0.2, height: 0.02 } })])),
      heldOn(page, modelPage([medicine(2, 'Metronidazole', '400', 'mg', 'tds', { asWritten: '400 mg tds',
        box: { left: 0.32, top: 0.05, width: 0.2, height: 0.02 } })]))], SOURCE_SHA);
    expect(check.items).toHaveLength(1);
    expect(check.items[0]!.lineIds).toEqual(['p1-l1', 'p1-l2']);
    expect(agreement).toMatchObject({ itemsPaired: 1, itemsSingle: 0 });
  });

  it('never pairs two full orders side by side as fragments of one line, and holds the gap at exactly 0.03', () => {
    const rowPage = (secondLeft: number) => readPage(1, [['Metronidazole 400 mg tds', { handwritten: true,
      confidence: 0.45, box: { left: 0.1, top: 0.05, width: 0.2, height: 0.02 } }],
    ['Metronidazole 500 mg bd', { handwritten: true, confidence: 0.45,
      box: { left: secondLeft, top: 0.05, width: 0.2, height: 0.02 } }]]);
    const page = rowPage(0.32);
    const { check, agreement } = mergeHardReadings([
      heldOn(page, modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds',
        { box: { left: 0.1, top: 0.05, width: 0.2, height: 0.02 } })])),
      heldOn(page, modelPage([medicine(2, 'Metronidazole', '500', 'mg', 'bd',
        { box: { left: 0.32, top: 0.05, width: 0.2, height: 0.02 } })]))], SOURCE_SHA);
    expect(check.items.map((item) => fieldsOf(item).strength)).toEqual(['400 mg', '500 mg']);
    expect(agreement).toMatchObject({ itemsPaired: 0, itemsSingle: 2 });
    // Name and dose fragments: paired at a gap of exactly 0.03 (0.35 to 0.38, which is 0.030000000000000027 in
    // floating point), not at 0.031.
    const fragments = (secondLeft: number) => {
      const fragmentPage = readPage(1, [['Metronidazole', { handwritten: true, confidence: 0.45,
        box: { left: 0.1, top: 0.05, width: 0.25, height: 0.02 } }],
      ['400 mg tds', { handwritten: true, confidence: 0.45, box: { left: secondLeft, top: 0.05, width: 0.2,
        height: 0.02 } }]]);
      return mergeHardReadings([
        heldOn(fragmentPage, modelPage([medicine(1, 'Metronidazole', '', '', '', { asWritten: 'Metronidazole',
          box: { left: 0.1, top: 0.05, width: 0.25, height: 0.02 } })])),
        heldOn(fragmentPage, modelPage([medicine(2, 'Metronidazole', '400', 'mg', 'tds', { asWritten: '400 mg tds',
          box: { left: secondLeft, top: 0.05, width: 0.2, height: 0.02 } })]))], SOURCE_SHA);
    };
    expect(fragments(0.38).check.items).toHaveLength(1);
    expect(fragments(0.381).check.items).toHaveLength(2);
  });

  it('keeps the same medicine at one height in two columns as two orders, each found by one reading', () => {
    // Two columns: line 1 on the left, line 2 on the right, at the same height.
    const page = readPage(1, [['Metronidazole 400 mg tds', { handwritten: true, confidence: 0.45,
      box: { left: 0.05, top: 0.05, width: 0.35, height: 0.02 } }],
    ['Metronidazole 500 mg bd', { handwritten: true, confidence: 0.45,
      box: { left: 0.55, top: 0.05, width: 0.35, height: 0.02 } }]]);
    const held = (answer: ModelPage): HardReading => {
      const prepared = prepareHardAnswer(answer);
      return { answer: prepared, check: checkPage({ page: 1, lines: page.lines, answer: prepared,
        sourceSha256Hex: SOURCE_SHA, readBy: 'reread', masker: createMasker(), fromImage: true }) };
    };
    const { check, agreement } = mergeHardReadings([
      held(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds',
        { box: { left: 0.05, top: 0.05, width: 0.35, height: 0.02 } })])),
      held(modelPage([medicine(2, 'Metronidazole', '500', 'mg', 'bd',
        { box: { left: 0.55, top: 0.05, width: 0.35, height: 0.02 } })]))], SOURCE_SHA);
    expect(check.items.map((item) => fieldsOf(item).strength)).toEqual(['400 mg', '500 mg']);
    expect(check.items.every((item) => item.checkReasons.includes('single_reading_only'))).toBe(true);
    expect(check.items.some((item) => item.checkReasons.includes('readings_disagree'))).toBe(false);
    expect(agreement).toMatchObject({ itemsPaired: 0, itemsSingle: 2 });
  });

  it('marks every item single_reading_only when only one reading came back', () => {
    const { check, agreement } = mergeHardReadings([reading(modelPage([medicine(1, 'Metronidazole', '400', 'mg',
      'tds')]))], SOURCE_SHA);
    expect(check.items.every((item) => item.checkReasons.includes('single_reading_only'))).toBe(true);
    expect(agreement).toEqual({ fieldsCompared: 0, fieldsAgreed: 0, itemsPaired: 0, itemsSingle: 1 });
  });

  it('marks a field filled from context, and says so first among the best-guess reasons', () => {
    const { check } = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds', { basis: { frequency: 'context' } })]),
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]));
    expect(check.items[0]!.checkReasons).toContain('field_from_context');
    expect(check.items[0]!.checkReason)
      .toBe('Part of this was guessed from what is usual, not read from the writing; check it against the paper.');
    // An empty field marked context does not count.
    const empty = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds', { basis: { route: 'context' } })]),
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]));
    expect(empty.check.items[0]!.checkReasons).not.toContain('field_from_context');
  });

  it('on an atypical prescription, marks a context guess and turns the disagreement unreadable, never offering the usual drug', () => {
    // The letters say pyrimethamine (rarely prescribed); one reading fell back on what is usual (paracetamol).
    const read = medicine(2, 'Pyrimethamine', '25', 'mg', 'od');
    const usual = medicine(2, 'Paracetamol', '25', 'mg', 'od', { basis: { name: 'context' } });
    const { check } = merge(modelPage([read]), modelPage([usual]));
    const item = check.items[0]!;
    expect(fieldsOf(item).name).toBe('[unreadable]');
    expect(JSON.stringify(fieldsOf(item))).not.toContain('Paracetamol');
    expect(item.checkReasons).toEqual(expect.arrayContaining(['readings_disagree', 'field_from_context',
      'best_guess_from_picture']));
    // The real disagreement is said first.
    expect(item.checkReason).toBe('Two readings of the picture disagree on part of this; check it against the paper.');
    // Found by one reading only, from context: kept, and marked as a guess from what is usual.
    const alone = mergeHardReadings([reading(modelPage([usual]))], SOURCE_SHA);
    expect(fieldsOf(alone.check.items[0]!).name).toBe('Paracetamol?');
    expect(alone.check.items[0]!.checkReasons).toEqual(expect.arrayContaining(['field_from_context', 'single_reading_only']));
  });

  it('pairs one to one by kind and place, and leaves other kinds apart', () => {
    const note = { ...modelItem({ kind: 'note', asWritten: 'Toxoplasmosis', noteText: 'Toxoplasmosis', lineIds: ['p1-l3'] }),
      box: onLine(3), hard: { dose: '', doseUnit: '', basis: letters({ name: 'empty', dose: 'empty', unit: 'empty',
        frequency: 'empty', other: 'letters' }) } };
    const diagnosis = { ...note, kind: 'diagnosis' as const, name: 'Toxoplasmosis', status: 'confirmed' as const, noteText: '' };
    const { check, agreement } = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds'), note]),
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds'), medicine(1, 'Metronidazole', '400', 'mg', 'tds',
        { asWritten: 'Metronidazole 400 mg tds again' }), diagnosis]));
    expect(check.items.map((item) => item.kind)).toEqual(['medicine', 'medicine', 'note', 'diagnosis']);
    expect(agreement).toMatchObject({ itemsPaired: 1, itemsSingle: 3 });
    expect(new Set(check.items.map((item) => item.id)).size).toBe(4);
  });

  it('merges asWritten word by word, writing each differing stretch once as unreadable', () => {
    expect(mergeAsWritten('Tab Metronidazole 400 mg tds', 'Tab Metronidazole? 200 mg tds')).toBe('Tab Metronidazole? [unreadable] mg tds');
    expect(mergeAsWritten('a b c', 'x y z')).toBe('[unreadable]');
  });

  it('builds items that meet the contract', () => {
    const { check } = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Tinidazole', '200', 'mg', 'tds')]));
    const payload = { contract: 'hid-paper-reading-v2', pages: [{ page: 1, flagged: true, flagReasons: ['handwriting'],
      lines: PAGE.lines.map(({ page: _page, ...line }) => line) }], identity: check.identity, items: check.items,
    reading: { status: 'read', firstPassModel: 'm', rereadModel: 'm', rereadPages: [1], droppedUngrounded: 0,
      itemCount: check.items.length, promptVersion: 'p', schemaVersion: 's' } };
    expect(paperReadingPayloadSchema.safeParse(payload).success).toBe(true);
    expect(checkReasonSentence(['read_from_image', 'best_guess_from_picture'])).toBe(
      'This is a best guess from the picture; check every word against the paper.');
  });
});
