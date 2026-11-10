/**
 * The coordinator/owner cleanups of 2026-11-10 (about 20:30 UTC), after the first live run with the clean hard-page
 * reading: at most one other option per field, two items where a hard page's readings name different drugs, headings
 * and form labels left out, and a note repeating an order left out. Every page, name and number here is fictional.
 */
import { answerItem, CLEAN_READING_ROWS, lineBox, type CleanReadingAnswer } from './clean-reading-fixtures';
import type { PaperItem } from './contract';
import { alternatives, drugIdentityOf, limitAlternatives, mergeAsWritten, mergeHardReadings, prepareHardAnswer,
  sameDrug, type AlternativeDrops, type HardReading } from './hard-page';
import { checkPage, type PageCheck } from './items';
import { createMasker } from './masking';
import type { ModelItem, ModelPage } from './prompt';
import { modelPage, readPage, SOURCE_SHA } from './test-fixtures';
import { duplicatesOrder, isHeadingNote, tidyPage } from './tidy';
import type { ReadPage } from '../types';

const hand = (...texts: string[]) => readPage(1, texts.map((text, index) =>
  [text, { handwritten: true, confidence: 0.4, box: lineBox(index + 1) }] as [string, Partial<ReadPage['lines'][number]>]));
function held(answer: ModelPage, page: ReadPage): HardReading {
  const prepared = prepareHardAnswer(answer);
  return { answer: prepared, check: checkPage({ page: 1, lines: page.lines, answer: prepared, sourceSha256Hex: SOURCE_SHA,
    readBy: 'reread', masker: createMasker(), fromImage: true }) };
}
const two = (page: ReadPage, a: CleanReadingAnswer[], b: CleanReadingAnswer[]) => mergeHardReadings([
  held(modelPage(a.map((answer, index) => answerItem(answer, index + 1))), page),
  held(modelPage(b.map((answer, index) => answerItem(answer, index + 1))), page)], SOURCE_SHA);
const order = (asWritten: string, fields: Partial<ModelItem>, dose = '', doseUnit = '',
  extra: Partial<CleanReadingAnswer> = {}): CleanReadingAnswer =>
  ({ item: { kind: 'medicine', asWritten, status: 'new', ...fields }, dose, doseUnit, ...extra });
