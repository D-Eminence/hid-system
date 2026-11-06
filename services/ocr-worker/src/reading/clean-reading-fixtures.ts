/**
 * Fictional fixture for the clean hard-page reading (owner decision of 2026-11-06, about 10:13 UTC, relayed by the
 * coordinator: "i want the output clean ... doctor no get time"). The owner compared our output with a chat reading
 * (Claude Opus in claude.ai) of the same fictional handwritten page, which gave rows like "IV Flagyl? 500mg? 8hrly?",
 * "Transfer to the ward" and "Switch to IV Ceftriaxone 1g". Every row here is invented: no patient, no real page.
 *
 * The owner's two chat transcripts of a fictional handwritten treatment sheet (relayed by the coordinator on
 * 2026-11-06, about 10:16 UTC) are the target STYLE, not ground truth (the owner has no typed ground truth): their
 * rows are below as model answers in our schema with the clean text we show for them (partial words "Am…" and
 * "Pl… (Plasil?)", field placeholders "[dose?]", "[freq?]", "[route?]", a struck-out drug before its replacement, free
 * text instructions, an ambiguous margin mark "IV? (or ✓?)", and fields read from context such as "8hrly?").
 * clean-reading.spec.ts runs every row through the hard-page path (prepare, checkPage, the two-reading merge, the
 * lists and grounding) and checks the plain reading shown and that the item goes to a person (check_carefully).
 *
 * Used only by *.spec.ts files.
 */
import type { BasisField, FieldBasis, ModelItem } from './prompt';
import { modelItem } from './test-fixtures';

/** What one reading (read A or read B) gave for a row: the answer item's fields and its hard-page extras. */
export interface CleanReadingAnswer {
  item: Partial<ModelItem>;
  dose?: string;
  doseUnit?: string;
  crossedOut?: string;
  basis?: Partial<Record<BasisField, FieldBasis>>;
}

export interface CleanReadingRow {
  /** A short name for the test title (no page text). */
  name: string;
  /** The scanned line text the text service gave for the row (fictional, garbled as hard handwriting is). */
  lineText: string;
  /** The first reading's answer; the second reading's (readB) where it differs, else the same. */
  readA: CleanReadingAnswer;
  readB?: CleanReadingAnswer;
  /** The plain reading the check screen shows as the item: the target clean style. */
  plain: string;
  /** Reason codes the item must carry (besides best_guess_from_picture and read_from_image, which every row has). */
  reasons?: readonly string[];
  /** Reason codes the item must not carry. */
  notReasons?: readonly string[];
  /** A medicine's status after the merge, where the row is about it. */
  status?: string;
}

const medicine = (asWritten: string, fields: Partial<ModelItem>): Partial<ModelItem> =>
  ({ kind: 'medicine', asWritten, status: 'new', ...fields });
const note = (asWritten: string, noteText = asWritten): Partial<ModelItem> => ({ kind: 'note', asWritten, noteText });

/**
 * The target style, row by row. Rows 1 to 3 are the coordinator's examples from the owner's chat reading; the others
 * cover the rules that come with them (disagreement, crossing-out, no letter shapes, a query on the paper, a
 * description from the model).
 */
