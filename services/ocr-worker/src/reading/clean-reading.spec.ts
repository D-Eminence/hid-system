import { answerItem, CLEAN_READING_ROWS, rowBox, type CleanReadingAnswer } from './clean-reading-fixtures';
import { paperReadingPayloadSchema, type PaperItem } from './contract';
import { alternatives, hasQuestionMark, hardPlain, isDescription, markWords, mergeAsWritten, mergeHardReadings, unshownWords,
  prepareHardAnswer, splitAlternative, type HardReading } from './hard-page';
import { checkPage, checkReasonSentence, mergeReread } from './items';
import { createMasker } from './masking';
import { hardPageMessage, MODEL_OUTPUT_HARD_PAGE_JSON_SCHEMA, type ModelItem, type ModelPage } from './prompt';
import { modelItem, modelPage, readPage, SOURCE_SHA } from './test-fixtures';
import type { ReadPage } from '../types';

/** The fixture page: one hard handwritten line per row (fictional, garbled as the text service reads hard writing). */
const PAGE: ReadPage = readPage(1, CLEAN_READING_ROWS.map((row) => [row.lineText,
  { handwritten: true, confidence: 0.4 }] as [string, { handwritten: boolean; confidence: number }]));

function held(answer: ModelPage, page: ReadPage = PAGE): HardReading {
  const prepared = prepareHardAnswer(answer);
  return { answer: prepared, check: checkPage({ page: 1, lines: page.lines, answer: prepared, sourceSha256Hex: SOURCE_SHA,
    readBy: 'reread', masker: createMasker(), fromImage: true }) };
}
const readA = () => modelPage(CLEAN_READING_ROWS.map((row, index) => answerItem(row.readA, index + 1)));
const readB = () => modelPage(CLEAN_READING_ROWS.map((row, index) => answerItem(row.readB ?? row.readA, index + 1)));
const rowOf = (item: PaperItem) => Number(/-l(\d+)$/.exec(item.lineIds[0]!)![1]);

describe('the clean hard-page reading (owner decision 2026-11-06): the fictional fixture', () => {
  const both = mergeHardReadings([held(readA()), held(readB())], SOURCE_SHA).check;
  const one = mergeHardReadings([held(readA())], SOURCE_SHA).check;

  it('keeps one item per row, from both readings and from one', () => {
    expect(both.items.map(rowOf)).toEqual(CLEAN_READING_ROWS.map((_row, index) => index + 1));
    expect(one.items.map(rowOf)).toEqual(CLEAN_READING_ROWS.map((_row, index) => index + 1));
  });

  CLEAN_READING_ROWS.forEach((row, index) => {
    it(`shows ${row.name} as the clean reading, for a person to keep or change`, () => {
      const item = both.items.find((candidate) => rowOf(candidate) === index + 1)!;
      expect(item.plain).toBe(row.plain);
      expect(item.confidence).toBe('check_carefully');
      expect(item.checkReasons).toEqual(expect.arrayContaining(['best_guess_from_picture', 'read_from_image',
        ...(row.reasons ?? [])]));
      for (const code of row.notReasons ?? []) expect(item.checkReasons).not.toContain(code);
      // Never a sentence about the writing, in what is shown or in any field.
      expect(isDescription(item.plain)).toBe(false);
      expect(isDescription(item.asWritten)).toBe(false);
      for (const value of Object.values(item.fields)) if (typeof value === 'string') expect(isDescription(value)).toBe(false);
      // The old token is gone from what is shown.
      expect(JSON.stringify(item)).not.toContain('[unreadable]');
    });
  });

  it('shows the same rows from one reading where the readings agree', () => {
    CLEAN_READING_ROWS.forEach((row, index) => {
      if (row.readB) return;
      expect(one.items.find((item) => rowOf(item) === index + 1)!.plain).toBe(row.plain);
    });
  });

  it('builds a payload that meets the contract (no contract change)', () => {
    const payload = { contract: 'hid-paper-reading-v2', pages: [{ page: 1, flagged: true, flagReasons: ['handwriting'],
      lines: PAGE.lines.map(({ page: _page, ...line }) => line) }], identity: both.identity, items: both.items,
    reading: { status: 'read', firstPassModel: 'm', rereadModel: 'm', rereadPages: [1], droppedUngrounded: 0,
      itemCount: both.items.length, promptVersion: 'p', schemaVersion: 's' } };
    expect(paperReadingPayloadSchema.safeParse(payload).success).toBe(true);
    // Reasons stay codes; the sentence is derived from them, as before.
    for (const item of both.items) {
      for (const code of item.checkReasons) expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(item.checkReason).toBe(checkReasonSentence(item.checkReasons));
    }
  });
});

