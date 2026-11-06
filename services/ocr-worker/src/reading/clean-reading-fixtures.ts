/**
 * Fictional fixture for the clean hard-page reading (owner decision of 2026-11-06, about 10:13 UTC, relayed by the
 * coordinator: "i want the output clean ... doctor no get time"). The owner compared our output with a chat reading
 * (Claude Opus in claude.ai) of the same fictional handwritten page, which gave rows like "IV Flagyl? 500mg? 8hrly?",
 * "Transfer to the ward" and "Switch to IV Ceftriaxone 1g". Every row here is invented: no patient, no real page.
 *
 * AWAITING: the coordinator will send the owner's two full chat transcripts. Add each of their rows to
 * CLEAN_READING_ROWS (one row per line of the chat reading, with the model answers that should produce it);
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
    plain: 'IV Flagyl (metronidazole) 500mg 8hrly (every 8 hours) (crossed out: 400mg?)',
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
  {
    name: 'a description from the model, replaced by "[?]"',
    lineText: 'xx~~ ~~',
    readA: { item: medicine('Handwritten treatment entry that cannot be read; check the paper',
      { plain: 'Handwritten treatment entry that cannot be read; check the paper' }) },
    plain: '[?]',
    reasons: ['description_replaced'],
  },
];

/** The line box of the row on the fixture page (test-fixtures.ts readLine) and an item box on it. */
export const rowBox = (row: number) => ({ left: 0.12, top: Math.round(5 * row) / 100, width: 0.3, height: 0.02 });

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
