import { paperReadingPayloadSchema, type PaperItem } from './contract';
import { mergeAsWritten, mergeHardReadings, normaliseDose, normaliseFrequency, prepareHardAnswer, strengthOf,
  type HardReading } from './hard-page';
import { checkPage, checkReasonSentence } from './items';
import { createMasker } from './masking';
import type { BasisField, FieldBasis, ModelItem, ModelPage } from './prompt';
import { modelItem, modelPage, readPage, SOURCE_SHA } from './test-fixtures';

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