describe('every hard-page item showing a "?" goes to a person (Keep or Change)', () => {
  /** Many hard-page outputs: each row alone, each pair of rows' readings swapped, disagreements, and the merge with a first pass. */
  function outputs(): PaperItem[] {
    const all: PaperItem[] = [];
    const page = readA();
    const other = readB();
    all.push(...mergeHardReadings([held(page)], SOURCE_SHA).check.items);
    all.push(...mergeHardReadings([held(page), held(other)], SOURCE_SHA).check.items);
    all.push(...mergeHardReadings([held(other), held(page)], SOURCE_SHA).check.items);
    // Every row against every other row's answer on the same line: as many disagreements as the fixture allows.
    CLEAN_READING_ROWS.forEach((row, index) => CLEAN_READING_ROWS.forEach((otherRow) => {
      const a = modelPage([answerItem(row.readA, index + 1)]);
      const b = modelPage([answerItem(otherRow.readA, index + 1)]);
      if (a.items[0]!.kind !== b.items[0]!.kind) return;
      all.push(...mergeHardReadings([held(a), held(b)], SOURCE_SHA).check.items);
    }));
    // Merged with a first pass that read each line as a plain note: no hard item loses its flag there.
    const first = checkPage({ page: 1, lines: PAGE.lines, sourceSha256Hex: SOURCE_SHA, readBy: 'first_pass',
      masker: createMasker(), fromImage: false, answer: modelPage(PAGE.lines.map((line) => modelItem({ kind: 'note',
        asWritten: line.text, lineIds: [line.id] }))) });
    all.push(...mergeReread(first, mergeHardReadings([held(page), held(other)], SOURCE_SHA).check, PAGE.lines, 'image')
      .items.filter((item) => item.readBy === 'reread'));
    return all;
  }

  it('sweeps every output: an item with a "?" anywhere is check_carefully, and so is every hard-page item', () => {
    const items = outputs();
    expect(items.length).toBeGreaterThan(40);
    expect(items.filter(hasQuestionMark).length).toBeGreaterThan(20);
    for (const item of items) {
      expect(item.confidence).toBe('check_carefully');
      expect(item.checkReasons).toContain('best_guess_from_picture');
    }
  });
});