const optionsIn = (text: string) => text.split('(or ').length - 1;
/** Every "(or …)" group of a text holds no "(or" itself. */
const nested = (text: string) => /\(or [^()]*(?:\([^()]*\)[^()]*)*\(or /.test(text);
const fieldTexts = (item: PaperItem) => Object.values(item.fields as Record<string, unknown>)
  .filter((value): value is string => typeof value === 'string');

describe('the problem line of the live run of 2026-11-10 (a fictional reconstruction)', () => {
  // Read A wrote two options of its own (rule B allows "(or X?)"); read B read another route, a drug cut short with a
  // guess, and another dose. Before the cleanup this was one item, shown
  // "sc? (or IV?) Omeprazole? (or Enoxaparin?) 40mg? (or IM? cr… (Pentazocine?) 30mg?) 8hrly?".
  const page = hand('sc Omprzle 40mg 8hly');
  const readA = order('sc? (or IV?) Omeprazole? (or Enoxaparin?) 40mg? 8hrly?',
    { route: 'sc?', name: 'Omeprazole?', strength: '40mg?', frequency: '8hrly?' }, '40?', 'mg');
  const readB = order('IM? cr… (Pentazocine?) 30mg? 8hrly?',
    { route: 'IM?', name: 'cr… (Pentazocine?)', strength: '30mg?', frequency: '8hrly?' }, '30?', 'mg');

  it('becomes two items, one per reading, each with its own fields, on the same line and box', () => {
    for (const [first, second] of [[readA, readB], [readB, readA]]) {
      const { check, agreement } = two(page, [first!], [second!]);
      expect(check.items).toHaveLength(2);
      const [omeprazole, pentazocine] = [check.items.find((item) => item.plain.includes('Omeprazole'))!,
        check.items.find((item) => item.plain.includes('Pentazocine'))!];
      expect(omeprazole.plain).toBe('sc? (or IV?) Omeprazole? (or Enoxaparin?) 40mg? 8hrly?');
      expect(omeprazole.fields).toMatchObject({ route: 'sc?', name: 'Omeprazole?', strength: '40mg?', frequency: '8hrly?' });
      expect(pentazocine.plain).toBe('IM? cr… (Pentazocine?) 30mg? 8hrly?');
      expect(pentazocine.fields).toMatchObject({ route: 'IM?', name: 'cr… (Pentazocine?)', strength: '30mg?',
        frequency: '8hrly?' });
      for (const item of check.items) {
        expect(item.confidence).toBe('check_carefully');
        expect(item.checkReasons).toContain('readings_disagree');
        expect(item.checkReasons).not.toContain('single_reading_only');
        expect(item.lineIds).toEqual(['p1-l1']);
        expect(item.box).toEqual(check.items[0]!.box);
        // At most one other option per field, none inside another.
        for (const text of [item.plain, item.asWritten, ...fieldTexts(item)]) expect(nested(text)).toBe(false);
        for (const text of fieldTexts(item)) expect(optionsIn(text)).toBeLessThanOrEqual(1);
      }
      expect(new Set(check.items.map((item) => item.id)).size).toBe(2);
      expect(agreement).toMatchObject({ drugSplits: 1, itemsPaired: 0, itemsSingle: 0 });
    }
  });

  it('shows one other option per field where the same drug is read (the line with Omeprazole in both)', () => {
    const sameDrugB = order('IM? (or IV?) Omeprazole? 30mg? 8hrly?',
      { route: 'IM?', name: 'Omeprazole?', strength: '30mg?', frequency: '8hrly?' }, '30?', 'mg');
    const { check, agreement } = two(page, [readA], [sameDrugB]);
    expect(check.items).toHaveLength(1);
    const [item] = check.items;
    expect(item!.plain).toBe('sc? (or IM?) Omeprazole? (or Enoxaparin?) 40mg? (or 30mg?) 8hrly?');
    expect(item!.fields).toMatchObject({ route: 'sc? (or IM?)', name: 'Omeprazole?', strength: '40mg? (or 30mg?)' });
    expect(nested(item!.plain)).toBe(false);
    for (const text of fieldTexts(item!)) expect(optionsIn(text)).toBeLessThanOrEqual(1);
    expect(item!.checkReasons).toContain('readings_disagree');
    // The options left out (read A's own "(or IV?)" and read B's) are counted, never logged as text.
    expect(agreement.alternativesDropped).toBeGreaterThan(0);
  });
});

describe('one other option per field (alternatives, mergeAsWritten, limitAlternatives)', () => {
  it('keeps A\'s own reading and the strongest option of the other reading, counting the rest', () => {
    const drops: AlternativeDrops = { count: 0 };
    expect(alternatives('Arteether? (or Artemether?)', 'Artesunate?', { drops })).toBe('Arteether? (or Artesunate?)');
    expect(drops.count).toBe(1);
    // The other reading offers nothing different: A's own option stays.
    expect(alternatives('500mg? (or 400mg?)', '500mg?')).toBe('500mg? (or 400mg?)');
    // Both with options: the other reading's, ranked by the score, else in the order offered.
    expect(alternatives('A? (or B?)', 'C? (or D?)')).toBe('A? (or C?)');
    expect(alternatives('A? (or B?)', 'C? (or D?)', { score: (candidate) => [candidate === 'D?' ? 1 : 0] }))
      .toBe('A? (or D?)');
    // A's own option stronger than every option of the other read: A's own is shown (review of 2026-11-10).
    const ownDrops: AlternativeDrops = { count: 0 };
    expect(alternatives('500mg? (or 400mg?)', '250mg?', { drops: ownDrops,
      score: (_candidate, source) => (source === 'own' ? [1, 1] : [0, 0]) })).toBe('500mg? (or 400mg?)');
    expect(ownDrops.count).toBe(1);
    // Equal scores: the other read's option first.
    expect(alternatives('500mg? (or 400mg?)', '250mg?', { score: () => [1, 1] })).toBe('500mg? (or 250mg?)');
    // Never an option inside an option.
    expect(alternatives('A? (or B? (or C?))', 'D?')).toBe('A? (or D?)');
    expect(alternatives('A? (or B? (or C?))', '')).toBe('A? (or B?)');
    // Unchanged where neither reading holds an option.
    expect(alternatives('Cefuroxime', 'Ceftriaxone?')).toBe('Cefuroxime? (or Ceftriaxone?)');
  });

  it('chooses the listed option before the unlisted one, deterministically', () => {
    // The other reading gave a frequency in words with a code as its own option: the code (on its list) is shown.
    const page = hand('Flgyl 400mg tds');
    for (const [a, b] of [['tds', 'thrice? (or bd?)'], ['tds', 'bd? (or thrice?)']]) {
      const { check } = two(page, [order(`Flagyl 400mg ${a}`, { name: 'Flagyl', frequency: a }, '400', 'mg')],
        [order(`Flagyl 400mg ${b}`, { name: 'Flagyl', frequency: b }, '400', 'mg')]);
      expect(check.items).toHaveLength(1);
      expect((check.items[0]!.fields as { frequency: string }).frequency).toBe('tds? (or bd?)');
    }
  });

  it('keeps a reading\'s own option with its word, and never nests the other reading\'s words', () => {
    expect(mergeAsWritten('IV? (or ✓?) Ceftriaxone 1g', 'IM Ceftriaxone 1g')).toBe('IV? (or IM?) Ceftriaxone 1g');
    expect(mergeAsWritten('IV? (or ✓?) Ceftriaxone 1g', 'IV? Ceftriaxone 1g')).toBe('IV? (or ✓?) Ceftriaxone 1g');
    // The other reading's own option dropped where its word is shown as the option.
    expect(mergeAsWritten('sc Omeprazole', 'IM? (or IV?) Omeprazole')).toBe('sc? (or IM?) Omeprazole');
    // Unequal stretches: the other reading's words as the one option, the readings' own options left out.
    const drops: AlternativeDrops = { count: 0 };
    const merged = mergeAsWritten('sc? (or IV?) Omeprazole? (or Enoxaparin?) 40mg? 8hrly?',
      'IM? (or PO?) cr… (Pentazocine?) 30mg? 8hrly?', drops);
    expect(nested(merged)).toBe(false);
    expect(optionsIn(merged)).toBe(1);
    expect(drops.count).toBe(3);
    // The other reading's crossed-out writing after the option, never inside it.
    expect(mergeAsWritten('IV Flagyl 500mg', 'IV Flagyl 250mg (crossed out: 400mg)'))
      .toBe('IV Flagyl 500mg? (or 250mg?) (crossed out: 400mg)');
  });

  it('guards every shown text: no option straight after another, none inside one', () => {
    const drops: AlternativeDrops = { count: 0 };
    expect(limitAlternatives('IV? (or ✓?) (or IM?) Ceftriaxone', drops)).toBe('IV? (or ✓?) Ceftriaxone');
    expect(limitAlternatives('40mg? (or IM? (or IV?) 30mg?) 8hrly?', drops)).toBe('40mg? (or IM? 30mg?) 8hrly?');
    expect(drops.count).toBe(2);
    // A group that is not an option (a guess, a generic) is left as it is.
    expect(limitAlternatives('Pl… (or Ph…) (Plasil?) 10mg?')).toBe('Pl… (or Ph…) (Plasil?) 10mg?');
  });
});

describe('two readings naming different drugs (whole-drug rule)', () => {
  it('tells a spelling variant or brand from another drug by the drug list, unknown names by their letters', () => {
    const id = (name: string) => drugIdentityOf(name);
    expect(sameDrug(id('Flagyl'), id('Metronidazole'))).toBe(true);
    expect(sameDrug(id('Metronidazol'), id('Metronidazole?'))).toBe(true);
    expect(sameDrug(id('Fictomycin'), id('Fictomicin'))).toBe(true);
    expect(sameDrug(id('Am…'), id('Amoxicillin'))).toBe(true);
    expect(sameDrug(id('cr… (Pentazocine?)'), id('Fortwin'))).toBe(true);
    expect(sameDrug(id('Omeprazole?'), id('cr… (Pentazocine?)'))).toBe(false);
    expect(sameDrug(id('Metronidazole'), id('Tinidazole'))).toBe(false);
    expect(sameDrug(id('Metronidazole'), id('Metrofictional'))).toBe(false);
    expect(sameDrug(id('Fictomycin'), id('Otherzolam'))).toBe(false);
    // A real unlisted look-alike of a listed name is another drug (review of 2026-11-10).
    expect(sameDrug(id('Quinine'), id('Quinidine'))).toBe(false);
    expect(sameDrug(id('Artemether'), id('Arteether'))).toBe(false);
    // A name that says nothing never splits an item.
    for (const name of ['', '[drug?]', '[?]']) expect(sameDrug(id(name), id('Omeprazole'))).toBe(true);
  });

  it('keeps a spelling-variant disagreement as one item with one other option', () => {
    const page = hand('Fctmycn 250mg bd');
    const { check, agreement } = two(page, [order('Fictomycin 250mg bd', { name: 'Fictomycin', frequency: 'bd' }, '250', 'mg')],
      [order('Fictomicin 250mg bd', { name: 'Fictomicin', frequency: 'bd' }, '250', 'mg')]);
    expect(check.items).toHaveLength(1);
    expect(check.items[0]!.plain).toBe('Fictomycin? (or Fictomicin?) 250mg bd (twice a day)');
    expect(optionsIn(check.items[0]!.plain)).toBe(1);
    expect(check.items[0]!.checkReasons).toContain('readings_disagree');
    expect(agreement).toMatchObject({ drugSplits: 0, itemsPaired: 1 });
  });

  it('keeps a brand and its generic as one item', () => {
    const page = hand('Flgyl 400mg tds');
    const { check, agreement } = two(page, [order('Flagyl 400mg tds', { name: 'Flagyl', frequency: 'tds' }, '400', 'mg')],
      [order('Metronidazole 400mg tds', { name: 'Metronidazole', frequency: 'tds' }, '400', 'mg')]);
    expect(check.items).toHaveLength(1);
    expect(check.items[0]!.plain).toBe('Flagyl? (metronidazole) (or Metronidazole?) 400mg tds (three times a day)');
    expect(optionsIn(check.items[0]!.plain)).toBe(1);
    expect(agreement).toMatchObject({ drugSplits: 0, itemsPaired: 1 });
  });
});

/** A kept item as the check screen gets it, for the tidy rules. */
function kept(kind: PaperItem['kind'], asWritten: string, line: number, fields: Record<string, unknown> = {},
  box = { left: 0.12, top: 0.05 + 0.04 * (line - 1), width: 0.3, height: 0.02 }): PaperItem {
  const base = { id: `it-${line}-${asWritten.length}`, page: 1, kind, asWritten, plain: asWritten, lineIds: [`p1-l${line}`],
    box, confidence: 'check_carefully', checkReasons: [], checkReason: null, readBy: 'reread', dateAsWritten: null,
    prescription: null };
  const defaults: Record<PaperItem['kind'], Record<string, unknown>> = {
    note: { text: asWritten },
    medicine: { name: null, strength: null, form: null, route: null, frequency: null, duration: null, status: 'unknown' },
    diagnosis: { name: asWritten, status: 'confirmed' },
    allergy: { substance: asWritten, reaction: null, severity: null, noKnownAllergies: false },
    lab_result: { test: asWritten, value: null, unit: null, referenceRange: null, flag: null },
    vital: { measure: 'other', value: asWritten, unit: null },
  };
  return { ...base, fields: { ...defaults[kind], ...fields } } as unknown as PaperItem;
}
const pageOf = (items: PaperItem[]): PageCheck => ({ items, droppedUngrounded: 0, droppedByReason: {},
  identity: { nameAsWritten: null, dateOfBirthAsWritten: null, folderNumberAsWritten: null, sexAsWritten: null,
    lineIds: [], box: null }, pageUnsure: false, rereadReasons: [], flagReasons: [] });

describe('headings and form labels are not items', () => {
  it('leaves out a note made only of heading words, and nothing else', () => {
    for (const text of ['Trauma? surgery? Treatment? sheet?', 'Immediate? Management?', 'Plan?', 'TREATMENT SHEET',
      'Drug chart', 'Accident and Emergency', 'Department of Surgery', 'Ward notes']) {
      expect([text, isHeadingNote(kept('note', text, 1))]).toEqual([text, true]);
    }
    for (const text of ['Transfer to the ward', '— Admit?', 'Admit?', 'Switch to IV Ceftriaxone 1g', 'Review in [?] days',
      'Ward round', 'Plan: admit', 'Plan: review in 2 days', 'Discharge plan', 'Surgery tomorrow', 'Ward 3',
      '(crossed out: Treatment sheet)', 'Plan (? on paper)', 'Stop treatment', 'Continue management',
      'Omeprazole chart', 'Malaria']) {
      expect([text, isHeadingNote(kept('note', text, 1))]).toEqual([text, false]);
    }
    // Plans written alone or after "for" are never headings (review of 2026-11-10).
    for (const text of ['For theatre', 'For surgery', 'For emergency surgery', 'Emergency surgery', 'Surgery', 'ICU',
      'For ICU', 'HDU care', 'For admission', 'Observation', 'For observation', 'Intensive care', 'Investigations',
      'For investigations', 'Fluid input and output chart', 'Vital signs chart', 'Nursing care', 'For ENT',
      'Medical management', 'For surgical management', 'Plan of care', 'Theatre', 'Observation chart',
      'For drug chart']) {
      expect([text, isHeadingNote(kept('note', text, 1))]).toEqual([text, false]);
    }
    // Form labels and exact headings still are.
    for (const text of ['Accident & Emergency', 'Admission notes', 'Plan of management', 'Medication chart',
      'Continuation sheet', 'ICU notes', 'Surgical unit']) {
      expect([text, isHeadingNote(kept('note', text, 1))]).toEqual([text, true]);
    }
    // Never an item of another kind, whatever its words.
    for (const kind of ['medicine', 'diagnosis', 'lab_result', 'allergy', 'vital'] as const) {
      expect(isHeadingNote(kept(kind, 'Treatment sheet', 1))).toBe(false);
    }
  });

  it('drops the heading rows of the owner transcript fixture and keeps every other row as it was', () => {
    const readings = (pick: (row: (typeof CLEAN_READING_ROWS)[number]) => CleanReadingAnswer) =>
      modelPage(CLEAN_READING_ROWS.map((row, index) => answerItem(pick(row), index + 1)));
    const page = readPage(1, CLEAN_READING_ROWS.map((row, index) => [row.lineText,
      { handwritten: true, confidence: 0.4, box: lineBox(index + 1) }] as [string, Partial<ReadPage['lines'][number]>]));
    const merged = mergeHardReadings([held(readings((row) => row.readA), page),
      held(readings((row) => row.readB ?? row.readA), page)], SOURCE_SHA).check;
    const tidied = tidyPage(merged);
    const rowOf = (item: PaperItem) => Number(/-l(\d+)$/.exec(item.lineIds[0]!)![1]);
    const headingRows = CLEAN_READING_ROWS.flatMap((row, index) => row.name.startsWith('a heading') ? [index + 1] : []);
    expect(headingRows).toEqual([8, 9]);
    expect(tidied.items.map(rowOf)).toEqual(merged.items.map(rowOf).filter((row) => !headingRows.includes(row)));
    // Every other item exactly as before.
    expect(tidied.items).toEqual(merged.items.filter((item) => !headingRows.includes(rowOf(item))));
    expect(tidied.droppedByReason).toEqual({ ...merged.droppedByReason, heading: 2 });
    expect(tidied.droppedUngrounded).toBe(merged.droppedUngrounded);
  });
});

describe('a note repeating a medicine\'s order', () => {
  const stopped = kept('medicine', 'Dc Gentamicin', 1, { name: 'Gentamicin', status: 'stopped' });

  it('drops the note "DC? Gentamicin?" beside the stopped medicine, keeping the medicine', () => {
    const note = kept('note', 'DC? Gentamicin?', 1);
    expect(duplicatesOrder(note, stopped)).toBe(true);
    const tidied = tidyPage(pageOf([stopped, note]));
    expect(tidied.items).toEqual([stopped]);
    expect(tidied.items[0]!.fields).toMatchObject({ status: 'stopped' });
    expect(tidied.droppedByReason).toEqual({ duplicate_of_order: 1 });
    // The stop word in another spelling, the drug under its brand.
    expect(duplicatesOrder(kept('note', 'Stopped gentamicin', 1), stopped)).toBe(true);
    const flagyl = kept('medicine', 'Stop Metronidazole', 2, { name: 'Metronidazole', status: 'stopped' });
    expect(duplicatesOrder(kept('note', 'D/C Flagyl?', 2), flagyl)).toBe(true);
  });

  it('keeps the note wherever it is not fully covered by one medicine on its place', () => {
    // The medicine does not say stop: the note carries the stop.
    const active = kept('medicine', 'Gentamicin 80mg', 1, { name: 'Gentamicin', strength: '80mg', status: 'new' });
    expect(duplicatesOrder(kept('note', 'DC? Gentamicin?', 1), active)).toBe(false);
    // More than the order: another drug, a reason, a number.
    for (const text of ['DC Gentamicin, start Ceftriaxone', 'DC Gentamicin due to AKI', 'DC Gentamicin day 5',
      'Stop?', 'DC (? on paper) Gentamicin']) {
      expect([text, duplicatesOrder(kept('note', text, 1), stopped)]).toEqual([text, false]);
    }
    // A stop word in the medicine's writing is no stop: only its status stopped counts (review of 2026-11-10).
    for (const [writing, status] of [['Gentamicin 80mg bd (crossed out: stop)', 'current'],
      ['Gentamicin 80mg bd x5/7 then stop', 'current'], ['Gentamicin 80mg bd stop if rash', 'new'],
      ['Gentamicin 80mg bd? (or stop?)', 'unknown']] as const) {
      const medicine = kept('medicine', writing, 1, { name: 'Gentamicin', strength: '80mg', frequency: 'bd', status });
      expect([writing, duplicatesOrder(kept('note', 'Stop Gentamicin', 1), medicine)]).toEqual([writing, false]);
    }
    // A drug name alone, or a start, continue or hold word, is never taken as a repeat.
    for (const [text, status] of [['Gentamicin', 'new'], ['Gentamicin?', 'unknown'], ['Continue Gentamicin', 'current'],
      ['Give Gentamicin', 'new'], ['Gentamicin', 'stopped'], ['Hold Gentamicin', 'stopped'],
      ['Start Gentamicin', 'stopped']] as const) {
      const medicine = kept('medicine', 'Gentamicin 80mg bd', 1, { name: 'Gentamicin', strength: '80mg', status });
      expect([text, status, duplicatesOrder(kept('note', text, 1), medicine)]).toEqual([text, status, false]);
    }
    // Another drug.
    expect(duplicatesOrder(kept('note', 'DC Amikacin', 1), stopped)).toBe(false);
    // Another place: no shared line, boxes apart.
    expect(duplicatesOrder(kept('note', 'DC Gentamicin', 5), stopped)).toBe(false);
    // Kept by tidyPage too, with nothing counted.
    const page = pageOf([active, kept('note', 'DC? Gentamicin?', 1)]);
    expect(tidyPage(page)).toBe(page);
  });

  it('drops the duplicate from a hard page\'s reading, the medicine shown stopped or unknown', () => {
    const page = hand('Dc Gntmcn');
    const { check } = two(page, [order('Dc Gentamicin', { name: 'Gentamicin', status: 'stopped' })],
      [order('Dc Gentamicin', { name: 'Gentamicin', status: 'stopped' })]);
    const note = { ...check.items[0]!, kind: 'note', id: 'it-note', asWritten: 'DC? Gentamicin?', plain: 'DC? Gentamicin?',
      fields: { text: 'DC? Gentamicin?' } } as unknown as PaperItem;
    const tidied = tidyPage({ ...check, items: [...check.items, note] });
    expect(tidied.items).toEqual(check.items);
    expect(tidied.items[0]!.fields).toMatchObject({ status: 'stopped' });
    expect(tidied.droppedByReason.duplicate_of_order).toBe(1);
  });
});

describe('clinical notes are never dropped by the tidy step', () => {
  it('keeps the owner\'s chat rows "Transfer to the ward", "Admit?" and "Switch to IV Ceftriaxone 1g"', () => {
    const items = [kept('note', 'Transfer to the ward', 1), kept('note', 'Admit?', 2),
      kept('note', 'Switch to IV Ceftriaxone 1g', 3),
      kept('medicine', 'Switch to IV Ceftriaxone 1g', 4, { name: 'Ceftriaxone', strength: '1g', route: 'IV' })];
    const page = pageOf(items);
    expect(tidyPage(page).items).toEqual(items);
  });

  it('treats a first-pass note with no marks the same way', () => {
    expect(isHeadingNote(kept('note', 'Treatment Sheet', 1))).toBe(true);
    expect(isHeadingNote(kept('note', 'Transfer to the ward', 1))).toBe(false);
  });
});