export const CLEAN_READING_ROWS: readonly CleanReadingRow[] = [
  {
    name: 'a medicine with every uncertain word marked (chat row "IV Flagyl? 500mg? 8hrly?")',
    lineText: 'IV Flgl 5OOmg 8hly',
    readA: { item: medicine('IV Flagyl? 500mg? 8hrly?', { route: 'IV', name: 'Flagyl?', strength: '500mg?', frequency: '8hrly?' }),
      dose: '500?', doseUnit: 'mg' },
    plain: 'IV Flagyl? (metronidazole) 500mg? 8hrly?',
    notReasons: ['readings_disagree'],
  },
  {
    name: 'an instruction in words, as a note (chat row "Transfer to the ward")',
    lineText: 'Trnsfr to the wrd',
    readA: { item: note('Transfer to the ward'), basis: { other: 'letters' } },
    plain: 'Transfer to the ward',
  },
  {
    name: 'an order with its instruction words (chat row "Switch to IV Ceftriaxone 1g")',
    lineText: 'Swtch to IV Cftrxone 1g',
    readA: { item: medicine('Switch to IV Ceftriaxone 1g', { route: 'IV', name: 'Ceftriaxone', strength: '1g' }),
      dose: '1', doseUnit: 'g' },
    plain: 'Switch to IV Ceftriaxone 1g',
  },
  {
    name: 'two readings disagreeing on the drug and the dose, shown "A? (or B?)"',
    lineText: 'IV Cefrxm 750 bd',
    readA: { item: medicine('IV Cefuroxime? 750mg bd', { route: 'IV', name: 'Cefuroxime?', strength: '750mg', frequency: 'bd' }),
      dose: '750', doseUnit: 'mg' },
    readB: { item: medicine('IV Ceftriaxone? 1g bd', { route: 'IV', name: 'Ceftriaxone?', strength: '1g', frequency: 'bd' }),
      dose: '1', doseUnit: 'g' },
    plain: 'IV Cefuroxime? (or Ceftriaxone?) 750mg? (or 1g?) bd (twice a day)',
    reasons: ['readings_disagree'],
  },
  {
    name: 'a crossed-out dose shown on its own item',
    lineText: 'IV Flgyl 500mg 4OOmg 8hrly',
    readA: { item: medicine('IV Flagyl 500mg (crossed out: 400mg?) 8hrly', { route: 'IV', name: 'Flagyl', strength: '500mg',
      frequency: '8hrly' }), dose: '500', doseUnit: 'mg', crossedOut: '400mg?' },
    plain: 'IV Flagyl (metronidazole) 500mg (crossed out: 400mg?) 8hrly (every 8 hours)',
    reasons: ['crossed_out'],
  },
  {
    name: 'a word with no letter shapes, "[?]"',
    lineText: 'Review in ~~ days',
    readA: { item: note('Review in [?] days'), basis: { other: 'letters' } },
    plain: 'Review in [?] days',
  },
  {
    name: 'a question mark written on the paper, "(? on paper)"',
    lineText: '?Malria',
    readA: { item: { kind: 'diagnosis', asWritten: '(? on paper) Malaria', name: '(? on paper) Malaria', status: 'suspected' },
      basis: { name: 'letters' } },
    plain: '(? on paper) Malaria',
  },
  // The owner's transcripts (style only): transcript A row by row, with transcript B's reading as read B where it
  // read the line differently.
  {
    name: 'a heading, every word a guess (transcript A row 1)',
    lineText: 'Immdte Mngmnt',
    readA: { item: note('Immediate? Management?', 'Immediate Management'), basis: { other: 'letters' } },
    plain: 'Immediate? Management?',
    notReasons: ['readings_disagree'],
  },
  {
    name: 'a heading one reading was sure of (transcript A row 2, transcript B "TREATMENT SHEET")',
    lineText: 'Trtmnt Sheet',
    readA: { item: note('Treatment? Sheet?', 'Treatment Sheet'), basis: { other: 'letters' } },
    readB: { item: note('TREATMENT SHEET', 'Treatment Sheet'), basis: { other: 'letters' } },
    plain: 'Treatment? Sheet?',
    notReasons: ['readings_disagree'],
  },
  {
    name: 'a one-word instruction (transcript A row 3)',
    lineText: '- Admt',
    readA: { item: note('— Admit?', 'Admit'), basis: { other: 'letters' } },
    plain: '— Admit?',
  },
  {
    name: 'a fluid whose volume and rate are written but unreadable, as placeholders (transcript A row 4, B "IVF(?) [illegible] 8-hourly(?)")',
    lineText: 'IVF Nrml Saline ~~ ~~',
    readA: { item: medicine('IVF Normal? Saline? [dose?] [freq?]', { route: 'IVF', name: 'Normal? Saline?', frequency: '[freq?]' }),
      dose: '[dose?]' },
    readB: { item: medicine('IVF? [drug?] 8hrly?', { route: 'IVF?', name: '[drug?]', frequency: '8hrly?' }),
      basis: { frequency: 'context' } },
    plain: 'IVF? Normal? Saline? [dose?] [freq?] (or [drug?] 8hrly?)',
    reasons: ['readings_disagree', 'field_from_context', 'unsure_from_letters'],
  },
  {
    name: 'a drug name cut short, after a margin mark that may be "IV" or a tick (transcript A row 5, B "IV(?) Am…")',
    lineText: 'IV Am 500mg 8hly',
    readA: { item: medicine('IV? (or ✓?) Am… 500mg? 8hrly?', { route: 'IV?', name: 'Am…', frequency: '8hrly?' }),
      dose: '500?', doseUnit: 'mg', basis: { frequency: 'context' } },
    plain: 'IV? (or ✓?) Am… 500mg? 8hrly?',
    reasons: ['field_from_context', 'unsure_from_letters'],
  },
  {
    name: 'a struck-out drug before its replacement, with an unreadable dose (transcript A row 6)',
    lineText: 'IV Cftrxone Cefrxme 8hly',
    readA: { item: medicine('IV? (crossed out: Ceftriaxone?) Cefuroxime? [dose?] 8hrly?', { route: 'IV?', name: 'Cefuroxime?',
      frequency: '8hrly?' }), dose: '[dose?]', crossedOut: 'Ceftriaxone?', basis: { name: 'context', frequency: 'context' } },
    plain: 'IV? (crossed out: Ceftriaxone?) Cefuroxime? [dose?] 8hrly?',
    reasons: ['crossed_out', 'field_from_context'],
  },
  {
    name: 'a partial drug name with the model\'s whole-word guess in brackets, never expanded by the list (transcript B "Pl…/Ph… (Plasil?)")',
    lineText: 'IV Pl 10mg 8hly',
    readA: { item: medicine('IV? Pl… (or Ph…) (Plasil) 10mg? 8hrly?', { route: 'IV?', name: 'Pl… (Plasil)', frequency: '8hrly?' }),
      dose: '10?', doseUnit: 'mg', basis: { name: 'context', frequency: 'context' } },
    plain: 'IV? Pl… (or Ph…) (Plasil?) 10mg? 8hrly?',
    reasons: ['field_from_context'],
  },
  {
    name: 'an unreadable route and frequency around a readable drug (transcript A row 9, B "PO/SC(?)")',
    lineText: 'Omeprazle 40mg',
    readA: { item: medicine('[route?] Omeprazole? 40mg? [freq?]', { route: '[route?]', name: 'Omeprazole?', frequency: '[freq?]' }),
      dose: '40?', doseUnit: 'mg' },
    readB: { item: medicine('PO? Omeprazole? 40mg? [freq?]', { route: 'PO?', name: 'Omeprazole?', frequency: '[freq?]' }),
      dose: '40?', doseUnit: 'mg' },
    plain: 'PO? (or [route?]) Omeprazole? 40mg? [freq?]',
    reasons: ['readings_disagree', 'unsure_from_letters'],
  },
  {
    name: 'an instruction with no letter shapes in its first word (transcript A row 11)',
    lineText: '- ~~ other mgt',
    readA: { item: note('— [?] other mgt'), basis: { other: 'letters' } },
    plain: '— [?] other mgt',
  },
  {
    name: 'a switch written as free text, its status unknown (transcript A row 12, B "Switch(ed) to(?) IV Ceftriaxone(?) 1g")',
    lineText: 'Swtch to IV Ceftriaxone 1g',
    readA: { item: medicine('Switch? to IV Ceftriaxone 1g [freq?]', { route: 'IV', name: 'Ceftriaxone', strength: '1g',
      frequency: '[freq?]' }), dose: '1', doseUnit: 'g' },
    readB: { item: medicine('Switched to? IV Ceftriaxone? 1g [freq?]', { route: 'IV', name: 'Ceftriaxone?', strength: '1g',
      frequency: '[freq?]' }), dose: '1', doseUnit: 'g' },
    plain: 'Switch? (or Switched?) to? IV Ceftriaxone? 1g [freq?]',
    reasons: ['readings_disagree', 'status_cue_on_line'],
    status: 'unknown',
  },
  {
    name: 'a stop written "DC", or a signature (transcript A row 13)',
    lineText: 'DC Cefrxme',
    readA: { item: medicine('DC? (or Dr?) Cefuroxime?', { name: 'Cefuroxime?' }) },
    plain: 'DC? (or Dr?) Cefuroxime?',
    reasons: ['status_cue_on_line'],
    status: 'unknown',
  },
  {
    name: 'a description from the model, replaced by "[?]"',
    lineText: 'xx~~ ~~',
    readA: { item: medicine('Handwritten treatment entry that cannot be read; check the paper',
      { plain: 'Handwritten treatment entry that cannot be read; check the paper' }) },
    plain: '[?]',
    reasons: ['description_replaced'],
  },
];