describe('clean reading pieces', () => {
  it('marks every word a guess, leaving bracketed groups, marks and words already marked', () => {
    expect(markWords('Ceftriaxone 1g 8hrly')).toBe('Ceftriaxone? 1g? 8hrly?');
    expect(markWords('Flagyl (metronidazole)')).toBe('Flagyl? (metronidazole)');
    expect(markWords('Review in [?] days,')).toBe('Review? in? [?] days?,');
    expect(markWords('alternate (sign) days?')).toBe('alternate? (sign) days?');
    expect(markWords('(? on paper) TB')).toBe('(? on paper) TB?');
  });

  it('shows two readings as "A? (or B?)", the readable one first, one alone where the other is blank', () => {
    expect(alternatives('Cefuroxime', 'Ceftriaxone?')).toBe('Cefuroxime? (or Ceftriaxone?)');
    expect(alternatives('500mg', '250mg')).toBe('500mg? (or 250mg?)');
    expect(alternatives('[?]', 'Ceftriaxone')).toBe('Ceftriaxone? (or [?])');
    expect(alternatives('', 'IV')).toBe('IV?');
    expect(alternatives('IV', null)).toBe('IV?');
    expect(splitAlternative('HTN? (or Hypertension?)')).toEqual(['HTN?', 'Hypertension?']);
    expect(splitAlternative('Flagyl? (metronidazole)')).toBeNull();
    expect(splitAlternative('A? (or B? (generic))')).toEqual(['A?', 'B? (generic)']);
  });

  it('keeps the words an order\'s fields do not hold: before it, after it, and any word that stops it', () => {
    const lead = (text: string, anchors: string[]) => unshownWords(text, anchors, anchors).lead;
    expect(lead('Switch to IV Ceftriaxone 1g', ['IV', 'Ceftriaxone'])).toBe('Switch to');
    expect(lead('Rx: Ceftriaxone 1g', ['', 'ceftriaxone'])).toBe('Rx:');
    expect(lead('IV Ceftriaxone 1g', ['IV', 'Ceftriaxone'])).toBe('');
    // Numbers and long runs are kept as written: a stop on day 3 is never dropped.
    expect(lead('Day 2 IV Ceftriaxone', ['IV'])).toBe('Day 2');
    expect(lead('Stop on day 3 IV Ceftriaxone 1g bd', ['IV', 'Ceftriaxone'])).toBe('Stop on day 3');
    const shown = ['IV', 'Ceftriaxone', '1g', 'bd'];
    expect(unshownWords('IV Ceftriaxone 1g bd - stop', ['IV', 'Ceftriaxone'], shown)).toEqual({ lead: '', tail: '- stop' });
    expect(unshownWords('IV Ceftriaxone hold 1g bd', ['IV', 'Ceftriaxone'], shown)).toEqual({ lead: '', tail: 'hold' });
    expect(unshownWords('IV Ceftriaxone 1 g bd', ['IV', 'Ceftriaxone'], shown)).toEqual({ lead: '', tail: '' });
    expect(unshownWords('IV Ceftriaxone 1g bd (crossed out: 2g)', ['IV', 'Ceftriaxone'], shown))
      .toEqual({ lead: '', tail: '' });
  });

  it('recognises a description of the writing, and not words a clinician writes', () => {
    for (const text of ['Handwritten treatment entry that cannot be read; check the paper', 'illegible',
      'Illegible scribble', 'unreadable handwriting', 'appears to say amoxicillin', 'text is not legible',
      'could not be read', 'check it against the paper', 'Handwritten note', 'Unclear handwriting', 'Smudged text',
      'Faded writing', 'Scribbled word', 'Writing obscured', 'Partially legible word', 'appears to read Flagyl']) {
      expect([text, isDescription(text)]).toEqual([text, true]);
    }
    for (const text of ['Transfer to the ward', 'Diagnosis unclear', 'UPT: faint line', 'Review in 2 days',
      'Switch to IV Ceftriaxone 1g', '[?]', 'Handwritten note given to patient?', 'Check the chart',
      'Pt unable to read, explain in Yoruba', 'Patient cannot read', 'Appears to be improving', 'Rash barely visible',
      'Speech: words not clear']) {
      expect([text, isDescription(text)]).toEqual([text, false]);
    }
  });

  it('replaces a description in asWritten by a "[?]" note, and in a field by "[?]"; the model plain is never shown', () => {
    const answer = modelPage([answerItem({ item: { kind: 'medicine',
      asWritten: 'Illegible handwritten entry', name: 'unknown drug' } }, 1),
    answerItem({ item: { kind: 'medicine', asWritten: 'IV Flagyl 500mg', route: 'IV', name: 'Flagyl',
      frequency: 'illegible', plain: 'A handwritten order that cannot be read' }, dose: '500', doseUnit: 'mg' }, 2)]);
    const prepared = prepareHardAnswer(answer);
    expect(prepared.items[0]).toMatchObject({ kind: 'note', asWritten: '[?]', noteText: '[?]', name: '', plain: '',
      hard: { described: true } });
    expect(prepared.items[1]).toMatchObject({ kind: 'medicine', frequency: '[?]', plain: '', hard: { described: true } });
    const { check } = mergeHardReadings([held(answer)], SOURCE_SHA);
    expect(check.items.map((item) => [item.kind, item.plain])).toEqual([['note', '[?]'],
      ['medicine', 'IV Flagyl (metronidazole) 500mg [?]']]);
    expect(check.items.every((item) => item.checkReasons.includes('description_replaced'))).toBe(true);
    // On a legible line a "[?]" note has nothing to anchor it: dropped, as a made-up item would be.
    const legible = readPage(1, ['Amlodipine 5mg od']);
    expect(held(modelPage([answerItem({ item: { kind: 'note', asWritten: 'illegible' } }, 1)]), legible).check.items)
      .toHaveLength(0);
  });

  it('never keeps a wholly crossed-out item active: it becomes a note showing "(crossed out: X?)"', () => {
    const page = readPage(1, [['Amxl 500mg tds', { handwritten: true, confidence: 0.4 }]]);
    const struck: ModelItem = answerItem({ item: { kind: 'medicine', asWritten: '(crossed out: Amoxil 500mg? tds)',
      name: 'Amoxil', frequency: 'tds', status: 'new' }, dose: '500', doseUnit: 'mg', crossedOut: 'Amoxil 500mg? tds' }, 1);
    const { check } = mergeHardReadings([held(modelPage([struck]), page)], SOURCE_SHA);
    expect(check.items).toHaveLength(1);
    expect(check.items[0]).toMatchObject({ kind: 'note', plain: '(crossed out: Amoxil 500mg? tds)',
      fields: { text: '(crossed out: Amoxil 500mg? tds)' }, confidence: 'check_carefully' });
    expect(check.items[0]!.checkReasons).toContain('crossed_out');
  });

  it('keeps crossed-out writing from either reading on the same item, and says when they differ', () => {
    const page = readPage(1, [['IV Flgyl 500mg 4OOmg 8hrly', { handwritten: true, confidence: 0.4 }]]);
    const order = (crossedOut: string): ModelItem => answerItem({ item: { kind: 'medicine',
      asWritten: crossedOut ? `IV Flagyl 500mg (crossed out: ${crossedOut}) 8hrly` : 'IV Flagyl 500mg 8hrly', route: 'IV',
      name: 'Flagyl', frequency: '8hrly', status: 'new' }, dose: '500', doseUnit: 'mg', crossedOut }, 1);
    const seenByOne = mergeHardReadings([held(modelPage([order('')]), page), held(modelPage([order('400mg?')]), page)],
      SOURCE_SHA).check.items;
    expect(seenByOne).toHaveLength(1);
    expect(seenByOne[0]!.plain).toBe('IV Flagyl (metronidazole) 500mg 8hrly (every 8 hours) (crossed out: 400mg?)');
    expect(seenByOne[0]!.checkReasons).toEqual(expect.arrayContaining(['crossed_out', 'readings_disagree']));
    // The struck dose is never taken for the item's dose by the checks.
    expect(seenByOne[0]!.checkReasons).not.toContain('strength_not_as_written');
    const same = mergeHardReadings([held(modelPage([order('400mg?')]), page), held(modelPage([order('400mg')]), page)],
      SOURCE_SHA).check.items[0]!;
    expect(same.plain).toBe('IV Flagyl (metronidazole) 500mg 8hrly (every 8 hours) (crossed out: 400mg?)');
    expect(same.checkReasons).not.toContain('readings_disagree');
  });

  it('builds the plain reading of each kind from its fields, never from the model', () => {
    const item = (kind: PaperItem['kind'], fields: Record<string, unknown>, asWritten = 'as read') =>
      ({ kind, fields, asWritten } as unknown as PaperItem);
    expect(hardPlain(item('note', { text: 'Transfer to the ward' }), { text: 'Transfer to the ward' } as PaperItem['fields'],
      '', '')).toBe('Transfer to the ward');
    const lab = { test: 'Hb?', value: '9.1', unit: 'g/dL', referenceRange: null, flag: 'L' };
    expect(hardPlain(item('lab_result', lab), lab as PaperItem['fields'], '', '')).toBe('Hb? 9.1 g/dL L');
    expect(hardPlain(item('allergy', {}, 'Allergy: Sulfa? rash'), {} as PaperItem['fields'], '', ''))
      .toBe('Allergy: Sulfa? rash');
    expect(hardPlain(item('diagnosis', { name: '' }, 'Dx [?]'), { name: '' } as PaperItem['fields'], '', '')).toBe('Dx [?]');
  });
});

