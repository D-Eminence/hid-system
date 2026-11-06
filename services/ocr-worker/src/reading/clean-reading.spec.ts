import { answerItem, CLEAN_READING_ROWS, lineBox, rowBox, type CleanReadingAnswer } from './clean-reading-fixtures';
import { paperReadingPayloadSchema, type PaperItem } from './contract';
import { alternatives, carryMarks, displayOf, guessKeys, hasQuestionMark, isDescription, markPartialGuesses, markWords, mergeAsWritten,
  mergeHardReadings, prepareHardAnswer, splitAlternative, type HardReading } from './hard-page';
import { checkPage, checkReasonSentence, mergeReread } from './items';
import { createMasker } from './masking';
import { hardPageMessage, MODEL_OUTPUT_HARD_PAGE_JSON_SCHEMA, type ModelItem, type ModelPage } from './prompt';
import { modelItem, modelPage, readPage, SOURCE_SHA } from './test-fixtures';
import type { ReadPage } from '../types';

/** The fixture page: one hard handwritten line per row (fictional, garbled as the text service reads hard writing). */
const PAGE: ReadPage = readPage(1, CLEAN_READING_ROWS.map((row, index) => [row.lineText,
  { handwritten: true, confidence: 0.4, box: lineBox(index + 1) }] as [string, Partial<ReadPage['lines'][number]>]));

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
      if (row.status) expect(item.fields).toMatchObject({ status: row.status });
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
    // Shown where it stands in the reading that saw it (asWritten is merged word by word).
    expect(seenByOne[0]!.plain).toBe('IV Flagyl (metronidazole) 500mg (crossed out: 400mg?) 8hrly (every 8 hours)');
    expect(seenByOne[0]!.checkReasons).toEqual(expect.arrayContaining(['crossed_out', 'readings_disagree']));
    // The struck dose is never taken for the item's dose by the checks.
    expect(seenByOne[0]!.checkReasons).not.toContain('strength_not_as_written');
    const same = mergeHardReadings([held(modelPage([order('400mg?')]), page), held(modelPage([order('400mg')]), page)],
      SOURCE_SHA).check.items[0]!;
    expect(same.plain).toBe('IV Flagyl (metronidazole) 500mg (crossed out: 400mg?) 8hrly (every 8 hours)');
    expect(same.checkReasons).not.toContain('readings_disagree');
  });

  it('shows asWritten itself, annotated where each field stands, never a word dropped or moved', () => {
    const note = (asRead: string, more: Partial<Parameters<typeof displayOf>[1][number]> = {}) => ({ asRead, guess: false, ...more });
    // A listed brand's generic after its name, a respelling marked, a certain frequency in words, a context guess marked.
    expect(displayOf('Switch to IV Flagyl 500 mg tds', [note('Flagyl', { after: '(metronidazole)' }),
      note('500mg', { guess: true }), note('tds', { shorthand: 'frequency' })], ''))
      .toBe('Switch to IV Flagyl (metronidazole) 500mg? tds (three times a day)');
    expect(displayOf('IV Flgyl 500mg', [note('Flgyl', { replace: 'Flagyl', after: '(metronidazole)', guess: true })], ''))
      .toBe('IV Flagyl? (metronidazole) 500mg');
    // Every written word stays, in order: a second dose, a taper, another drug, a query on the paper.
    const written = 'Pred 40mg od x5/7 then 20mg od, stop (? on paper) Omeprazole 20mg';
    expect(displayOf(written, [note('40mg'), note('od', { shorthand: 'frequency' })], '')).toBe(
      'Pred 40mg od (once a day)'.replace(' (once a day)', '') + ' x5/7 then 20mg od, stop (? on paper) Omeprazole 20mg');
    // A guess whose words are not written is added at the end, marked; crossed-out writing asWritten lacks, after it.
    expect(displayOf('IV Ceftriaxone 1g', [note('8hrly', { guess: true, shorthand: 'frequency' })], '400mg'))
      .toBe('IV Ceftriaxone 1g 8hrly? (crossed out: 400mg)');
    // The other reading's words are annotated the same way; the same text twice is shown once, marked.
    expect(displayOf('Flgyl? (or Flagyl?) 400mg', [note('Flgyl', { replace: 'Flagyl', after: '(metronidazole)', guess: true }),
      note('Flagyl', { after: '(metronidazole)', guess: true })], '')).toBe('Flagyl? (metronidazole) 400mg');
    // No reading at all: the fields.
    expect(displayOf('', [], '', 'Hb? 9.1 g/dL L')).toBe('Hb? 9.1 g/dL L');
  });

  it('marks a bracketed guess for a word cut short, and nothing else', () => {
    expect(markPartialGuesses('IV Pl… (Plasil) 10mg')).toBe('IV Pl… (Plasil?) 10mg');
    expect(markPartialGuesses('IV Pl… (or Ph…) (Plasil?) 10mg')).toBe('IV Pl… (or Ph…) (Plasil?) 10mg');
    expect(markPartialGuesses('IV Flagyl (metronidazole) 500mg')).toBe('IV Flagyl (metronidazole) 500mg');
    expect(markWords('Am… 500mg')).toBe('Am… 500mg?');
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
    // Shown as written ("500? mg"); the fields carry the marks for the payload.
    expect(item!.plain).toBe('IV? Flagyl? (metronidazole) 500? mg 8hrly?');
    expect(item!.fields).toMatchObject({ route: 'IV?', name: 'Flagyl? (metronidazole)', strength: '500mg?',
      frequency: '8hrly?' });
    const [diagnosis] = one(hand('Mlria?'), { item: { kind: 'diagnosis', asWritten: 'Malaria?', name: 'Malaria',
      status: 'confirmed' } });
    expect(diagnosis!.plain).toContain('Malaria?');
  });

  it('shows a guess on a word no field holds as written, and marks the field that holds it', () => {
    // "1gm?" is held by no field as written (dose "1", unit "g"), so the "?" would be lost.
    const [item] = one(hand('Cftrxn 1gm bd'), order('Ceftriaxone 1gm? bd', { name: 'Ceftriaxone', frequency: 'bd' },
      '1', 'g'));
    // The shown text is asWritten, so "1gm?" shows its guess; the dose that holds it is marked in the fields.
    expect(item!.plain).toBe('Ceftriaxone 1gm? bd (twice a day)');
    expect(item!.fields).toMatchObject({ name: 'Ceftriaxone', strength: '1g?', frequency: 'bd' });
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
    expect(item!.asWritten).toBe('Cefuroxime? (or Ceftriaxone?) 2g? (or 1g?)');
  });

  it('keeps a crossed-out group whole when merging asWritten', () => {
    expect(mergeAsWritten('IV Flagyl 500mg (crossed out: 400mg) 8hrly', 'IV Flagyl 500mg (crossed out: 200mg) 8hrly'))
      .toBe('IV Flagyl 500mg (crossed out: 400mg? (or 200mg?)) 8hrly');
  });

  it('offers the model\'s own strength as the other option where it says another number', () => {
    const [item] = one(hand('Flgyl 4OOmg'), order('Flagyl 400mg', { name: 'Flagyl', strength: '400mg' }, '500', 'mg'));
    // The written number where it stands, the rebuilt one as the other option.
    expect(item!.plain).toBe('Flagyl (metronidazole) 400mg? (or 500mg?)');
    const [same] = one(hand('Flgyl 4OOmg'), order('Flagyl 400 mg', { name: 'Flagyl', strength: '400 mg' }, '400', 'mg'));
    expect(same!.plain).toBe('Flagyl (metronidazole) 400 mg');
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

describe('the shown text is the reading itself (re-review of the clean reading)', () => {
  const hand = (...texts: string[]) => readPage(1, texts.map((text) => [text, { handwritten: true, confidence: 0.4 }] as
    [string, { handwritten: boolean; confidence: number }]));
  const one = (page: ReadPage, ...answers: CleanReadingAnswer[]) =>
    mergeHardReadings([held(modelPage(answers.map((answer, index) => answerItem(answer, index + 1))), page)],
      SOURCE_SHA).check.items;
  const two = (page: ReadPage, a: CleanReadingAnswer[], b: CleanReadingAnswer[]) =>
    mergeHardReadings([held(modelPage(a.map((answer, index) => answerItem(answer, index + 1))), page),
      held(modelPage(b.map((answer, index) => answerItem(answer, index + 1))), page)], SOURCE_SHA).check.items;
  const order = (asWritten: string, fields: Partial<ModelItem>, dose = '', doseUnit = '',
    extra: Partial<CleanReadingAnswer> = {}): CleanReadingAnswer =>
    ({ item: { kind: 'medicine', asWritten, status: 'new', ...fields }, dose, doseUnit, ...extra });

  it('never drops a word written between the fields: a second dose, a taper, another drug, a query on the paper', () => {
    const [taper] = one(hand('Pred 40mg od x5/7 then 20mg od'), order('Prednisolone 40mg od x5/7 then 20mg od',
      { name: 'Prednisolone', frequency: 'od', duration: '5/7' }, '40', 'mg'));
    expect(taper!.plain).toBe('Prednisolone 40mg od x5/7 then 20mg od');
    const [two_] = one(hand('Flagyl 400mg + Amoxil 500mg tds'), order('Flagyl 400mg + Amoxil 500mg tds',
      { name: 'Flagyl', frequency: 'tds' }, '400', 'mg'));
    expect(two_!.plain).toBe('Flagyl (metronidazole) 400mg + Amoxil 500mg tds (three times a day)');
    const [query] = one(hand('IV Ceftriaxone ? 1g bd'), order('IV Ceftriaxone (? on paper) 1g bd',
      { route: 'IV', name: 'Ceftriaxone', frequency: 'bd' }, '1', 'g'));
    expect(query!.plain).toBe('IV Ceftriaxone (? on paper) 1g bd (twice a day)');
  });

  it('matches whole words only when carrying a guess ("ward" is not in "forward")', () => {
    expect(carryMarks('Transfer to the ward', guessKeys('Forward? to the ward'), new Set())).toBe('Transfer to the ward');
    expect(carryMarks('500', guessKeys('Flagyl 500mg?'), new Set())).toBe('500?');
  });

  it('makes a medicine\'s status unknown where its shown text stops, holds or changes it, and keeps it check_carefully', () => {
    const [stop] = one(hand('IV Cftrxn 1g bd - stp'), order('IV Ceftriaxone 1g bd - stop',
      { route: 'IV', name: 'Ceftriaxone', frequency: 'bd' }, '1', 'g'));
    expect(stop).toMatchObject({ plain: 'IV Ceftriaxone 1g bd (twice a day) - stop', fields: { status: 'unknown' },
      confidence: 'check_carefully' });
    expect(stop!.checkReasons).toContain('status_cue_on_line');
    // Already stopped: kept.
    const [stopped] = one(hand('IV Cftrxn 1g bd - stp'), order('IV Ceftriaxone 1g bd - stop',
      { route: 'IV', name: 'Ceftriaxone', frequency: 'bd', status: 'stopped' }, '1', 'g'));
    expect(stopped!.fields).toMatchObject({ status: 'stopped' });
    // Crossed-out "stop" is not what the order says.
    const [crossed] = one(hand('IV Cftrxn 1g bd stp'), order('IV Ceftriaxone 1g bd (crossed out: stop)',
      { route: 'IV', name: 'Ceftriaxone', frequency: 'bd' }, '1', 'g', { crossedOut: 'stop' }));
    expect(crossed!.fields).toMatchObject({ status: 'new' });
  });

  it('makes the status unknown where the two readings differ on what to do with the order', () => {
    const page = hand('Cnt IV Cftrxn 1g bd');
    const read = (word: string) => order(`${word} IV Ceftriaxone 1g bd`,
      { route: 'IV', name: 'Ceftriaxone', frequency: 'bd' }, '1', 'g');
    const [item] = two(page, [read('Continue')], [read('Start')]);
    expect(item!.plain).toBe('Continue? (or Start?) IV Ceftriaxone 1g bd (twice a day)');
    expect(item!.fields).toMatchObject({ status: 'unknown' });
    expect(item!.checkReasons).toEqual(expect.arrayContaining(['readings_disagree', 'status_cue_on_line']));
  });

  it('shows a stretch only one reading has alone, marked, never as a bare "(or Stop?)"', () => {
    const page = hand('Stp IV Cftrxn 1g bd');
    const [item] = two(page, [order('IV Ceftriaxone 1g bd', { route: 'IV', name: 'Ceftriaxone', frequency: 'bd' }, '1', 'g')],
      [order('Stop IV Ceftriaxone 1g bd', { route: 'IV', name: 'Ceftriaxone', frequency: 'bd' }, '1', 'g')]);
    expect(item!.asWritten).toBe('Stop? IV Ceftriaxone 1g bd');
    expect(item!.plain).toBe('Stop? IV Ceftriaxone 1g bd (twice a day)');
    expect(item!.plain).not.toContain('(or');
    expect(item!.fields).toMatchObject({ status: 'unknown' });
    expect(item!.checkReasons).toContain('readings_disagree');
  });

  it('joins an item one reading found to the other reading\'s wholly crossed-out note on that line', () => {
    const page = hand('Amxl 500mg tds');
    const live = order('Amoxil 500mg tds', { name: 'Amoxil', frequency: 'tds' }, '500', 'mg');
    const struck: CleanReadingAnswer = { item: { kind: 'note', asWritten: '(crossed out: Amoxil 500mg tds)',
      noteText: '(crossed out: Amoxil 500mg tds)' }, crossedOut: 'Amoxil 500mg tds', basis: { other: 'letters' } };
    for (const items of [two(page, [live], [struck]), two(page, [struck], [live])]) {
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: 'medicine', fields: { status: 'unknown' }, confidence: 'check_carefully',
        plain: 'Amoxil? (amoxicillin) 500mg? tds? (or (crossed out: Amoxil 500mg tds))' });
      expect(items[0]!.checkReasons).toEqual(expect.arrayContaining(['crossed_out', 'readings_disagree']));
      expect(items[0]!.checkReasons).not.toContain('single_reading_only');
    }
  });

  it('keeps the "?" of the model\'s strength where the rebuilt one has none', () => {
    const prepared = prepareHardAnswer(modelPage([answerItem(order('Flagyl 500mg', { name: 'Flagyl', strength: '500mg?' },
      '500', 'mg'), 1)]));
    expect(prepared.items[0]!.strength).toBe('500mg?');
    const [item] = one(hand('Flgyl 5OOmg'), order('Flagyl 500mg', { name: 'Flagyl', strength: '500mg?' }, '500', 'mg'));
    expect(item!.plain).toBe('Flagyl (metronidazole) 500mg?');
  });

  it('never matches a word cut short to the list or completes it', () => {
    const prepared = prepareHardAnswer(modelPage([answerItem(order('Amox… 500mg', { name: 'Amox…' }, '500', 'mg'), 1),
      answerItem(order('Pl… (Plasil) 10mg', { name: 'Pl… (Plasil)' }, '10', 'mg'), 2)]));
    expect(prepared.items.map((item) => [item.name, item.hard?.generic])).toEqual([['Amox…', null], ['Pl… (Plasil?)', null]]);
    expect(prepared.items[1]!.asWritten).toBe('Pl… (Plasil?) 10mg');
  });

  it('keeps field placeholders as they are: no guess mark added, not a query, not a word for the list', () => {
    const [item] = one(hand('IV Cefrxme 8hly'), order('IV Cefuroxime? [dose?] 8hrly', { route: 'IV', name: 'Cefuroxime?',
      frequency: '8hrly' }, '[dose?]'));
    expect(item!.plain).toBe('IV Cefuroxime? [dose?] 8hrly (every 8 hours)');
    expect(item!.fields).toMatchObject({ strength: '[dose?]', status: 'new' });
    expect(item!.checkReasons).not.toContain('status_cue_on_line');
    expect(item!.checkReasons).toContain('unsure_from_letters');
  });

  it('says a field guessed from context apart from a word unsure from its letters, both shown "?"', () => {
    const [context] = one(hand('IV Flagyl 500mg 8hly'), order('IV Flagyl 500mg 8hrly', { route: 'IV', name: 'Flagyl',
      frequency: '8hrly' }, '500', 'mg', { basis: { frequency: 'context' } }));
    expect(context!.plain).toBe('IV Flagyl (metronidazole) 500mg 8hrly?');
    expect(context!.checkReasons).toContain('field_from_context');
    expect(context!.checkReasons).not.toContain('unsure_from_letters');
    const [letters] = one(hand('IV Flagyl 500mg 8hly'), order('IV Flagyl 500mg 8hrly?', { route: 'IV', name: 'Flagyl',
      frequency: '8hrly?' }, '500', 'mg'));
    expect(letters!.plain).toBe('IV Flagyl (metronidazole) 500mg 8hrly?');
    expect(letters!.checkReasons).toContain('unsure_from_letters');
    expect(letters!.checkReasons).not.toContain('field_from_context');
  });

  it('marks a frequency that is no code and a dose written in words, like an unlisted drug', () => {
    const prepared = prepareHardAnswer(modelPage([answerItem(order('Amoxil one alternate days', { name: 'Amoxil',
      frequency: 'alternate days' }, 'one'), 1)]));
    expect(prepared.items[0]).toMatchObject({ frequency: 'alternate? days?', strength: 'one?' });
  });

  it('describes vision as a finding, never as a description of the writing', () => {
    for (const text of ['Blurred vision', 'Blurry vision x 2/7', 'Faint vision?', 'C/o blurred letters when reading',
      'Words blurry on reading', 'Letters faint and blurred - refer eye clinic', 'Text appears blurred to patient',
      'Pt appears to read well', 'Sees faded text']) {
      expect([text, isDescription(text)]).toEqual([text, false]);
    }
    for (const text of ['Blurred text', 'Faint writing', 'Text blurred.', 'Smudged entry, check the paper', 'Words faint',
      'The writing appears to say Flagyl']) {
      expect([text, isDescription(text)]).toEqual([text, true]);
    }
  });
});

describe('the clean hard-page prompt (version 7, and 8 with zoom)', () => {
  const lines = [{ id: 'p1-l1', text: 'IV Flgl 5OOmg 8hly', confidence: 0.4, handwritten: true,
    box: rowBox(1) }];
  const text = hardPageMessage(1, lines, { width: 800, height: 1000 });

  it('asks for a best guess for every word, the tokens, instructions as notes and crossed-out writing on its item', () => {
    for (const phrase of ['your best guess for every word', 'put "?" straight after each one you are not sure of',
      '"IV Flagyl? 500mg? 8hrly?"', 'Write "[?]" only where there is writing but no letter or digit shapes',
      'is written "(? on paper)" where it stands', '"Transfer to the ward"', '"Switch to IV Ceftriaxone 1g"',
      'any other instruction or plan is a "note"', 'followed by "…" (for example "Am…")', '"Pl… (Plasil?)"',
      '"[route?]", "[drug?]", "[dose?]" or "[freq?]"', '"IV? (or ✓?)"', 'Ignore writing that shows through from the back',
      'text cut off at the edges of the picture', 'a frequency read from where a squiggle sits', 'Every field is the reading itself, never a description of it',
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