/**
 * The line box of a row on the fixture page and an item box on it: rows 0.04 apart from 0.05 (row 1 is where
 * test-fixtures.ts readLine puts line 1), so the fixture's rows never share a height.
 */
const rowTop = (row: number) => Math.round(500 + 400 * (row - 1)) / 10000;
export const lineBox = (row: number) => ({ left: 0.1, top: rowTop(row), width: 0.5, height: 0.02 });
export const rowBox = (row: number) => ({ left: 0.12, top: rowTop(row), width: 0.3, height: 0.02 });

const LETTERS: Record<BasisField, FieldBasis> = { name: 'empty', dose: 'empty', unit: 'empty', route: 'empty',
  frequency: 'empty', duration: 'empty', value: 'empty', other: 'empty' };

/** A row's answer as the hard-page client hands it over: the item, its box on the row, and its extras. */
export function answerItem(answer: CleanReadingAnswer, row: number): ModelItem {
  const item = modelItem({ lineIds: [`p1-l${row}`], ...answer.item });
  const filled = (value: string | undefined) => (value ?? '').trim() !== '';
  const basis: Record<BasisField, FieldBasis> = { ...LETTERS,
    name: filled(item.name) || filled(item.test) ? 'letters' : 'empty', dose: filled(answer.dose) ? 'letters' : 'empty',
    unit: filled(answer.doseUnit) || filled(item.unit) ? 'letters' : 'empty', route: filled(item.route) ? 'letters' : 'empty',
    frequency: filled(item.frequency) ? 'letters' : 'empty', duration: filled(item.duration) ? 'letters' : 'empty',
    value: filled(item.value) ? 'letters' : 'empty', ...answer.basis };
  return { ...item, box: rowBox(row), hard: { dose: answer.dose ?? '', doseUnit: answer.doseUnit ?? '',
    crossedOut: answer.crossedOut ?? '', basis } };
}