describe('nothing read is lost from the shown text (review of the clean reading)', () => {
  const hand = (text: string) => readPage(1, [[text, { handwritten: true, confidence: 0.4 }]]);
  const one = (page: ReadPage, answer: CleanReadingAnswer) =>
    mergeHardReadings([held(modelPage([answerItem(answer, 1)]), page)], SOURCE_SHA).check.items;
  const two = (page: ReadPage, a: CleanReadingAnswer, b: CleanReadingAnswer) =>
    mergeHardReadings([held(modelPage([answerItem(a, 1)]), page), held(modelPage([answerItem(b, 1)]), page)],
      SOURCE_SHA).check.items;
  const order = (asWritten: string, fields: Partial<ModelItem>, dose = '', doseUnit = '',
    extra: Partial<CleanReadingAnswer> = {}): CleanReadingAnswer =>
    ({ item: { kind: 'medicine', asWritten, status: 'new', ...fields }, dose, doseUnit, ...extra });

  it('carries every "?" of asWritten into the field that holds the word, so no guess shows as certain', () => {
    const [item] = one(hand('IV Flgl 5OO mg 8hly'), order('IV? Flagyl? 500? mg 8hrly?',
      { route: 'IV', name: 'Flagyl', frequency: '8hrly', unsure: true }, '500', 'mg'));
    expect(item!.plain).toBe('IV? Flagyl? (metronidazole) 500mg? 8hrly?');
    expect(item!.fields).toMatchObject({ route: 'IV?', name: 'Flagyl? (metronidazole)', strength: '500mg?',
      frequency: '8hrly?' });
    const [diagnosis] = one(hand('Mlria?'), { item: { kind: 'diagnosis', asWritten: 'Malaria?', name: 'Malaria',
      status: 'confirmed' } });
    expect(diagnosis!.plain).toContain('Malaria?');
  });

  it('marks every shown field when asWritten marks a word no field holds', () => {
    // "1gm?" is held by no field as written (dose "1", unit "g"), so the "?" would be lost.
    const [item] = one(hand('Cftrxn 1gm bd'), order('Ceftriaxone 1gm? bd', { name: 'Ceftriaxone', frequency: 'bd' },
      '1', 'g'));
    expect(item!.plain).toBe('Ceftriaxone? 1g? bd?');
    // A note's text is held to the page as written, without marks: its guess is carried in at the end.
    const [note] = one(hand('Trnsfr to th wrd'), { item: { kind: 'note', asWritten: 'Transfer to the ward?',
      noteText: 'Transfer to the ward' } });
    expect(note!.plain).toBe('Transfer to the ward?');
  });

  it('shows the words before an order from both readings, "A? (or B?)" where they differ', () => {
    const page = hand('Strt IV Cftrxn 1g bd');
    const read = (word: string, status: ModelItem['status'] = 'new') => order(`${word} IV Ceftriaxone 1g bd`,
      { route: 'IV', name: 'Ceftriaxone', frequency: 'bd', status }, '1', 'g');
    const [item] = two(page, read('Start'), read('Stop'));
    expect(item!.plain).toBe('Start? (or Stop?) IV Ceftriaxone 1g bd (twice a day)');
    expect(item!.checkReasons).toContain('readings_disagree');
    const [stopped] = two(page, read('Start'), read('Stop', 'stopped'));
    expect(stopped!.plain).toBe('Start? (or Stop?) IV Ceftriaxone 1g bd (twice a day)');
    expect(stopped!.fields).toMatchObject({ status: 'unknown' });
  });

  it('shows a stop or hold written after an order, or with a number before it', () => {
    const [after] = one(hand('IV Cftrxn 1g bd - stp'), order('IV Ceftriaxone 1g bd - stop',
      { route: 'IV', name: 'Ceftriaxone', frequency: 'bd' }, '1', 'g'));
    expect(after!.plain).toBe('IV Ceftriaxone 1g bd (twice a day) - stop');
    const [before] = one(hand('Stp on dy 3 IV Cftrxn 1g bd'), order('Stop on day 3 IV Ceftriaxone 1g bd',
      { route: 'IV', name: 'Ceftriaxone', frequency: 'bd' }, '1', 'g'));
    expect(before!.plain).toBe('Stop on day 3 IV Ceftriaxone 1g bd (twice a day)');
  });

  it('never keeps an item active whose crossed-out writing is the whole item, marker or not', () => {
    const [item] = one(hand('Amxl 500mg tds'), order('Amoxil 500mg tds', { name: 'Amoxil', frequency: 'tds' },
      '500', 'mg', { crossedOut: 'Amoxil 500mg tds' }));
    expect(item).toMatchObject({ kind: 'note', plain: '(crossed out: Amoxil 500mg tds)' });
    expect(item!.checkReasons).toContain('crossed_out');
    // The drug name struck but the order rewritten: whether it is active is not known.
    const [rewritten] = one(hand('Amxl 250mg Amxl 500mg tds'), order('Amoxil 500mg tds',
      { name: 'Amoxil', frequency: 'tds' }, '500', 'mg', { crossedOut: 'Amoxil 250mg' }));
    expect(rewritten).toMatchObject({ kind: 'medicine', fields: { status: 'unknown' } });
  });

  it('chooses which reading comes first once per item, the same in every field and in asWritten', () => {
    const page = hand('Cftrxn 1g');
    const [item] = two(page, order('Ceftriaxone 1g', { name: 'Ceftriaxone' }, '1', 'g', { basis: { dose: 'context' } }),
      order('Cefuroxime 2g', { name: 'Cefuroxime' }, '2', 'g'));
    // The second reading read more from the letters: its whole order comes first.
    expect(item!.plain).toBe('Cefuroxime? (or Ceftriaxone?) 2g? (or 1g?)');
    expect(item!.asWritten).toBe('Cefuroxime? 2g? (or Ceftriaxone? 1g?)');
  });

  it('keeps a crossed-out group whole when merging asWritten', () => {
    expect(mergeAsWritten('IV Flagyl 500mg (crossed out: 400mg) 8hrly', 'IV Flagyl 500mg (crossed out: 200mg) 8hrly'))
      .toBe('IV Flagyl 500mg (crossed out: 400mg? (or 200mg?)) 8hrly');
  });

  it('offers the model\'s own strength as the other option where it says another number', () => {
    const [item] = one(hand('Flgyl 4OOmg'), order('Flagyl 400mg', { name: 'Flagyl', strength: '400mg' }, '500', 'mg'));
    expect(item!.plain).toBe('Flagyl (metronidazole) 500mg? (or 400mg?)');
    const [same] = one(hand('Flgyl 4OOmg'), order('Flagyl 400 mg', { name: 'Flagyl', strength: '400 mg' }, '400', 'mg'));
    expect(same!.plain).toBe('Flagyl (metronidazole) 400mg');
  });

  it('turns a first-pass order into unknown status when the picture reading found its line crossed out', () => {
    const page = hand('Amxl 500mg tds');
    const first = checkPage({ page: 1, lines: page.lines, sourceSha256Hex: SOURCE_SHA, readBy: 'first_pass',
      masker: createMasker(), answer: modelPage([modelItem({ kind: 'medicine', asWritten: 'Amxl 500mg tds',
        lineIds: ['p1-l1'], name: 'Amxl', strength: '500mg', frequency: 'tds', status: 'new' })]) });
    expect(first.items).toHaveLength(1);
    const hard = mergeHardReadings([held(modelPage([answerItem(order('(crossed out: Amoxil 500mg tds)',
      { name: 'Amoxil', frequency: 'tds' }, '500', 'mg', { crossedOut: 'Amoxil 500mg tds' }), 1)]), page)], SOURCE_SHA).check;
    const merged = mergeReread(first, hard, page.lines, 'image').items;
    const kept = merged.find((item) => item.readBy === 'first_pass')!;
    expect(kept).toMatchObject({ kind: 'medicine', confidence: 'check_carefully', fields: { status: 'unknown' } });
    expect(kept.checkReasons).toEqual(expect.arrayContaining(['not_in_picture_reading', 'crossed_out']));
  });
});

