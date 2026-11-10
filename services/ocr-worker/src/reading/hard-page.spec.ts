import { createHash } from 'node:crypto';
import { paperReadingPayloadSchema, type PaperItem } from './contract';
import { forMatching, STATUS_CUES, withoutSignMarks } from './grounding';
import { markGuess, mergeAsWritten, mergeHardReadings, normaliseDose, normaliseFrequency, prepareHardAnswer,
  shorthandInWords, strengthOf, type HardReading } from './hard-page';
import { checkPage, checkReasonSentence, mergeReread } from './items';
import { createMasker } from './masking';
import { HARD_PAGE_PROMPT_VERSION, HARD_PAGE_PROMPT_VERSION_NO_ZOOM, hardPageMessage, imagePageMessage, pageMessage,
  SIGNS_RULE, SYSTEM_PROMPT, type BasisField, type FieldBasis, type ModelItem, type ModelPage } from './prompt';
import { SIGN_TABLE } from './signs';
import { modelItem, modelPage, readPage, SOURCE_SHA } from './test-fixtures';
import type { ReadLine, ReadPage } from '../types';

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
  it('normalises the usual frequency codes and a numeric dose, keeps anything else as read, and rebuilds the strength', () => {
    expect(['od', 'BD', 'tds?', 'q.d.s', '6 hrly', '8-hourly', 'nocte', 'mane', 'stat', 'prn', '12hrly'].map(normaliseFrequency))
      .toEqual(['od', 'bd', 'tds?', 'qds', '6hrly', '8hrly', 'nocte', 'mane', 'stat', 'prn', '12hrly']);
    // Owner decision 2026-11-06: a best guess for every word; nothing written is hidden behind a token.
    expect(['three times', 'alternate days?', 'weekly', '[unreadable]', 'alternate (sign) days', '[sign?]', '[?]']
      .map(normaliseFrequency)).toEqual(['three times', 'alternate days?', 'weekly', '[?]', 'alternate (sign) days',
      '[sign?]', '[?]']);
    expect(normaliseFrequency('')).toBe('');
    expect(['400', '0.5', '400?', ' 25 '].map(normaliseDose)).toEqual(['400', '0.5', '400?', '25']);
    expect(['4OO', 'one?', '1/2', '[unreadable]'].map(normaliseDose)).toEqual(['4OO', 'one?', '1/2', '[?]']);
    expect(strengthOf('400?', 'mg')).toBe('400mg?');
    expect(strengthOf('500', 'mg')).toBe('500mg');
    expect(strengthOf('1', 'g?')).toBe('1g?');
    expect(strengthOf('2', 'tab')).toBe('2 tab');
    expect(strengthOf('[?]', 'mg')).toBe('[?] mg');
    expect(strengthOf('', 'mg')).toBe('[?] mg');
    expect(strengthOf('', '')).toBe('');
  });

  it('shows a listed drug in its list spelling, "?" only where it is a guess; an unlisted one as read with "?"', () => {
    const prepared = prepareHardAnswer(modelPage([medicine(1, 'Metronidazol', '400', 'mg', 'tds'),
      medicine(1, 'Flagyl', '400', 'mg', 'tds'), medicine(1, 'Flagyl?', '400', 'mg', 'tds'),
      medicine(1, 'Ceftriaxone', '1', 'g', 'tds', { basis: { name: 'context' } }),
      medicine(1, 'Fictionalmab', '400', 'mg', 'three times daily'), medicine(1, 'Fictional mab?', '400', 'mg', 'tds')]));
    expect(prepared.items.map((item) => [item.name, item.frequency, item.hard?.generic])).toEqual([
      // Respelled by the list: a guess.
      ['Metronidazole?', 'tds', 'metronidazole'],
      // A listed brand read with certainty, and with "?".
      ['Flagyl (metronidazole)', 'tds', 'metronidazole'], ['Flagyl? (metronidazole)', 'tds', 'metronidazole'],
      // From context: a guess.
      ['Ceftriaxone?', 'tds', 'ceftriaxone'],
      // Not on the list (owner decision 2026-11-06): shown as read, every word marked; no longer "[unreadable]". A
      // frequency that is none of the codes is marked the same way.
      ['Fictionalmab?', 'three? times? daily?', null], ['Fictional? mab?', 'tds', null]]);
    // asWritten keeps what the model read: the transcription the clinician compares with the paper.
    expect(prepared.items[4]!.asWritten).toBe('Fictionalmab 400 mg three times daily');
  });

  it('never resolves a deny-listed look-alike silently: the name as read, with the listed one as the other option', () => {
    const prepared = prepareHardAnswer(modelPage([medicine(1, 'Arteether', '150', 'mg', 'od'),
      medicine(1, 'Pefloxacin', '400', 'mg', 'bd'), medicine(1, 'Artemether', '80', 'mg', 'bd')]));
    expect(prepared.items.map((item) => [item.name, item.hard?.generic])).toEqual([
      ['Arteether? (or Artemether?)', null],
      // Too far from any listed name to be respelled (the first letters differ): as read, marked.
      ['Pefloxacin?', null],
      ['Artemether', 'artemether']]);
  });

  it('puts "?" on every filled field whose basis is context, so a guess shows in the field itself', () => {
    const [guessed] = prepareHardAnswer(modelPage([{ ...medicine(1, 'Metronidazole', '1', 'g', 'tds',
      { basis: { dose: 'context', unit: 'context', frequency: 'context', route: 'context', duration: 'context' } }),
    route: 'oral', duration: '5 days' }])).items;
    expect(guessed).toMatchObject({ strength: '1g?', frequency: 'tds?', route: 'oral?', duration: '5 days?',
      hard: { dose: '1?', doseUnit: 'g?' } });
    // Read from the letters, empty, already unsure or with no letter shapes: left as it is.
    expect([markGuess('tds', 'letters'), markGuess('', 'context'), markGuess('tds?', 'context'),
      markGuess('[?]', 'context'), markGuess('[sign?]', 'context')]).toEqual(['tds', '', 'tds?', '[?]', '[sign?]']);
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
  it('takes off a "?" after a word or number only, and crossed-out writing', () => {
    expect(['Sulfa?', '400? mg', 'Flagyl? (metronidazole)', 'A? (or B?)', '?TB', '[?]', '(? on paper) TB?']
      .map(forMatching)).toEqual(['Sulfa', '400 mg', 'Flagyl (metronidazole)', 'A (or B)', '?TB', '[?]', '(? on paper) TB']);
    expect(forMatching('IV Flagyl 500mg (crossed out: 400mg?) 8hrly?')).toBe('IV Flagyl 500mg 8hrly');
  });

  it('keeps a query written on the paper, "(? on paper)", apart from the reading\'s own "?" and from "[?]"', () => {
    const page = readPage(1, [['Dx TB?', { handwritten: true, confidence: 0.45 }]]);
    const diagnosis = (asWritten: string, name: string) => heldOn(page, modelPage([hardItem({ kind: 'diagnosis',
      asWritten, name, status: 'confirmed' }, 1, { name: 'letters' })])).check.items[0]!;
    // A query on the paper: the confirmed status is never shown without the cue.
    for (const [asWritten, name] of [['Dx TB (? on paper)', 'TB (? on paper)'], ['Dx (? on paper) TB', '(? on paper) TB']] as const) {
      const queried = diagnosis(asWritten, name);
      expect(fieldsOf(queried)).toMatchObject({ name, status: 'confirmed' });
      expect(queried.checkReasons).toContain('status_cue_on_line');
    }
    // "[?]" is writing with no letter shapes, not a query.
    expect(diagnosis('Dx [?]', '[?]').checkReasons).not.toContain('status_cue_on_line');
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
    expect(fieldsOf(item)).toMatchObject({ name: 'Metronidazole', strength: '400mg?', frequency: 'tds', status: 'new' });
    expect(item).toMatchObject({ readBy: 'reread', confidence: 'check_carefully', plain: 'Metronidazole 400? mg tds (three times a day)' });
    expect(item.checkReasons).toEqual(expect.arrayContaining(['best_guess_from_picture', 'read_from_image']));
    expect(item.checkReasons).not.toContain('readings_disagree');
    expect(item.checkReasons).not.toContain('single_reading_only');
    // The "?" on the dose is from its letters (unsure_from_letters), said before the general best-guess sentence.
    expect(item.checkReasons).toContain('unsure_from_letters');
    expect(item.checkReason).toBe('Words marked "?" were hard to make out; check them against the paper.');
    expect(agreement).toMatchObject({ itemsPaired: 1, itemsSingle: 0 });
    expect(agreement.fieldsCompared).toBeGreaterThan(0);
    expect(agreement.fieldsAgreed).toBe(agreement.fieldsCompared);
  });

  it('treats a brand and its generic as the same medicine', () => {
    const { check } = merge(modelPage([medicine(1, 'Flagyl', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]));
    expect(fieldsOf(check.items[0]!).name).toBe('Flagyl (metronidazole)');
    // The same medicine, but the readings read different words on the paper: both shown, and said to disagree.
    expect(check.items[0]!.plain).toBe('Flagyl? (metronidazole) (or Metronidazole?) 400 mg tds (three times a day)');
    expect(check.items[0]!.checkReasons).toContain('readings_disagree');
  });

  it('shows "A? (or B?)" for a drug name the two readings disagree on', () => {
    const { check, agreement } = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Tinidazole', '400', 'mg', 'tds')]));
    const item = check.items[0]!;
    expect(fieldsOf(item).name).toBe('Metronidazole? (or Tinidazole?)');
    expect(item.checkReasons).toContain('readings_disagree');
    expect(item.checkReason).toBe('Two readings of the picture disagree on part of this; check it against the paper.');
    expect(item.asWritten).toBe('Metronidazole? (or Tinidazole?) 400 mg tds');
    expect(item.plain).toBe('Metronidazole? (or Tinidazole?) 400 mg tds (three times a day)');
    expect(agreement.fieldsAgreed).toBe(agreement.fieldsCompared - 1);
  });

  it('shows an unlisted name the other reading gave as the other option, never "[?]" for disagreeing', () => {
    const { check } = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metrofictional', '400', 'mg', 'tds')]));
    expect(fieldsOf(check.items[0]!).name).toBe('Metronidazole? (or Metrofictional?)');
    expect(check.items[0]!.checkReasons).toContain('readings_disagree');
  });

  it('shows two doses, units, routes or frequencies as "A? (or B?)" (owner decision 2026-11-06)', () => {
    const { check } = merge(modelPage([medicine(1, 'Metronidazole', '500', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazole', '250', 'mg', 'bd')]));
    const item = check.items[0]!;
    expect(fieldsOf(item)).toMatchObject({ name: 'Metronidazole', strength: '500mg? (or 250mg?)', frequency: 'tds? (or bd?)' });
    expect(item.asWritten).toBe('Metronidazole 500? (or 250?) mg tds? (or bd?)');
    expect(item.plain).toBe('Metronidazole 500mg? (or 250mg?) tds? (or bd?)');
    expect(item).toMatchObject({ confidence: 'check_carefully' });
    expect(item.checkReasons).toContain('readings_disagree');
    const unit = merge(modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazole', '400', 'g', 'tds')]));
    expect(fieldsOf(unit.check.items[0]!).strength).toBe('400mg? (or 400g?)');
  });

  it('chooses read A deterministically: the reading whose basis for the field is letters, else the first', () => {
    const letters = medicine(1, 'Metronidazole', '500', 'mg', 'tds');
    const guessed = medicine(1, 'Tinidazole', '250', 'mg', 'tds', { basis: { name: 'context', dose: 'context' } });
    for (const order of [[letters, guessed], [guessed, letters]]) {
      const { check } = merge(...order.map((item) => modelPage([item])));
      // The guess from what is usual is only ever the second option, whichever reading it came from.
      expect(fieldsOf(check.items[0]!)).toMatchObject({ name: 'Metronidazole? (or Tinidazole?)',
        strength: '500mg? (or 250mg?)' });
    }
    // Both from the letters: the first reading leads.
    const { check } = merge(modelPage([medicine(1, 'Tinidazole', '250', 'mg', 'tds')]), modelPage([letters]));
    expect(fieldsOf(check.items[0]!)).toMatchObject({ name: 'Tinidazole? (or Metronidazole?)', strength: '250mg? (or 500mg?)' });
  });

  it('keeps an item only one reading found, when it holds to the page, saying so', () => {
    const { check, agreement } = merge(
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds'), medicine(2, 'Pyrimethamine', '25', 'mg', 'od')]),
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds'),
        // Placed on no line of the page: dropped by the placement rules, as any picture item.
        medicine(2, 'Paracetamol', '1', 'g', 'tds', { box: { left: 0.1, top: 0.8, width: 0.3, height: 0.02 } })]));
    expect(check.items.map((item) => fieldsOf(item).name)).toEqual(['Metronidazole', 'Pyrimethamine']);
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

  it('treats two different spellings respelled to one listed medicine as disagreement, shown once with "?"', () => {
    const { check } = merge(modelPage([medicine(1, 'Metronidazol', '400', 'mg', 'tds')]),
      modelPage([medicine(1, 'Metronidazole', '400', 'mg', 'tds')]));
    expect(fieldsOf(check.items[0]!).name).toBe('Metronidazole?');
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
    expect(fieldsOf(item)).toMatchObject({ name: 'Metronidazole', strength: '200mg? (or 400mg?)' });
    expect(item.checkReasons).toContain('readings_disagree');
    expect(item.lineIds).toEqual(['p1-l1', 'p1-l2']);
    expect(agreement).toMatchObject({ itemsPaired: 1, itemsSingle: 0 });
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

  it('never pairs two medicines along one row: halves of a line, a lone name beside an order, two orders', () => {
    const box = (left: number) => ({ left, top: 0.05, width: 0.2, height: 0.02 });
    const line = (text: string, left: number): [string, Partial<ReadLine>] => [text,
      { handwritten: true, confidence: 0.45, box: box(left) }];
    const rowOf = (left: ModelItem, right: ModelItem, texts: [string, string]) => {
      const page = readPage(1, [line(texts[0], 0.1), line(texts[1], 0.32)]);
      return mergeHardReadings([heldOn(page, modelPage([left])), heldOn(page, modelPage([right]))], SOURCE_SHA);
    };
    // Two halves of one written line, each found by one reading: two single-reading items (a safe duplicate).
    const halves = rowOf(medicine(1, 'Metronidazole', '', '', '', { asWritten: 'Metronidazole', box: box(0.1) }),
      medicine(2, 'Metronidazole', '400', 'mg', 'tds', { asWritten: '400 mg tds', box: box(0.32) }),
      ['Metronidazole', '400 mg tds']);
    // A lone name beside a full order: the order stays whole and visible.
    const lone = rowOf(medicine(1, 'Metronidazole', '', '', '', { asWritten: 'Metronidazole', box: box(0.1) }),
      medicine(2, 'Metronidazole', '500', 'mg', 'bd', { asWritten: 'Metronidazole 500 mg bd', box: box(0.32) }),
      ['Metronidazole', 'Metronidazole 500 mg bd']);
    // Two full orders side by side.
    const orders = rowOf(medicine(1, 'Metronidazole', '400', 'mg', 'tds', { box: box(0.1) }),
      medicine(2, 'Metronidazole', '500', 'mg', 'bd', { box: box(0.32) }),
      ['Metronidazole 400 mg tds', 'Metronidazole 500 mg bd']);
    for (const { check, agreement } of [halves, lone, orders]) {
      expect(check.items).toHaveLength(2);
      expect(check.items.every((item) => item.checkReasons.includes('single_reading_only'))).toBe(true);
      expect(agreement).toMatchObject({ itemsPaired: 0, itemsSingle: 2 });
    }
    expect(fieldsOf(halves.check.items[1]!)).toMatchObject({ strength: '400mg', frequency: 'tds' });
    expect(fieldsOf(lone.check.items[1]!)).toMatchObject({ name: 'Metronidazole', strength: '500mg', frequency: 'bd' });
    expect(orders.check.items.map((item) => fieldsOf(item).strength)).toEqual(['400mg', '500mg']);
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
    expect(check.items.map((item) => fieldsOf(item).strength)).toEqual(['400mg', '500mg']);
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

  it('on an atypical prescription, leads with the letters and offers the usual drug only second, marked a context guess', () => {
    // The letters say pyrimethamine (rarely prescribed); one reading fell back on what is usual (paracetamol).
    const read = medicine(2, 'Pyrimethamine', '25', 'mg', 'od');
    const usual = medicine(2, 'Paracetamol', '25', 'mg', 'od', { basis: { name: 'context' } });
    for (const answers of [[read, usual], [usual, read]]) {
      const { check } = merge(...answers.map((item) => modelPage([item])));
      expect(fieldsOf(check.items[0]!).name).toBe('Pyrimethamine? (or Paracetamol?)');
    }
    const { check } = merge(modelPage([read]), modelPage([usual]));
    const item = check.items[0]!;
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

  it('merges asWritten word by word, writing each differing stretch as "A? (or B?)"', () => {
    expect(mergeAsWritten('Tab Metronidazole 400 mg tds', 'Tab Metronidazole? 200 mg tds'))
      .toBe('Tab Metronidazole? 400? (or 200?) mg tds');
    expect(mergeAsWritten('a b c', 'x y z')).toBe('a? (or x?) b? (or y?) c? (or z?)');
    expect(mergeAsWritten('a b c', 'x y')).toBe('a? b? c? (or x? y?)');
    expect(mergeAsWritten('IV Flagyl 500mg', 'Flagyl 500mg')).toBe('IV? Flagyl 500mg');
    expect(mergeAsWritten('Flagyl 500mg', 'IV Flagyl 500mg')).toBe('IV? Flagyl 500mg');
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

describe('diagnosis and lab test names on a hard page, grounded after the readings are compared', () => {
  const page = readPage(1, [['Dx HTN', { handwritten: true, confidence: 0.45 }],
    ['FBC 11.2', { handwritten: true, confidence: 0.45 }], ['Dx Fictionalitis', { handwritten: true, confidence: 0.45 }]]);
  const answer = () => modelPage([
    hardItem({ kind: 'diagnosis', asWritten: 'Dx HTN', name: 'HTN', status: 'confirmed' }, 1, { name: 'letters' }),
    hardItem({ kind: 'lab_result', asWritten: 'FBC 11.2', test: 'FBC', value: '11.2' }, 2, { name: 'letters', value: 'letters' }),
    hardItem({ kind: 'diagnosis', asWritten: 'Dx Fictionalitis', name: 'Fictionalitis', status: 'confirmed' }, 3,
      { name: 'letters' })]);

  it('shows a listed name as read with the listed name after it, and leaves an unlisted one as read', () => {
    const { check } = mergeHardReadings([heldOn(page, answer()), heldOn(page, answer())], SOURCE_SHA);
    expect(check.items.map((item) => fieldsOf(item).name ?? fieldsOf(item).test))
      .toEqual(['HTN? (Hypertensive diseases)', 'FBC? (full blood count)', 'Fictionalitis']);
    expect(check.items.map((item) => item.plain))
      .toEqual(['Dx HTN? (Hypertensive diseases)', 'FBC? (full blood count) 11.2', 'Dx Fictionalitis']);
    expect(check.items.every((item) => item.confidence === 'check_carefully')).toBe(true);
    // The checks were made on the names as read: no text_corrected, and the value is still bound to its test.
    for (const item of check.items) expect(item.checkReasons).not.toContain('text_corrected');
    expect(check.items[1]!.checkReasons).not.toContain('value_mismatch');
    // asWritten is the paper's, untouched.
    expect(check.items.map((item) => item.asWritten)).toEqual(['Dx HTN', 'FBC 11.2', 'Dx Fictionalitis']);
  });

  it('grounds nothing on the first pass or another re-read: only hard pages use the lists', () => {
    const text = readPage(1, ['Dx HTN']);
    const read = checkPage({ page: 1, lines: text.lines, sourceSha256Hex: SOURCE_SHA, readBy: 'first_pass',
      masker: createMasker(), fromImage: false, answer: modelPage([modelItem({ kind: 'diagnosis', asWritten: 'Dx HTN',
        name: 'HTN', status: 'confirmed', lineIds: ['p1-l1'] })]) });
    expect(fieldsOf(read.items[0]!).name).toBe('HTN');
  });

  it('shows two different names for one diagnosis as both, never picking one, and grounds each', () => {
    const other = modelPage([hardItem({ kind: 'diagnosis', asWritten: 'Dx HTN', name: 'Hypertension', status: 'confirmed' },
      1, { name: 'letters' })]);
    const { check } = mergeHardReadings([heldOn(page, modelPage([answer().items[0]!])), heldOn(page, other)], SOURCE_SHA);
    // Both stand for one listed title: said once, after both.
    expect(fieldsOf(check.items[0]!).name).toBe('HTN? (or Hypertension?) (Hypertensive diseases)');
    expect(check.items[0]!.checkReasons).toContain('readings_disagree');
    // Two names standing for different titles (or none): each grounded on its own.
    const malaria = modelPage([hardItem({ kind: 'diagnosis', asWritten: 'Dx HTN', name: 'Malaria', status: 'confirmed' },
      1, { name: 'letters' })]);
    const apart = mergeHardReadings([heldOn(page, modelPage([answer().items[0]!])), heldOn(page, malaria)], SOURCE_SHA);
    expect(fieldsOf(apart.check.items[0]!).name).toBe('HTN? (Hypertensive diseases) (or Malaria?)');
  });

  it('shows a deny-listed diagnosis look-alike with the listed name as the other option, and never grounds "PID"', () => {
    const lines = readPage(1, [['Dx Nephritic syndrome', { handwritten: true, confidence: 0.45 }],
      ['Dx PID', { handwritten: true, confidence: 0.45 }]]);
    const { check } = mergeHardReadings([heldOn(lines, modelPage([
      hardItem({ kind: 'diagnosis', asWritten: 'Dx Nephritic syndrome', name: 'Nephritic syndrome', status: 'confirmed' },
        1, { name: 'letters' }),
      hardItem({ kind: 'diagnosis', asWritten: 'Dx PID', name: 'PID', status: 'confirmed' }, 2, { name: 'letters' })]))],
    SOURCE_SHA);
    expect(check.items.map((item) => fieldsOf(item).name)).toEqual(['Nephritic? syndrome? (or Nephrotic? syndrome?)', 'PID']);
  });
});

describe('hard-page prompt versions', () => {
  const lines = [{ id: 'p1-l1', text: 'Amoxil 500mg', confidence: 0.4, handwritten: true,
    box: { left: 0.1, top: 0.2, width: 0.4, height: 0.05 } }, { id: 'p1-l2', text: 'x', confidence: 0.4, handwritten: true, box: null }];
  const size = { width: 800, height: 1000 };

  it('sends the version 7 text, byte for byte, when zoom is not offered (HARD_PAGE_PROMPT_VERSION_NO_ZOOM)', () => {
    // Pinned from the version 7 prompt (the clean reading of 2026-11-06, with partial words and placeholders); a change here needs a new version.
    expect(HARD_PAGE_PROMPT_VERSION_NO_ZOOM).toBe('hid-paper-reading-hard-page-prompt-7');
    expect(HARD_PAGE_PROMPT_VERSION).toBe('hid-paper-reading-hard-page-prompt-9');
    expect(createHash('sha256').update(hardPageMessage(1, lines, size, 0)).digest('hex'))
      .toBe('7feb2c96cc86bf7d67c5394249ed21269f0bb9803b7fd7f9d5a45f035c77ce07');
    expect(hardPageMessage(1, lines, size)).toBe(hardPageMessage(1, lines, size, 0));
    expect(hardPageMessage(1, lines, size, 0)).not.toContain('zoom');
  });

  it('adds rule J, the zoom tool, after the sign rule and before the lines, only when zoom is offered', () => {
    const withZoom = hardPageMessage(1, lines, size, 8);
    const plain = hardPageMessage(1, lines, size, 0);
    const rule = withZoom.slice(withZoom.indexOf('\n\nJ. ') + 2, withZoom.indexOf('\n\nThe lines the service found'));
    expect(rule.startsWith('J. You can use the zoom tool')).toBe(true);
    expect(rule).toContain('at most 8 times for this page');
    expect(withZoom.replace(`${rule}\n\n`, '')).toBe(plain);
    expect(withZoom.indexOf(SIGNS_RULE)).toBeLessThan(withZoom.indexOf('J. You can use the zoom tool'));
  });
});

describe('handwritten signs on a hard page', () => {
  const page = readPage(1, [['Amoxil 500mg Z days', { handwritten: true, confidence: 0.4 }],
    ['Hx # femur', { handwritten: true, confidence: 0.4 }], ['Dx Malaria', { handwritten: true, confidence: 0.4 }]]);
  const signed = (asWritten: string, frequency = '[unreadable]') => medicine(1, 'Amoxil', '500', 'mg', frequency, { asWritten });
  const merge = (...answers: ModelPage[]) => mergeHardReadings(answers.map((answer) => heldOn(page, answer)), SOURCE_SHA);

  it('gives the sign table in the hard-page prompt only, with every sign described in words', () => {
    const lines = [{ id: 'p1-l1', text: 'x', confidence: 0.4, handwritten: true, box: null }];
    const hard = hardPageMessage(1, lines, { width: 800, height: 1000 });
    expect(hard).toContain(SIGNS_RULE);
    expect(SIGNS_RULE).toContain('"alternate" (as in alternate days)');
    expect(SIGNS_RULE).toContain('write "[sign?]" in its place: never guess a word for a sign');
    expect(SIGNS_RULE).toContain('"#" before a number ("#30") is a count, not this sign');
    for (const sign of SIGN_TABLE) expect(SIGNS_RULE).toContain(`- ${sign.looks}: ${sign.meaning}`);
    for (const written of ['Hx history', 'Rx treatment (prescription)', 'stat at once', 'prn when needed', 'od once a day, or on eye drops the right eye',
      'bd twice a day', 'tds three times a day', 'qds four times a day', 'nocte at night', 'mane in the morning', 'n/52 n weeks',
      'n/12 n months']) expect(SIGNS_RULE).toContain(written);
    // The first pass and the image re-read of other flagged pages are unchanged: no sign table there.
    for (const other of [SYSTEM_PROMPT, imagePageMessage(1, lines, { width: 800, height: 1000 }), pageMessage(1, lines)]) {
      expect(other).not.toContain('(sign)');
      expect(other).not.toContain('[sign?]');
    }
  });

  it('marks an item with a sign read or not read sign_read, and says so', () => {
    const { check } = merge(modelPage([signed('Amoxil 500 mg alternate (sign) days')]),
      modelPage([signed('Amoxil 500 mg alternate (sign) days')]));
    const item = check.items[0]!;
    expect(item.asWritten).toBe('Amoxil 500 mg alternate (sign) days');
    expect(item.checkReasons).toEqual(expect.arrayContaining(['sign_read', 'best_guess_from_picture']));
    expect(item.checkReason).toBe(
      'A handwritten sign was read as a word, marked "(sign)", or could not be read, marked "[sign?]"; check it against the paper.');
    const unsure = merge(modelPage([signed('Amoxil 500 mg [sign?] days')])).check.items[0]!;
    expect(unsure.checkReasons).toContain('sign_read');
    const plain = merge(modelPage([signed('Amoxil 500 mg tds', 'tds')])).check.items[0]!;
    expect(plain.checkReasons).not.toContain('sign_read');
    // Below the real disagreements and a guess from context, above the plainer best-guess sentences.
    expect(checkReasonSentence(['sign_read', 'readings_disagree'])).toContain('Two readings');
    expect(checkReasonSentence(['sign_read', 'field_from_context'])).toContain('guessed from what is usual');
    expect(checkReasonSentence(['sign_read', 'single_reading_only', 'best_guess_from_picture', 'read_from_image']))
      .toContain('Only one of two readings');
    expect(checkReasonSentence(['sign_read', 'best_guess_from_picture', 'read_from_image'])).toContain('handwritten sign');
    // A sign in a field other than asWritten counts too.
    const fracture = merge(modelPage([hardItem({ kind: 'diagnosis', asWritten: 'Hx fracture (sign) femur',
      name: 'fracture (sign) femur', status: 'history' }, 2, { name: 'letters' })])).check.items[0]!;
    expect(fracture.checkReasons).toContain('sign_read');
    expect(fieldsOf(fracture).name).toBe('fracture (sign) femur');
  });

  it('never expands "[sign?]": not into a frequency, a drug, a diagnosis or a lab test, and not by forMatching', () => {
    expect(normaliseFrequency('[sign?]')).toBe('[sign?]');
    expect(forMatching('Amoxil 500? mg [sign?] days')).toBe('Amoxil 500 mg [sign?] days');
    expect(forMatching('[?] and [sign?]')).toBe('[?] and [sign?]');
    const { check } = merge(modelPage([medicine(1, '[sign?]', '500', 'mg', '[unreadable]', { asWritten: 'Amoxil 500 mg [sign?]' }),
      hardItem({ kind: 'diagnosis', asWritten: 'Dx [sign?]', name: '[sign?]', status: 'confirmed' }, 3, { name: 'letters' })]));
    expect(check.items.map((item) => fieldsOf(item).name)).toEqual(['[sign?]', '[sign?]']);
    expect(check.items.every((item) => item.checkReasons.includes('sign_read'))).toBe(true);
  });

  it('leaves grounding unaffected: "[sign?]" is no query, and the marks never anchor an item', () => {
    // The "?" of "[sign?]" and of "[?]" (no letter shapes) is not a status cue; "(? on paper)" is.
    expect('dx [sign?] malaria'.match(STATUS_CUES)).toBeNull();
    expect('dx [?] malaria'.match(STATUS_CUES)).toBeNull();
    expect('dx (? on paper) malaria'.match(STATUS_CUES)).toEqual(['?']);
    expect(withoutSignMarks('alternate (sign) days [sign?]').trim().split(/\s+/)).toEqual(['alternate', 'days']);
    const asRead = (asWritten: string) => merge(modelPage([hardItem({ kind: 'diagnosis', asWritten, name: 'Malaria',
      status: 'confirmed' }, 3, { name: 'letters' })])).check.items[0]!;
    const withSign = asRead('Dx Malaria [sign?]');
    const withQuery = asRead('Dx Malaria (? on paper)');
    expect(withSign.checkReasons).not.toContain('status_cue_on_line');
    expect(withQuery.checkReasons).toContain('status_cue_on_line');
    expect(fieldsOf(withSign).name).toBe('Malaria');
    // On a legible line the anchor rule still holds: "sign" in a mark does not tie an item to a line that says "sign".
    const legible = readPage(1, ['Sign: Dr Fictional']);
    const made = heldOn(legible, modelPage([hardItem({ kind: 'note', asWritten: 'increased (sign)', noteText: 'increased (sign)' },
      1, { other: 'letters' })]));
    expect(made.check.items).toHaveLength(0);
    expect(made.check.droppedByReason).toEqual({ not_anchored: 1 });
  });

  it('puts dose shorthand in words only where the read is certain', () => {
    expect(shorthandInWords('frequency', 'tds')).toBe('tds (three times a day)');
    expect(shorthandInWords('frequency', 'mane')).toBe('mane (in the morning)');
    // "od" is also the right eye on eye drops ("OD" is lower-cased by normaliseFrequency): never put in words.
    for (const written of ['od', 'OD', 'Od', normaliseFrequency('o.d.'), normaliseFrequency('OD')]) {
      expect([written, shorthandInWords('frequency', written)]).toEqual([written, written]);
    }
    expect(shorthandInWords('frequency', 'tds?')).toBe('tds?');
    expect(shorthandInWords('frequency', '[?]')).toBe('[?]');
    expect(shorthandInWords('duration', '5/7')).toBe('5/7 (5 days)');
    expect(shorthandInWords('duration', '1/52')).toBe('1/52 (1 week)');
    expect(shorthandInWords('duration', '3/12')).toBe('3/12 (3 months)');
    expect(shorthandInWords('duration', '5?/7')).toBe('5?/7');
    expect(shorthandInWords('duration', '[sign?] 5/7')).toBe('[sign?] 5/7');
    const { check } = merge(modelPage([medicine(1, 'Amoxicillin', '500', 'mg', 'tds?')]));
    expect(check.items[0]!.plain).toBe('Amoxicillin 500 mg tds?');
  });
});