describe('the clean hard-page prompt (version 5, and 6 with zoom)', () => {
  const lines = [{ id: 'p1-l1', text: 'IV Flgl 5OOmg 8hly', confidence: 0.4, handwritten: true,
    box: rowBox(1) }];
  const text = hardPageMessage(1, lines, { width: 800, height: 1000 });

  it('asks for a best guess for every word, the tokens, instructions as notes and crossed-out writing on its item', () => {
    for (const phrase of ['your best guess for every word', 'put "?" straight after each one you are not sure of',
      '"IV Flagyl? 500mg? 8hrly?"', 'Write "[?]" only where there is writing but no letter or digit shapes',
      'is written "(? on paper)" where it stands', '"Transfer to the ward"', '"Switch to IV Ceftriaxone 1g"',
      'any other instruction or plan is a "note"', 'Every field is the reading itself, never a description of it',
      'Never write a sentence about the writing', 'Leave "plain" as ""', 'never an item of its own',
      '"(crossed out: X)"', 'put X, with its "?" marks, in "crossedOut"']) expect(text).toContain(phrase);
    expect(text).not.toContain('[unreadable]');
  });

  it('asks for crossedOut and a free-text frequency in the hard-page answer schema', () => {
    const items = (MODEL_OUTPUT_HARD_PAGE_JSON_SCHEMA.properties as { items: { items: { required: string[];
      properties: Record<string, { enum?: unknown }> } } }).items.items;
    expect(items.required).toContain('crossedOut');
    expect(items.properties.frequency!.enum).toBeUndefined();
  });
});
