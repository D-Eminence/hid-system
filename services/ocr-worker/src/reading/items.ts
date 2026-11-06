import { createHash } from 'node:crypto';
import type { Box, FlagReason, ItemKind, PaperIdentity, PaperItem, VITAL_MEASURES } from './contract';
import {
  ambiguousDate, combinedStrengths, compact, DOSE, forMatching, FREQUENCY, has, norm, numbersIn, partlyCovered, pattern, routes,
  sameCombined, segment, STATUS_CUES, suspiciousUncited, together, unitAfter, withoutNumberedUnit, withoutReadingMarks,
  wordsIn,
} from './grounding';
import { withoutPlaceholders, type Masker } from './masking';
import type { ModelItem, ModelPage } from './prompt';
import type { ReadLine } from '../types';

/** OCR confidence below this goes to a person (0.80, as in the design draft's REVIEW_BELOW 80). */
export const REVIEW_BELOW = 0.8;
const ACTIVE_STATUSES = new Set(['confirmed', 'current', 'new']);

/** One plain sentence for the check screen, chosen from the item's reasons in this order. */
const REASON_SENTENCES: ReadonlyArray<readonly [readonly string[], string]> = [
  [['strength_mismatch', 'strength_not_as_written'], "A dose on the paper doesn't match what was read."],
  [['nkda_not_on_paper', 'nkda_conflicts'], "The paper doesn't clearly say there are no known allergies."],
  [['value_mismatch', 'reading_number_mismatch', 'plain_mismatch'], "A number on the paper doesn't match what was read."],
  [['number_not_in_text_read'], "A number read from the picture isn't in the text read from the page; check it against the paper."],
  // A hard page read twice from its picture: the two readings disagreed on part of this item (that part is shown
  // as "A? (or B?)", hard-page prompt 5/6).
  [['readings_disagree'], 'Two readings of the picture disagree on part of this; check it against the paper.'],
  // A hard-page item with writing crossed out on the paper, shown "(crossed out: X)" on the item.
  [['crossed_out'], 'Part of this is crossed out on the paper; check it against the paper.'],
  // The model described the writing instead of reading it; the description was replaced by "[?]".
  [['description_replaced'], 'This writing could not be read at all, shown "[?]"; check it against the paper.'],
  // After the dose and number disagreements, before the text-match ones (an item read from the picture is
  // expected to differ from the text the service read).
  // A hard page's best guesses (owner decision 2026-11-05 about 18:40 UTC): below the real disagreements above, and
  // before read_from_image, which every such item also has, so they are said instead of it. Most specific first.
  [['field_from_context'], 'Part of this was guessed from what is usual, not read from the writing; check it against the paper.'],
  // Found by only one of the two readings: said before a sign, so the person checking is told the item itself may
  // not be on the paper.
  // A handwritten sign read as its meaning ("alternate (sign)") or not read ("[sign?]"): an interpretation of a mark,
  // below a guess from what is usual and one reading only, above the plainer hard-page sentences.
  [['single_reading_only'], 'Only one of two readings of the picture found this; check it against the paper.'],
  [['sign_read'], 'A handwritten sign was read as a word, marked "(sign)", or could not be read, marked "[sign?]"; check it against the paper.'],
  [['best_guess_from_picture'], 'This is a best guess from the picture; check every word against the paper.'],
  // Just before read_from_image (which every picture item has), so it is shown where it applies.
  [['not_matched_to_scanned_text'], 'Read from the picture; it could not be matched to the scanned text. Check it against the paper.'],
  [['read_from_image'], 'This was read from the picture of the page; check it against the paper.'],
  [['measure_mismatch'], "What was measured doesn't match the label on the paper."],
  [['plain_contradicts'], "The plain reading says something the paper doesn't."],
  [['frequency_mismatch', 'duration_mismatch'], "How often or how long doesn't match the paper."],
  [['strength_missing', 'frequency_missing'], "The paper gives a dose or how often that wasn't read."],
  [['route_missing'], "The paper says how it is given, but that wasn't read."],
  [['route_mismatch'], "How it is given doesn't match the paper."],
  [['unit_mismatch'], "The unit read isn't the one on the paper."],
  [['lines_not_together'], 'This was put together from separate parts of the page.'],
  [['status_not_active', 'status_unclear'], 'This may not be current (for example past, stopped or suspected).'],
  [['status_cue_on_line'], 'The paper has words that may change whether this is current.'],
  [['status_not_written'], "The paper doesn't say whether this is current."],
  [['date_ambiguous'], 'The date could be read two ways (day/month or month/day).'],
  [['duplicate_source_span'], 'Another item was read from the same words; check nothing was missed.'],
  // Below the disagreements and status warnings: a second reading that read the same words differently, then a
  // first-pass item the second reading (from the picture, or from the text) did not find.
  [['differs_from_second_reading'], 'The second reading differs from this one; compare both with the paper.'],
  [['not_in_picture_reading'], 'The second reading, from the picture, did not find this; check it against the paper.'],
  [['not_in_second_reading'], 'The second reading did not find this; check it against the paper.'],
  // Hard-to-read handwriting explains the reasons below it (something read that is not found in the text
  // read), so it is said before them only; every disagreement or warning above is said first.
  [['low_ocr_confidence_handwritten'], 'The handwriting was hard to read.'],
  [['route_not_on_paper'], "The route read (for example IV or by mouth) isn't on the paper."],
  [['text_corrected'], 'The words were read differently from how they look on the paper.'],
  [['date_not_on_page', 'prescription_detail_not_on_page'], "A date or name that was read isn't on the paper."],
  [['field_not_on_paper'], "Part of what was read isn't on the paper."],
  [['low_ocr_confidence'], 'Part of this was hard to read.'],
  [['name_missing', 'substance_missing', 'measure_unclear'], "Part of this item couldn't be read."],
  [['handwritten'], 'This is handwritten; check it against the paper.'],
  [['ai_unsure'], "The reader wasn't sure about this one."],
  [['reread_failed'], "A second reading of this page didn't work; check it against the paper."],
];

export function checkReasonSentence(codes: readonly string[]): string | null {
  if (codes.length === 0) return null;
  for (const [group, sentence] of REASON_SENTENCES) {
    if (codes.some((code) => group.includes(code))) return sentence;
  }
  return 'Check this against the paper.';
}

export function itemId(sourceSha256Hex: string, kind: ItemKind, lineIds: readonly string[], asWritten: string): string {
  return `it-${createHash('sha256').update(sourceSha256Hex + kind + lineIds.join(',') + asWritten).digest('hex').slice(0, 16)}`;
}

export function unionBox(boxes: readonly (Box | null)[]): Box | null {
  const present = boxes.filter((box): box is Box => box !== null);
  if (present.length === 0) return null;
  const left = Math.min(...present.map((box) => box.left));
  const top = Math.min(...present.map((box) => box.top));
  const right = Math.max(...present.map((box) => box.left + box.width));
  const bottom = Math.max(...present.map((box) => box.top + box.height));
  return { left: round4(left), top: round4(top), width: round4(Math.min(1, right) - left),
    height: round4(Math.min(1, bottom) - top) };
}

export function round4(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 10_000) / 10_000));
}

export interface PageCheckInput {
  page: number;
  /** The page's lines exactly as the model saw them (masked text, original ids and boxes). */
  lines: readonly ReadLine[];
  answer: ModelPage;
  sourceSha256Hex: string;
  readBy: 'first_pass' | 'reread';
  masker: Masker;
  /**
   * The answer was read from the picture of the page (image re-read). Its items are held to the page by place
   * (each cited line under the item's box, little of the box on lines it does not cite) and by a text anchor (a
   * word or number shared with its cited lines), not by an exact text match; see imagePlace.
   */
  fromImage?: boolean;
}

/**
 * An image-read item sits on a cited line when, on that line, it covers at least this share of the line's height
 * and of the narrower of the two widths.
 */
export const IMAGE_PLACE_OVERLAP = 0.5;
/** At most this share of the line area an image-read item's box covers may be on lines it does not cite. */
export const IMAGE_UNCITED_SHARE = 0.5;
/** The smallest image-read item box, as a share of the page's width and of its height. */
export const IMAGE_MIN_BOX = 0.005;
/** The most lines one image-read item may cite (a medicine or a result runs over a few lines, never the page). */
export const IMAGE_MAX_CITED_LINES = 3;
/** An image-read item's box may be at most this many times the area of the box around its cited lines. */
export const IMAGE_MAX_AREA_RATIO = 2;
/**
 * A small absolute allowance, as a share of the page's area, on top of IMAGE_MAX_AREA_RATIO x the area of the box
 * around the cited lines, so a box a little larger than a short, thin line is not dropped for that alone.
 */
export const IMAGE_AREA_ALLOWANCE = 0.002;
/**
 * How far an image-read item's box may run past the left and right edges of the box around its cited lines, in
 * total, as a share of that box's width.
 */
export const IMAGE_MAX_SIDE_OVERFLOW = 0.25;
/**
 * Floors for short items, so a few pixels of padding around a short word are never a reason to drop it: the box may
 * run past its lines' left edge and right edge by IMAGE_MIN_SIDE_OVERFLOW of the page width each (so 0.02 in all)
 * even where a quarter of their width is less, and its area may always be that of its lines' box padded by
 * IMAGE_MIN_PADDING of the page on every side.
 */
export const IMAGE_MIN_SIDE_OVERFLOW = 0.01;
export const IMAGE_MIN_PADDING = 0.005;

/** A model box clipped to the page ([0, 1] on both axes); null where nothing of it is on the page. */
export function clipBox(box: { left: number; top: number; width: number; height: number }): Box | null {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const left = clamp(box.left);
  const top = clamp(box.top);
  const right = clamp(box.left + box.width);
  const bottom = clamp(box.top + box.height);
  if (!(right > left) || !(bottom > top)) return null;
  return { left: round4(left), top: round4(top), width: round4(right - left), height: round4(bottom - top) };
}

const span = (aStart: number, aSize: number, bStart: number, bSize: number) =>
  Math.max(0, Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart));
const area = (box: Box) => box.width * box.height;
const intersection = (a: Box, b: Box) => span(a.left, a.width, b.left, b.width) * span(a.top, a.height, b.top, b.height);

/** Whether the item's box lies on this line: over half the line's height, and over half the narrower width. */
function onLine(box: Box, line: Box): boolean {
  return span(box.top, box.height, line.top, line.height) >= IMAGE_PLACE_OVERLAP * line.height
    && span(box.left, box.width, line.left, line.width) >= IMAGE_PLACE_OVERLAP * Math.min(box.width, line.width);
}

/**
 * Whether the item read from the picture shares anything with the text read of its lines: a word of three letters
 * or more, or a number. It need not match the text (the service may have misread it), but an item with nothing in
 * common with its lines (a box copied from the prompt around a made-up item) is not kept. The hard-page sign marks
 * ("(sign)", "[sign?]") and the other reading marks ("(? on paper)", "[?]", the "crossed out" label) are not words
 * of the item (withoutReadingMarks).
 */
function anchored(asWritten: string, source: string): boolean {
  const text = withoutPlaceholders(source);
  const words = new Set(wordsIn(text).filter((word) => word.length >= 3));
  const numbers = new Set(numbersIn(text));
  const own = withoutReadingMarks(withoutPlaceholders(asWritten));
  return wordsIn(own).some((word) => words.has(word)) || numbersIn(own).some((number) => numbers.has(number));
}

/** Two lines on one written row: they overlap vertically by at least half the smaller line's height. */
function sameRow(a: Box, b: Box): boolean {
  return span(a.top, a.height, b.top, b.height) >= 0.5 * Math.min(a.height, b.height);
}

/** A written row may be at most this many times as tall as its tallest line. */
export const IMAGE_ROW_MAX_HEIGHT = 1.5;
/**
 * After same-row fragments are added, an image-read item may have at most this many lines on any one written row,
 * and at most IMAGE_MAX_LINES_PER_ITEM lines in all (the lines it cites and those added); more drops the item, so
 * a box cannot claim a whole row or block of cells, whether the model cited them or not.
 */
export const IMAGE_MAX_LINES_PER_ROW = 4;
export const IMAGE_MAX_LINES_PER_ITEM = 6;

/**
 * Lines grouped into written rows, in reading order. A line joins a row only when it is on one row (sameRow) with
 * every line already in it, never by a chain of neighbours (a slant), and the row stays at most
 * IMAGE_ROW_MAX_HEIGHT times as tall as its tallest line; otherwise it starts a row of its own.
 */
function rowsOf(lines: readonly ReadLine[]): ReadLine[][] {
  const rows: ReadLine[][] = [];
  for (const line of lines) {
    const fits = (row: ReadLine[]) => {
      if (line.box === null || row.some((other) => other.box === null || !sameRow(other.box, line.box!))) return false;
      const boxes = [...row, line].map((member) => member.box!);
      const top = Math.min(...boxes.map((box) => box.top));
      const bottom = Math.max(...boxes.map((box) => box.top + box.height));
      return bottom - top <= IMAGE_ROW_MAX_HEIGHT * Math.max(...boxes.map((box) => box.height)) + 1e-9;
    };
    const row = rows.find(fits);
    if (row) row.push(line);
    else rows.push([line]);
  }
  return rows;
}

/**
 * Whether rows of cited lines lie together (the lines_not_together test, applied to rows): each row stands for one
 * line with the box around it, and two rows are next in reading order when no line outside the cited rows comes
 * between them.
 */
function rowsTogether(rows: readonly ReadLine[][], all: readonly ReadLine[], order: ReadonlyMap<string, number>): boolean {
  if (rows.length <= 1) return true;
  const rowOf = new Map<string, number>();
  rows.forEach((row, index) => { for (const line of row) rowOf.set(line.id, index); });
  const sequence: string[] = [];
  for (const line of [...all].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))) {
    const key = rowOf.has(line.id) ? `r${rowOf.get(line.id)}` : `u${line.id}`;
    if (sequence[sequence.length - 1] !== key) sequence.push(key);
  }
  const rank = new Map<string, number>();
  rows.forEach((row, index) => rank.set(row[0]!.id, sequence.indexOf(`r${index}`)));
  const placed = rows.map((row) => ({ id: row[0]!.id, box: unionBox(row.map((line) => line.box)) }));
  return together(placed, rank);
}

/** A picture item held to its lines: its stored box, its cited lines (with row fragments added), and whether its
 * asWritten could be matched to the scanned text of those lines. */
interface ImagePlace { box: Box; cited: ReadLine[]; matched: boolean }

/**
 * Why an item was dropped (codes only, never text; counted per code in PageCheck.droppedByReason):
 * - no_line_cited: the item cites no line;
 * - line_not_on_page: it cites a line id that is not on this page;
 * - empty_as_written: its asWritten is empty;
 * - text_not_on_line: (text reading) its asWritten is not in the cited lines' text;
 * and, for an item read from the picture (imagePlace):
 * - no_box: it has no box;
 * - box_too_small: its box, clipped to the page, is empty or under IMAGE_MIN_BOX on a side;
 * - too_many_lines: more than IMAGE_MAX_LINES_PER_ITEM lines, cited and added;
 * - too_many_lines_on_row: more than IMAGE_MAX_LINES_PER_ROW lines on one written row;
 * - too_many_rows: more than IMAGE_MAX_CITED_LINES written rows;
 * - rows_not_together: its rows are not one row or one wrapped block (the lines_not_together test on rows);
 * - cited_lines_no_box: none of its cited lines has a box to hold it to;
 * - not_on_cited_line: its box does not lie on every cited line;
 * - area_too_large: its box is too large for its lines;
 * - side_overflow: its box runs too far past its lines' left and right edges;
 * - covers_uncited_line: its box lies on a line it does not cite;
 * - uncited_share: too much of the line area under its box is on lines it does not cite;
 * - not_anchored: it shares no word or number with legible cited lines.
 */
export const DROP_REASONS = ['no_line_cited', 'line_not_on_page', 'empty_as_written', 'text_not_on_line', 'no_box',
  'box_too_small', 'too_many_lines', 'too_many_lines_on_row', 'too_many_rows', 'rows_not_together',
  'cited_lines_no_box', 'not_on_cited_line', 'area_too_large', 'side_overflow', 'covers_uncited_line',
  'uncited_share', 'not_anchored'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/**
 * Where an image-read item sits, or null where it is not held to its lines (it is then dropped).
 *
 * Row fragments first: an uncited hard line (below REVIEW_BELOW) the item's box lies on (onLine) that is on the
 * same written row as a cited line is a fragment of the same writing that the text service split off, and is
 * added to the cited lines in reading order. Then, cited and added together, at most IMAGE_MAX_LINES_PER_ROW lines
 * on any one row and IMAGE_MAX_LINES_PER_ITEM in all, or the item is dropped (a box claiming a whole row of
 * cells). Rows are cliques (rowsOf), never chains. Then: at most IMAGE_MAX_CITED_LINES rows (groups of cited lines on one row) that lie together (the
 * lines_not_together test on rows, here a reason to drop); the box at least IMAGE_MIN_BOX on each side; its area at
 * most IMAGE_MAX_AREA_RATIO times the area of the box around its cited lines plus IMAGE_AREA_ALLOWANCE of the page
 * (or, if larger, that box padded by IMAGE_MIN_PADDING on every side); running past that box's left and right
 * edges by at most IMAGE_MAX_SIDE_OVERFLOW of its width in total (or by at most IMAGE_MIN_SIDE_OVERFLOW of the page
 * width on each side); on every cited line that has a box (each measured on its own, not as one box around them
 * all); on no line it does not cite (so not on another row's line), with at most IMAGE_UNCITED_SHARE of the line
 * area it covers on lines it does not cite. A box around the whole page that cites every line fails these.
 *
 * Text anchor: where any cited line is legible (confidence at least REVIEW_BELOW), the item's asWritten must share
 * a word or number with the cited lines' text, so a box copied from a clean line around a made-up item is dropped.
 * Where every cited line is below REVIEW_BELOW the scanned text may be nonsense, so the anchor is not required:
 * `matched` is then false when it fails, and the item gets not_matched_to_scanned_text.
 */
function imagePlace(raw: ModelItem, citedAsGiven: readonly ReadLine[], all: readonly ReadLine[],
  order: ReadonlyMap<string, number>): ImagePlace | { drop: DropReason } {
  if (!raw.box) return { drop: 'no_box' };
  const box = clipBox(raw.box);
  if (box === null || box.width < IMAGE_MIN_BOX || box.height < IMAGE_MIN_BOX || !(area(box) > 0)) {
    return { drop: 'box_too_small' };
  }
  const givenIds = new Set(citedAsGiven.map((line) => line.id));
  // Only a hard line (below REVIEW_BELOW) is taken for a fragment: a legible line on the row is its own writing,
  // and a box over it still drops the item below.
  const fragments = all.filter((line) => !givenIds.has(line.id) && line.confidence < REVIEW_BELOW
    && line.box !== null && onLine(box, line.box)
    && citedAsGiven.some((other) => other.box !== null && sameRow(other.box, line.box!)));
  const cited = [...citedAsGiven, ...fragments].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const rows = rowsOf(cited);
  if (cited.length > IMAGE_MAX_LINES_PER_ITEM) return { drop: 'too_many_lines' };
  if (rows.some((row) => row.length > IMAGE_MAX_LINES_PER_ROW)) return { drop: 'too_many_lines_on_row' };
  if (rows.length > IMAGE_MAX_CITED_LINES) return { drop: 'too_many_rows' };
  if (!rowsTogether(rows, all, order)) return { drop: 'rows_not_together' };
  const citedBoxes = cited.map((line) => line.box).filter((line): line is Box => line !== null);
  if (citedBoxes.length === 0) return { drop: 'cited_lines_no_box' };
  if (!citedBoxes.every((line) => onLine(box, line))) return { drop: 'not_on_cited_line' };
  const around = unionBox(citedBoxes)!;
  const padded = (around.width + 2 * IMAGE_MIN_PADDING) * (around.height + 2 * IMAGE_MIN_PADDING);
  if (area(box) > Math.max(IMAGE_MAX_AREA_RATIO * area(around) + IMAGE_AREA_ALLOWANCE, padded) + 1e-9) {
    return { drop: 'area_too_large' };
  }
  const leftOver = Math.max(0, around.left - box.left);
  const rightOver = Math.max(0, box.left + box.width - (around.left + around.width));
  const withinQuarter = leftOver + rightOver <= IMAGE_MAX_SIDE_OVERFLOW * around.width + 1e-9;
  const withinFloor = leftOver <= IMAGE_MIN_SIDE_OVERFLOW + 1e-9 && rightOver <= IMAGE_MIN_SIDE_OVERFLOW + 1e-9;
  if (!withinQuarter && !withinFloor) return { drop: 'side_overflow' };
  const citedIds = new Set(cited.map((line) => line.id));
  // A box that also lies on a line it does not cite (by the same test as for its cited lines) is not this item's.
  if (all.some((line) => !citedIds.has(line.id) && line.box !== null && onLine(box, line.box))) {
    return { drop: 'covers_uncited_line' };
  }
  const coveredBy = (lines: readonly ReadLine[]) => lines.reduce((sum, line) => sum + (line.box ? intersection(box, line.box) : 0), 0);
  const onCited = coveredBy(cited);
  const onUncited = coveredBy(all.filter((line) => !citedIds.has(line.id)));
  if (onUncited > IMAGE_UNCITED_SHARE * (onCited + onUncited)) return { drop: 'uncited_share' };
  const matched = anchored(raw.asWritten, cited.map((line) => line.text).join(' '));
  const trustworthy = cited.some((line) => line.confidence >= REVIEW_BELOW);
  if (!matched && trustworthy) return { drop: 'not_anchored' };
  return { box, cited, matched };
}

export interface PageCheck {
  items: PaperItem[];
  droppedUngrounded: number;
  /** The same drops by reason code (DROP_REASONS); the counts sum to droppedUngrounded. Codes only, never text. */
  droppedByReason: Record<string, number>;
  identity: PaperIdentity;
  pageUnsure: boolean;
  /**
   * Why the first pass looks shaky, by code. The reader no longer routes on these (owner decision 2026-11-05: a
   * page is re-read when it is flagged, i.e. flagReasons is not empty, which covers every one of them).
   */
  rereadReasons: string[];
  flagReasons: FlagReason[];
  /**
   * For each kept item (same order as items), the index of the answer item it was read from. Set by checkPage;
   * the hard-page merge uses it to find each kept item's dose, unit and basis. Never stored.
   */
  rawIndexes?: number[];
}

const blankIdentity = (): PaperIdentity => ({ nameAsWritten: null, dateOfBirthAsWritten: null,
  folderNumberAsWritten: null, sexAsWritten: null, lineIds: [], box: null });

function value(text: string, masker: Masker): string | null {
  const trimmed = text.trim();
  return trimmed ? masker.restore(trimmed) : null;
}

/**
 * Hold one page's answer to the page. An item that cites no line, a line not on this page, or whose
 * asWritten is not in the cited lines is dropped and only counted. Every kept item gets its check reasons.
 */
export function checkPage(input: PageCheckInput): PageCheck {
  const byId = new Map(input.lines.map((line) => [line.id, line]));
  const order = new Map(input.lines.map((line, index) => [line.id, index]));
  const pageText = input.lines.map((line) => line.text).join('\n');
  const medicineNames = input.answer.items.filter((item) => item.kind === 'medicine' && norm(item.name))
    .map((item) => forMatching(item.name));
  const allergySubstances = input.answer.items
    .filter((item) => item.kind === 'allergy' && !item.noKnownAllergies && norm(item.substance))
    .map((item) => forMatching(item.substance));
  const items: PaperItem[] = [];
  /** Kept items by base id: the same kind, cited lines and asWritten. */
  const seen = new Map<string, PaperItem[]>();
  let duplicateSpan = false;
  let dropped = 0;
  const droppedByReason: Record<string, number> = {};
  const drop = (reason: DropReason) => { dropped += 1; droppedByReason[reason] = (droppedByReason[reason] ?? 0) + 1; };
  const rawIndexes: number[] = [];
  for (const [rawIndex, raw] of input.answer.items.entries()) {
    const lineIds = [...new Set(raw.lineIds)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const cited = lineIds.map((id) => byId.get(id));
    const source = cited.map((line) => line?.text ?? '').join(' ');
    const textDrop: DropReason | null = lineIds.length === 0 ? 'no_line_cited'
      : cited.some((line) => line === undefined) ? 'line_not_on_page'
        : !norm(raw.asWritten) ? 'empty_as_written'
          : !input.fromImage && !has(source, raw.asWritten) ? 'text_not_on_line' : null;
    if (textDrop !== null) {
      drop(textDrop);
      continue;
    }
    let lines = cited as ReadLine[];
    let itemLineIds = lineIds;
    let itemSource = source;
    // Read from the picture: held to the page by place. Dropped items are only counted, as above.
    const placed = input.fromImage ? imagePlace(raw, lines, input.lines, order) : null;
    if (placed !== null && 'drop' in placed) {
      drop(placed.drop);
      continue;
    }
    const place = placed;
    if (place !== null) {
      // Row fragments the item's box covers are cited with it.
      lines = place.cited;
      itemLineIds = lines.map((line) => line.id);
      itemSource = lines.map((line) => line.text).join(' ');
    }
    // An item read from the picture is meant to differ from the text the service read, so its fields are held
    // to what the model read in the picture (its asWritten), not to the line text: a dose or word the service
    // misread is not "on the paper doesn't match". How legible the lines were still counts, and a number the
    // line text doesn't have is flagged in markReadFromImage.
    const item = place === null
      ? checkItem(raw, lines, itemLineIds, itemSource, pageText, order, medicineNames, allergySubstances, input)
      : checkItem(raw, lines.map((line, index) => ({ ...line, text: index === 0 ? forMatching(raw.asWritten) : '' })),
        itemLineIds, forMatching(raw.asWritten), `${pageText}\n${forMatching(raw.asWritten)}`, order, medicineNames,
        allergySubstances, input);
    if (place !== null) markReadFromImage(item, raw, itemSource, place.box, place.matched);
    const group = seen.get(item.id) ?? [];
    // An exact repeat (same kind, lines, asWritten and fields) collapses to one.
    if (group.some((kept) => JSON.stringify(kept.fields) === JSON.stringify(item.fields))) continue;
    if (group.length > 0) {
      // A different item read from the same words is kept under its own suffixed id, and both go to a person.
      duplicateSpan = true;
      for (const other of [...group, item]) markDuplicateSpan(other);
    }
    group.push(item);
    seen.set(item.id, group);
    items.push(item);
    rawIndexes.push(rawIndex);
  }
  const identity = checkIdentity(input.answer.identity, byId, pageText, input.masker);
  const cited = new Set([...items.flatMap((item) => item.lineIds), ...identity.lineIds]);
  const citedLines = input.lines.filter((line) => cited.has(line.id));
  const lowHandwritten = citedLines.some((line) => line.handwritten && line.confidence < REVIEW_BELOW);
  // The page's flags look at every line, as with AI off: an illegible line no item cites is where a
  // missed item is most likely. The cited-only view above decides only the re-read.
  const anyLowHandwritten = input.lines.some((line) => line.handwritten && line.confidence < REVIEW_BELOW);
  const anyLowPrinted = input.lines.some((line) => !line.handwritten && line.confidence < REVIEW_BELOW);
  // Handwriting alone makes an item check_carefully, but it is not a sign the first pass was shaky; nor is
  // having been read from the picture (every such item is).
  const shaky = items.filter((item) => item.checkReasons.some((code) => code !== 'handwritten'
    && code !== 'read_from_image'));
  const shakyShare = items.length === 0 ? 0 : shaky.length / items.length;
  const rereadReasons = [
    ...(input.answer.pageUnsure ? ['page_unsure'] : []),
    ...(dropped > 0 ? ['dropped_ungrounded'] : []),
    ...(lowHandwritten ? ['low_confidence_handwriting'] : []),
    ...(shakyShare >= 0.3 ? ['many_check_carefully'] : []),
  ];
  // An item read from the picture is not in the line text by design, so it cannot show what a line leaves over:
  // such a page is checked for missed items by its uncited lines only.
  const missed = duplicateSpan || suspiciousUncited(input.lines, cited).length > 0
    || partlyCovered(input.lines, input.fromImage ? [] : items).length > 0;
  const flagReasons: FlagReason[] = [
    ...(anyLowPrinted || shakyShare >= 0.3 ? ['low_confidence' as const] : []),
    ...(anyLowHandwritten ? ['handwriting' as const] : []),
    ...(dropped > 0 ? ['many_dropped' as const] : []),
    ...(input.answer.pageUnsure ? ['ai_unsure' as const] : []),
    ...(missed ? ['possible_missed_item' as const] : []),
  ];
  // Stored text is the original: placeholders the model copied go back to the numbers on the paper.
  for (const item of items) item.asWritten = input.masker.restore(item.asWritten);
  return { items: uniqueItemIds(items), droppedUngrounded: dropped, droppedByReason, identity,
    pageUnsure: input.answer.pageUnsure,
    rereadReasons, flagReasons, rawIndexes };
}

/**
 * An item read from the picture always goes to a person: 'read_from_image', check_carefully, the stored box its
 * own place on the page, and 'number_not_in_text_read' where it has a number the text read of its lines doesn't.
 */
function markReadFromImage(item: PaperItem, raw: ModelItem, source: string, place: Box, matched: boolean): void {
  const textNumbers = new Set(numbersIn(withoutPlaceholders(source)));
  const written = [raw.asWritten, raw.strength, raw.frequency, raw.duration, raw.value, raw.referenceRange,
    raw.dateAsWritten, raw.prescriptionDate, raw.noteText];
  if (written.some((text) => numbersIn(withoutPlaceholders(text)).some((number) => !textNumbers.has(number)))) {
    if (!item.checkReasons.includes('number_not_in_text_read')) item.checkReasons.push('number_not_in_text_read');
  }
  // Kept on scanned text too poor to hold it to (see imagePlace): say so.
  if (!matched && !item.checkReasons.includes('not_matched_to_scanned_text')) {
    item.checkReasons.push('not_matched_to_scanned_text');
  }
  if (!item.checkReasons.includes('read_from_image')) item.checkReasons.push('read_from_image');
  item.checkReasons = item.checkReasons.filter((code) => code !== 'no_position');
  item.box = place;
  item.confidence = 'check_carefully';
  item.checkReason = checkReasonSentence(item.checkReasons);
}

/**
 * A page's result after a re-read (from the picture or from the text) of a page whose first pass gave an answer,
 * when the re-read kept at least one item. Fail-safe: a first-pass item is removed only when a kept second-reading
 * item of the same kind on a shared cited line carries everything it says: its exact twin (every field the same,
 * normalised), or else a superset (every field the first pass filled in the same, normalised, and only fields the
 * first pass left empty added). Each second-reading item removes at most one first-pass item (one to one: exact
 * twins first, then supersets, each in reading order). Every other first-pass item is kept as check_carefully with
 * 'not_in_picture_reading' (image) or 'not_in_second_reading' (text); where it has a best match among the
 * second-reading items (bestMatch: same kind, shared line, the same name, substance, test or measure, or for a note
 * the most shared words), that one pair gets 'differs_from_second_reading' so the person checking compares them.
 * Items are in reading order (page, first cited line; second-reading items first on the same line) and their ids
 * are made unique again. Identity is merged field by field (mergeIdentity); a field the two readings give
 * differently keeps the first pass's value and flags the page ai_unsure. possible_missed_item is worked out again
 * from the lines every kept item and the identity cite (and any duplicate_source_span within a reading;
 * differs_from_second_reading does not set it). droppedUngrounded stays the second reading's dropped count.
 */
export function mergeReread(first: PageCheck, second: PageCheck, lines: readonly ReadLine[],
  from: 'image' | 'text'): PageCheck {
  const firstLine = (item: PaperItem) => Math.min(...item.lineIds.map(lineNumber));
  const inReadingOrder = (items: readonly PaperItem[]) => items.map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.page - b.item.page || firstLine(a.item) - firstLine(b.item) || a.index - b.index)
    .map(({ item }) => item);
  const copy = (item: PaperItem): PaperItem => ({ ...item, checkReasons: [...item.checkReasons] } as PaperItem);
  const read = inReadingOrder(second.items).map(copy);
  const earlier = inReadingOrder(first.items).map(copy);
  const sharesLine = (a: PaperItem, b: PaperItem) => a.kind === b.kind && a.lineIds.some((id) => b.lineIds.includes(id));
  const removed = new Set<PaperItem>();
  const matched = new Set<PaperItem>();
  for (const test of [(a: PaperItem, b: PaperItem) => carries(a, b, 'exact'), (a: PaperItem, b: PaperItem) => carries(a, b, 'superset')]) {
    for (const item of read) {
      if (matched.has(item)) continue;
      const twin = earlier.find((candidate) => !removed.has(candidate) && sharesLine(item, candidate) && test(item, candidate));
      if (twin) { removed.add(twin); matched.add(item); }
    }
  }
  const missing = from === 'image' ? 'not_in_picture_reading' : 'not_in_second_reading';
  const kept = earlier.filter((item) => !removed.has(item));
  for (const item of kept) {
    addReason(item, missing);
    const best = bestMatch(item, read.filter((candidate) => sharesLine(candidate, item)), matched);
    if (best) {
      addReason(item, 'differs_from_second_reading');
      addReason(best, 'differs_from_second_reading');
    }
  }
  const merged = uniqueItemIds(inReadingOrder([...read, ...kept]));
  const { identity, conflict } = mergeIdentity(first.identity, second.identity);
  const cited = new Set([...merged.flatMap((item) => item.lineIds), ...identity.lineIds]);
  const missed = merged.some((item) => item.checkReasons.includes('duplicate_source_span'))
    || suspiciousUncited(lines, cited).length > 0;
  const flagReasons: FlagReason[] = [...second.flagReasons.filter((reason) => reason !== 'possible_missed_item'
    && !(conflict && reason === 'ai_unsure')), ...(conflict ? ['ai_unsure' as const] : []),
  ...(missed ? ['possible_missed_item' as const] : [])];
  return { ...second, items: merged, identity, flagReasons };
}

/** Add a check reason once; the item goes to a person, with the sentence of its first reason. */
function addReason(item: PaperItem, code: string): void {
  if (!item.checkReasons.includes(code)) item.checkReasons.push(code);
  item.confidence = 'check_carefully';
  item.checkReason = checkReasonSentence(item.checkReasons);
}

/**
 * Normalised text for comparing two readings: compact (case, spacing, "5 mg" = "5mg"), placeholders blanked, and
 * guess marks off (forMatching), so "Toxoplasmosis?" and "Toxoplasmosis" are the same reading.
 */
const comparable = (text: string) => compact(withoutPlaceholders(forMatching(text)));

/**
 * The one second-reading item (same kind, on a shared line: the candidates) that a kept first-pass item is to be
 * compared with, or null: for a medicine or diagnosis the same name, for an allergy the same substance, for a lab
 * result the same test, for a vital the same measure (normalised), and for a note the most shared words of four
 * letters or more (at least one; so "the" alone never pairs two notes). Unmatched candidates go first, then reading
 * order.
 */
function bestMatch(item: PaperItem, candidates: readonly PaperItem[], matched: ReadonlySet<PaperItem>): PaperItem | null {
  const ordered = [...candidates.filter((other) => !matched.has(other)), ...candidates.filter((other) => matched.has(other))];
  const key = (other: PaperItem): string | null => {
    switch (other.kind) {
      case 'medicine': case 'diagnosis': return other.fields.name === null ? null : comparable(other.fields.name);
      case 'allergy': return other.fields.substance === null ? null : comparable(other.fields.substance);
      case 'lab_result': return other.fields.test === null ? null : comparable(other.fields.test);
      case 'vital': return other.fields.measure;
      default: return null;
    }
  };
  if (item.kind === 'note') {
    const words = (other: PaperItem) => new Set(wordsIn(withoutPlaceholders(other.kind === 'note'
      ? other.fields.text ?? other.asWritten : other.asWritten)).filter((word) => word.length >= 4));
    const own = words(item);
    let best: PaperItem | null = null;
    let most = 0;
    for (const other of ordered) {
      const shared = [...words(other)].filter((word) => own.has(word)).length;
      if (shared > most) { most = shared; best = other; }
    }
    return best;
  }
  const own = key(item);
  return own === null || own === '' ? null : ordered.find((other) => key(other) === own) ?? null;
}

/**
 * The identity after a re-read, field by field: each of the name, date of birth, folder number and sex as the
 * second reading has it where only it has one, else as the first pass had it. Where both give a value and the
 * values differ (normalised), the first pass's is kept and `conflict` is true (the page is then flagged ai_unsure):
 * identity drives patient matching, so it is never changed silently. Lines are those of both readings and the box
 * the one around both boxes.
 */
export function mergeIdentity(first: PaperIdentity, second: PaperIdentity): { identity: PaperIdentity; conflict: boolean } {
  let conflict = false;
  const pick = (a: string | null, b: string | null) => {
    if (a === null) return b;
    if (b !== null && comparable(a) !== comparable(b)) conflict = true;
    return a;
  };
  const identity: PaperIdentity = {
    nameAsWritten: pick(first.nameAsWritten, second.nameAsWritten),
    dateOfBirthAsWritten: pick(first.dateOfBirthAsWritten, second.dateOfBirthAsWritten),
    folderNumberAsWritten: pick(first.folderNumberAsWritten, second.folderNumberAsWritten),
    sexAsWritten: pick(first.sexAsWritten, second.sexAsWritten),
    lineIds: [...new Set([...second.lineIds, ...first.lineIds])].sort((a, b) => lineNumber(a) - lineNumber(b)),
    box: unionBox([first.box, second.box]),
  };
  return { identity, conflict };
}

/**
 * Whether a second-reading item carries everything a first-pass item of the same kind says. 'exact': every field
 * the contract has for the kind, plus dateAsWritten and the prescription (prescriber and date), the same after
 * normalising, a missing field equal only to a missing field. 'superset': every field the first pass filled in
 * the same, normalised; a field the first pass left empty may be filled by the second reading.
 */
function carries(second: PaperItem, first: PaperItem, mode: 'exact' | 'superset'): boolean {
  if (second.kind !== first.kind) return false;
  const same = (x: unknown, y: unknown): boolean => {
    if (y === null || y === undefined) return mode === 'superset' || x === null || x === undefined;
    if (x === null || x === undefined) return false;
    if (typeof x === 'string' && typeof y === 'string') return comparable(x) === comparable(y);
    if (typeof x === 'object' && typeof y === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      return [...keys].every((key) => same((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key]));
    }
    return x === y;
  };
  return same(second.fields, first.fields) && same(second.dateAsWritten, first.dateAsWritten)
    && same(second.prescription, first.prescription);
}

function markDuplicateSpan(item: PaperItem): void {
  if (!item.checkReasons.includes('duplicate_source_span')) item.checkReasons.push('duplicate_source_span');
  item.confidence = 'check_carefully';
  item.checkReason = checkReasonSentence(item.checkReasons);
}

const lineNumber = (id: string) => Number(/-l(\d+)$/.exec(id)?.[1] ?? 0);
const baseItemId = (id: string) => /^it-[0-9a-f]{16}/.exec(id)?.[0] ?? id;

/**
 * Item ids unique within one extraction. The first item with a base id keeps it; each further item with the
 * same base id gets '-2', '-3', ... in reading order (page, then its first cited line, then the order read).
 * The items keep their order; already-suffixed ids are numbered afresh, so this can be applied again.
 */
export function uniqueItemIds(items: readonly PaperItem[]): PaperItem[] {
  const firstLine = (item: PaperItem) => Math.min(...item.lineIds.map(lineNumber));
  const reading = items.map((item, index) => ({ item, index })).sort((a, b) => a.item.page - b.item.page
    || firstLine(a.item) - firstLine(b.item) || a.index - b.index);
  const counts = new Map<string, number>();
  const ids = new Array<string>(items.length);
  for (const { item, index } of reading) {
    const base = baseItemId(item.id);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    ids[index] = count === 1 ? base : `${base}-${count}`;
  }
  return items.map((item, index) => (item.id === ids[index] ? item : { ...item, id: ids[index]! }));
}

/** The item's text fields with their guess marks off (forMatching): what checkItem holds to the page. */
function matchingItem(item: ModelItem): ModelItem {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key,
    typeof value === 'string' ? forMatching(value) : value])) as ModelItem;
}

/**
 * One kept item's checks. Every comparison with the page is made on the fields with their guess marks off
 * (`raw`, matchingItem), so "Sulfa?" is found in "No sulfa allergy" and "Hb?" labels its value; the item stores
 * and shows the fields as read (`shown`), marks and all. Dates and the prescriber are stored only where written
 * exactly on the page, as read.
 */
function checkItem(shown: ModelItem, lines: readonly ReadLine[], lineIds: readonly string[], source: string,
  pageText: string, order: ReadonlyMap<string, number>, medicineNames: readonly string[],
  allergySubstances: readonly string[], input: PageCheckInput): PaperItem {
  const raw = matchingItem(shown);
  const reasons: string[] = [];
  const add = (code: string) => { if (!reasons.includes(code)) reasons.push(code); };
  const restore = (text: string) => value(text, input.masker);
  const minConfidence = Math.min(...lines.map((line) => line.confidence));
  const handwritten = lines.some((line) => line.handwritten);
  if (minConfidence < REVIEW_BELOW) add(handwritten ? 'low_ocr_confidence_handwritten' : 'low_ocr_confidence');
  if (handwritten) add('handwritten');
  if (raw.unsure) add('ai_unsure');
  // Only an item that needs words from several lines can pair them wrongly (a table read cell by cell).
  if (lines.length > 1 && !lines.some((line) => has(line.text, raw.asWritten)) && !together(lines, order)) {
    add('lines_not_together');
  }
  // Placeholders are blanked before numbers and words are compared: "[hidden-number-1]" writes no 1.
  const numbers = (text: string) => numbersIn(withoutPlaceholders(text));
  const words = (text: string) => wordsIn(withoutPlaceholders(text));
  // A number in the plain reading that the cited text doesn't have: the reading changed what was written.
  const sourceNumbers = new Set(numbers(source));
  if (numbers(raw.plain).some((number) => !sourceNumbers.has(number))) add('reading_number_mismatch');

  let dateAsWritten = restoreIfPresent(shown.dateAsWritten, source, pageText, input.masker);
  if (raw.dateAsWritten.trim() && dateAsWritten === null) add('date_not_on_page');
  if (dateAsWritten !== null && ambiguousDate(dateAsWritten)) add('date_ambiguous');

  let kind: ItemKind = raw.kind;
  let fields: PaperItem['fields'];
  let prescription: { prescriberAsWritten: string | null; dateAsWritten: string | null } | null = null;
  const sourceWords = new Set(words(source));
  const fieldWordsMissing = (text: string) => words(text).some((word) => !sourceWords.has(word));
  const fieldNumbersMissing = (text: string, present: ReadonlySet<string>) =>
    numbers(text).some((number) => !present.has(number));
  /** A free-text field that is neither in the cited text as written nor made only of its words and numbers. */
  const notOnPaper = (text: string) => norm(text) !== '' && !has(source, text)
    && (fieldWordsMissing(text) || fieldNumbersMissing(text, sourceNumbers));

  switch (raw.kind) {
    case 'medicine': {
      const others = medicineNames.filter((other) => !has(other, raw.name) && !has(raw.name, other));
      // Lines are kept apart here (not joined with spaces) so that each cited line can be its own part.
      const own = segment(lines.map((line) => line.text).join('\n'), raw.name, others);
      const ownNumbers = new Set(numbers(own));
      const ownWords = new Set(words(own));
      if (!norm(raw.name)) add('name_missing');
      else if (!has(source, raw.name)) add('text_corrected');
      for (const [name, code] of [['strength', 'strength_mismatch'], ['frequency', 'frequency_mismatch'],
        ['duration', 'duration_mismatch']] as const) {
        const written = raw[name];
        if (fieldNumbersMissing(written, ownNumbers) || words(written).some((word) => !ownWords.has(word))) add(code);
      }
      if (norm(raw.strength) && !asWrittenIn(own, raw.strength)) add('strength_not_as_written');
      // The strength is also the item's own asWritten's, and the dose written for this medicine, not the next one's.
      if (norm(raw.strength) && (!asWrittenIn(segment(raw.asWritten, raw.name, others), raw.strength)
        || !doseLeads(own, raw.name, raw.strength))) add('strength_not_as_written');
      if (norm(raw.frequency) && !frequencyLeads(own, raw.name, raw.frequency)) add('frequency_mismatch');
      // How often and how long are held to the item's own text as written, not as a set of numbers ("5/7" is not "7/7").
      if (norm(raw.frequency) && !asWrittenIn(own, raw.frequency)) add('frequency_mismatch');
      if (norm(raw.duration) && !asWrittenIn(own, raw.duration)) add('duration_mismatch');
      if (notOnPaper(raw.form)) add('field_not_on_paper');
      if (plainDisagrees(raw.plain, own, raw.strength, raw.frequency, raw.duration)) add('plain_mismatch');
      if (!norm(raw.strength) && DOSE.test(own)) add('strength_missing');
      if (!norm(raw.frequency) && FREQUENCY.test(own)) add('frequency_missing');
      // A route counts only where the item's own text writes one, outside its name ("Oral rehydration salts").
      const name = norm(raw.name);
      const stated = new Set<string>();
      for (const text of [own, segment(raw.asWritten, raw.name, others)]) {
        for (const route of routes(name ? text.split(name).join(' ') : text)) stated.add(route);
      }
      const given = routes(raw.route);
      if (stated.size > 0 && !norm(raw.route)) add('route_missing');
      else if (stated.size > 0 && ![...given].some((route) => stated.has(route))) add('route_mismatch');
      else if (stated.size === 0 && norm(raw.route)) add('route_not_on_paper');
      const status = (['current', 'new', 'stopped', 'past', 'unknown'] as const)
        .find((candidate) => candidate === raw.status);
      if (!status) add('status_unclear');
      fields = { name: restore(shown.name), strength: restore(shown.strength), form: restore(shown.form),
        route: restore(shown.route), frequency: restore(shown.frequency), duration: restore(shown.duration),
        status: status ?? 'unknown' };
      const prescriber = restoreIfPresent(shown.prescriberAsWritten, source, pageText, input.masker);
      const prescribed = restoreIfPresent(shown.prescriptionDate, source, pageText, input.masker);
      if ((raw.prescriberAsWritten.trim() && prescriber === null) || (raw.prescriptionDate.trim() && prescribed === null)) {
        add('prescription_detail_not_on_page');
      }
      prescription = prescriber === null && prescribed === null ? null
        : { prescriberAsWritten: prescriber, dateAsWritten: prescribed };
      break;
    }
    case 'diagnosis': {
      if (!norm(raw.name)) add('name_missing');
      else if (!has(source, raw.name)) add('text_corrected');
      const status = (['confirmed', 'suspected', 'ruled_out', 'history', 'family_history'] as const)
        .find((candidate) => candidate === raw.status);
      if (!status) add('status_unclear');
      fields = { name: restore(shown.name), status: status ?? 'history' };
      break;
    }
    case 'allergy': {
      if (!raw.noKnownAllergies) {
        if (!norm(raw.substance)) add('substance_missing');
        else if (!has(source, raw.substance)) add('text_corrected');
      } else {
        // "No known allergies" only where the paper says so, and with nothing on the item naming one.
        if (!NO_KNOWN_ALLERGIES.test(norm(source))) add('nkda_not_on_paper');
        else if (norm(raw.substance) || norm(raw.reaction) || raw.severity !== 'none'
          || nkaLeftover(source).length > 0) add('nkda_conflicts');
      }
      // Reaction and severity are held to the allergy's own part of the text, not another allergy's on the line.
      const others = allergySubstances.filter((other) => !has(other, raw.substance) && !has(raw.substance, other));
      const own = raw.noKnownAllergies ? norm(source) : allergySegment(source, raw.substance, others);
      const ownWords = new Set(words(own));
      const ownNumbers = new Set(numbers(own));
      // "No penicillin allergy", "Penicillin -ve": the paper may say there is no such allergy.
      if (!raw.noKnownAllergies && norm(raw.substance) && allergyNegated(source, raw.substance, others)) {
        add('status_cue_on_line');
      }
      // A plain reading that gives a severity the item's own text doesn't write.
      if (ALLERGY_SEVERITY_WORDS.some((word) => severityOnPaper(raw.plain, word) && !severityOnPaper(own, word))) {
        add('plain_contradicts');
      }
      if (notOnPaper(raw.reaction) || (norm(raw.reaction) && !has(own, raw.reaction)
        && (words(raw.reaction).some((word) => !ownWords.has(word)) || fieldNumbersMissing(raw.reaction, ownNumbers)))) {
        add('field_not_on_paper');
      }
      // A severity only where the paper says how bad: its own word, or anaphylaxis for severe, on the item's own
      // text; 'unknown' only where the paper says it is not known.
      const severity = raw.severity === 'none' ? null : raw.severity;
      if (severity === 'unknown' ? !SEVERITY_UNKNOWN.test(norm(withoutPlaceholders(own)))
        : severity !== null && !severityOnPaper(own, severity)) add('field_not_on_paper');
      fields = { substance: raw.noKnownAllergies ? null : restore(shown.substance),
        reaction: restore(shown.reaction), severity: raw.noKnownAllergies ? null : severity,
        noKnownAllergies: raw.noKnownAllergies };
      break;
    }
    case 'lab_result': {
      if (!norm(raw.test)) add('name_missing');
      else if (!has(source, raw.test)) add('text_corrected');
      if (fieldNumbersMissing(raw.value, sourceNumbers) || fieldNumbersMissing(raw.referenceRange, sourceNumbers)) {
        add('value_mismatch');
      }
      if (norm(raw.value) && !numbers(raw.value).length && fieldWordsMissing(raw.value)) add('value_mismatch');
      // The value and range are the item's own, as written: not "+ve" for "-ve", nor the next test's number.
      if ((norm(raw.value) && !asWrittenIn(raw.asWritten, raw.value))
        || (norm(raw.referenceRange) && !asWrittenIn(raw.asWritten, raw.referenceRange))) add('value_mismatch');
      // The value is the one written for this test: the first after its name, before another test's name.
      const otherTests = input.answer.items.filter((item) => item.kind === 'lab_result' && norm(item.test))
        .map((item) => forMatching(item.test)).filter((other) => !has(other, raw.test) && !has(raw.test, other));
      if (norm(raw.value) && norm(raw.test)
        && !valueLeads(labelledParts(raw.asWritten, [pattern(raw.test)], otherTests.map(pattern)), raw.value)) {
        add('value_mismatch');
      }
      if (fieldWordsMissing(raw.unit) || !unitWritten(raw.asWritten, raw.value, raw.unit)) add('unit_mismatch');
      if (norm(raw.flag) && !has(source, raw.flag)) add('field_not_on_paper');
      // A plain reading that turns a negative result positive, or the other way round.
      if (opposite(resultSign(raw.plain), resultSign(norm(raw.value) ? raw.value : raw.asWritten))) {
        add('plain_contradicts');
      }
      fields = { test: restore(shown.test), value: restore(shown.value), unit: restore(shown.unit),
        referenceRange: restore(shown.referenceRange), flag: restore(shown.flag) };
      break;
    }
    case 'vital': {
      if (raw.measure === 'none') {
        // A reading with no recognisable measure is kept for the reviewer as a note, never as a vital.
        add('measure_unclear');
        kind = 'note';
        fields = { text: restore(shown.asWritten) };
        break;
      }
      if (!norm(raw.value)) add('name_missing');
      if (fieldNumbersMissing(raw.value, sourceNumbers)) add('value_mismatch');
      if (norm(raw.value) && !asWrittenIn(raw.asWritten, raw.value)) add('value_mismatch');
      // Where asWritten labels its readings ("Temp 38.5 Pulse 110"), the measure is one written there, and the
      // value is the one written after that label, before the next.
      const ownLabel = VITAL_LABELS[raw.measure];
      const otherLabels = Object.entries(VITAL_LABELS).filter(([measure]) => measure !== raw.measure)
        .map(([, label]) => label);
      const labelled = labelledParts(raw.asWritten, [ownLabel], otherLabels);
      if (labelled.length === 0 && labelledParts(raw.asWritten, otherLabels, []).length > 0) add('measure_mismatch');
      else if (labelled.length > 0 && norm(raw.value) && !valueLeads(labelled, raw.value)) add('value_mismatch');
      if (fieldWordsMissing(raw.unit) || !unitWritten(raw.asWritten, raw.value, raw.unit)) add('unit_mismatch');
      fields = { measure: raw.measure, value: restore(shown.value), unit: restore(shown.unit) };
      break;
    }
    case 'note':
    default:
      // A note's text is the paper's: noteText only where it is written in the cited lines, else asWritten.
      if (norm(raw.noteText) && !has(source, raw.noteText)) add('field_not_on_paper');
      fields = { text: (norm(raw.noteText) && has(source, raw.noteText) ? restore(shown.noteText) : null)
        ?? restore(shown.asWritten) };
      break;
  }
  if (kind === 'medicine' || kind === 'diagnosis') {
    const status = (fields as { status: string }).status;
    const cue = [...norm(source).matchAll(STATUS_CUES)].length > 0;
    // A medicine read with no status ('unknown'): words on the line that may change whether it is current (such as
    // "stopped" or "d/c") come first; only where there are none does the paper not say.
    if (kind === 'medicine' && status === 'unknown') add(cue ? 'status_cue_on_line' : 'status_not_written');
    else if (!ACTIVE_STATUSES.has(status)) add('status_not_active');
    else if (cue) add('status_cue_on_line');
  }
  let box = unionBox(lines.map((line) => line.box));
  if (box === null) { add('no_position'); box = { left: 0, top: 0, width: 1, height: 1 }; }
  if (dateAsWritten === '') dateAsWritten = null;
  const id = itemId(input.sourceSha256Hex, kind, lineIds, input.masker.restore(shown.asWritten));
  return {
    id, kind, asWritten: shown.asWritten, plain: input.masker.restore(shown.plain.trim()), dateAsWritten,
    page: input.page, lineIds: [...lineIds], box,
    confidence: reasons.length > 0 ? 'check_carefully' : 'clear',
    checkReasons: reasons, checkReason: checkReasonSentence(reasons),
    fields, prescription: kind === 'medicine' ? prescription : null, readBy: input.readBy,
  } as PaperItem;
}

/** A statement of no known allergies as written ("NKDA", "no known drug allergies", "nil known", "allergies: none"). */
const NKA = '(?<![\\p{L}\\p{N}_])(?:nkda|nka|nkfa|nkda\\.|no\\s+known\\s+(?:drug\\s+|food\\s+)?allerg\\p{L}*'
  + '|nil\\s+known(?:\\s+(?:drug\\s+)?allerg\\p{L}*)?|no\\s+(?:drug\\s+)?allerg\\p{L}*'
  + '|allerg\\p{L}*\\s*[:-]?\\s*(?:nil|none|no)(?![\\p{L}\\p{N}_]))(?![\\p{L}\\p{N}_])';
const NO_KNOWN_ALLERGIES = new RegExp(NKA, 'u');
const NO_KNOWN_ALLERGIES_ALL = new RegExp(NKA, 'gu');

const NKA_FILLER = new Set(['known', 'drug', 'drugs', 'food', 'nil', 'none', 'no', 'and', 'or', 'otherwise', 'hx', 'pmh']);
/** The words left on the cited text once its no-known-allergies statement and allergy labels are taken out. */
function nkaLeftover(source: string): string[] {
  const rest = norm(withoutPlaceholders(source)).replace(NO_KNOWN_ALLERGIES_ALL, ' ')
    .replace(/(?:drug\s+|known\s+)?allerg\p{L}*\s*[:-]/gu, ' ');
  return wordsIn(rest).filter((word) => !NKA_FILLER.has(word));
}

/** A negation just before a word ("not severe", "non-severe", "no anaphylaxis"), or a word joined by a hyphen. */
const NOT_BEFORE = '(?<!(?<!\\p{L})(?:not|non|no|without)[\\s-]*)(?<!\\p{L}-)';
/** The paper saying the severity (or the reaction) is not known. */
const SEVERITY_UNKNOWN = /(?<![\p{L}\p{N}_])(?:unknown|not known|unk|uncertain|unclear|unsure)(?![\p{L}\p{N}_])/u;

/**
 * Whether the item's own text writes this severity: the word itself, or anaphylaxis (any form) for severe,
 * neither negated nor joined to another word by a hyphen.
 */
function severityOnPaper(own: string, severity: 'mild' | 'moderate' | 'severe'): boolean {
  const text = norm(withoutPlaceholders(own));
  return new RegExp(NOT_BEFORE + pattern(severity), 'u').test(text)
    || (severity === 'severe' && new RegExp(`${NOT_BEFORE}(?<!\\p{L})anaphyla`, 'u').test(text));
}

/**
 * The allergy's own part of its text, normalised: from its substance up to where another listed allergy's
 * substance starts, so that one allergy's reaction or severity doesn't count for another. With no substance,
 * or the substance written more than once, the whole text is kept.
 */
function allergySegment(text: string, substance: string, others: readonly string[]): string {
  const whole = norm(text);
  if (!norm(substance)) return whole;
  const found = [...whole.matchAll(new RegExp(pattern(substance), 'gu'))];
  if (found.length !== 1) return whole;
  const atStart = found[0]!.index;
  const atEnd = atStart + found[0]![0].length;
  let start = 0;
  let end = whole.length;
  for (const other of others) {
    if (!norm(other)) continue;
    for (const match of whole.matchAll(new RegExp(pattern(other), 'gu'))) {
      if (match.index + match[0].length <= atStart) start = Math.max(start, atStart);
      else if (match.index >= atEnd) end = Math.min(end, match.index);
    }
  }
  return whole.slice(start, end).replace(/^[ ,;]+|[ ,;]+$/g, '');
}

/** Whether part is in text as written: as is, with "5 mg" read as "5mg", or with "5.4mmol/L" read as "5.4 mmol/L". */
function asWrittenIn(text: string, part: string): boolean {
  const spaced = (value: string) => norm(value).replace(/(\d)(?=\p{L})/gu, '$1 ');
  return has(text, part) || has(compact(text), compact(part)) || has(spaced(text), spaced(part))
    || sameCombined(text, part);
}

const BOUND_START = '(?<![\\p{L}\\p{N}_])';
const BOUND_END = '(?![\\p{L}\\p{N}_])';
/** How each vital is labelled on paper, as a pattern on normalised text. */
const VITAL_LABELS: Readonly<Record<(typeof VITAL_MEASURES)[number], string>> = Object.fromEntries(Object.entries({
  blood_pressure: 'blood pressure|bp|b/p',
  pulse: 'pulse rate|pulse|heart rate|hr|pr|p',
  temperature: 'temperature|temp|tmp|t',
  respiratory_rate: 'respiratory rate|resp rate|resp|rr',
  oxygen_saturation: 'oxygen saturation|o2 sats?|spo2|sao2|sats?',
  weight: 'weight|wt|w',
  height: 'height|ht|h',
  blood_glucose: 'blood glucose|blood sugar|glucose|gluc|sugar|rbs|fbs|rbg|fbg|cbg|bg|bs',
}).map(([measure, words]) => [measure, `${BOUND_START}(?:${words})${BOUND_END}`])) as never;

/**
 * The parts of text written after each of its own labels (patterns on normalised text), each up to where the
 * next label, its own or another's, starts. Empty where none of its own labels is written.
 */
function labelledParts(text: string, own: readonly string[], others: readonly string[]): string[] {
  const whole = norm(text);
  const find = (sources: readonly string[]) => sources.flatMap((source) => [...whole.matchAll(new RegExp(source, 'gu'))]
    .filter((match) => match[0].length > 0).map((match) => ({ start: match.index, end: match.index + match[0].length })));
  const mine = find(own);
  const all = [...mine, ...find(others)];
  return mine.map((label) => whole.slice(label.end,
    Math.min(whole.length, ...all.filter((other) => other.start >= label.end).map((other) => other.start))));
}

/**
 * Whether the value is written in one of the parts, as its first number where it has one ("Hb 9.8" is not 12.4),
 * or else as its first result where it gives one ("HIV -ve HBsAg +ve" is not "+ve" for HIV).
 */
function valueLeads(parts: readonly string[], value: string): boolean {
  if (parts.length === 0) return true;
  const first = numbersIn(withoutPlaceholders(value))[0];
  const sign = first === undefined ? resultSign(value) : null;
  return parts.some((part) => asWrittenIn(part, value)
    && (first === undefined || numbersIn(withoutPlaceholders(part))[0] === first)
    && (sign === null || firstResultSign(part) === sign));
}

/** The medicine's own text after its name, normalised; null where the name isn't written in it. */
function afterName(own: string, name: string): string | null {
  if (!norm(name)) return null;
  const at = new RegExp(pattern(name), 'u').exec(norm(own));
  return at ? norm(norm(own).slice(at.index + at[0].length)) : null;
}

/**
 * Whether the strength is a dose written for this medicine: one written after its name and before its first
 * frequency, or the first dose after its name where no frequency follows. Not "400mg" in
 * "Paracetamol 1g tds Ibuprofen 400mg bd". A combined strength ("80/480mg") counts as one dose.
 */
function doseLeads(own: string, name: string, strength: string): boolean {
  const after = afterName(own, name);
  if (after === null) return true;
  const combined = combinedStrengths(after);
  const doses = [...combined.map((found) => ({ start: found.start, text: after.slice(found.start, found.end) })),
    ...[...after.matchAll(DOSES)].filter((match) => !combined.some((found) => match.index >= found.start
      && match.index < found.end)).map((match) => ({ start: match.index, text: match[0] }))]
    .sort((a, b) => a.start - b.start);
  if (doses.length === 0) return true;
  const frequency = FREQUENCY.exec(after);
  const leading = frequency ? doses.filter((dose) => dose.start < frequency.index) : [];
  return (leading.length > 0 ? leading : [doses[0]!]).some((dose) => asWrittenIn(dose.text, strength));
}

/** Whether the frequency gives the first frequency written after the medicine's name ("tds", not the next "bd"). */
function frequencyLeads(own: string, name: string, frequency: string): boolean {
  const after = afterName(own, name);
  const first = after === null ? null : FREQUENCY.exec(after);
  return first === null || has(frequency, first[0]);
}

const NEGATIVE_RESULT = new RegExp(`${BOUND_START}(?:negative|neg|non[- ]?reactive|not (?:detected|seen|found)`
  + `|no (?:\\p{L}+ ){0,3}seen|nil seen|none seen|absent)${BOUND_END}|-ve${BOUND_END}`, 'gu');
const POSITIVE_RESULT = new RegExp(`${BOUND_START}(?:positive|pos|reactive|detected|seen|present|found)${BOUND_END}`
  + `|\\+ve${BOUND_END}|(?<![\\p{L}\\p{N}_+])\\+{1,4}(?![\\p{L}\\p{N}_+])`, 'u');

/** Whether a text gives a result as negative or positive; null where it says neither, or both. */
function resultSign(text: string): 'negative' | 'positive' | null {
  const normalised = norm(withoutPlaceholders(text));
  const negative = new RegExp(NEGATIVE_RESULT.source, 'u').test(normalised);
  const positive = POSITIVE_RESULT.test(normalised.replace(NEGATIVE_RESULT, ' '));
  if (negative === positive) return null;
  return negative ? 'negative' : 'positive';
}

/** The first result a text gives, negative or positive; null where it gives none. */
function firstResultSign(text: string): 'negative' | 'positive' | null {
  const normalised = norm(withoutPlaceholders(text));
  const negative = new RegExp(NEGATIVE_RESULT.source, 'u').exec(normalised);
  const positive = new RegExp(POSITIVE_RESULT.source, 'u').exec(normalised.replace(NEGATIVE_RESULT,
    (found) => ' '.repeat(found.length)));
  if (negative === null) return positive === null ? null : 'positive';
  return positive === null || negative.index < positive.index ? 'negative' : 'positive';
}

function opposite(a: 'negative' | 'positive' | null, b: 'negative' | 'positive' | null): boolean {
  return a !== null && b !== null && a !== b;
}

const ALLERGY_SEVERITY_WORDS = ['mild', 'moderate', 'severe'] as const;
const NEGATED_BEFORE = new RegExp(`${BOUND_START}(?:no|not|nil|none|non|denies|denied|without|never|negative)${BOUND_END}`,
  'u');
const NEGATED_AFTER = new RegExp(`${BOUND_START}(?:not allergic|no allerg\\p{L}*|negative|neg|tolerat\\p{L}*|denie[sd]`
  + `|ruled? out)${BOUND_END}|-ve${BOUND_END}`, 'u');

/**
 * Whether the paper negates this allergy: a negation in its own clause before the substance ("no penicillin
 * allergy", "denies penicillin") or after it, before another listed substance ("penicillin -ve").
 */
function allergyNegated(source: string, substance: string, others: readonly string[]): boolean {
  const whole = norm(withoutPlaceholders(source));
  const otherSpans = others.filter((other) => norm(other)).flatMap((other) =>
    [...whole.matchAll(new RegExp(pattern(other), 'gu'))].map((match) => ({ start: match.index,
      end: match.index + match[0].length })));
  return [...whole.matchAll(new RegExp(pattern(substance), 'gu'))].some((match) => {
    const start = match.index;
    const end = start + match[0].length;
    const clauseStart = Math.max(0, ...[...whole.slice(0, start).matchAll(/[,;.\n]/gu)].map((found) => found.index + 1),
      ...otherSpans.filter((span) => span.end <= start).map((span) => span.end));
    const next = Math.min(whole.length, ...otherSpans.filter((span) => span.start >= end).map((span) => span.start));
    return NEGATED_BEFORE.test(whole.slice(clauseStart, start)) || NEGATED_AFTER.test(whole.slice(end, next));
  });
}

/**
 * Whether a reading's unit is the one written for it: straight after its value ("97%", "97 %", "36.1°C"), or on
 * its own ("SpO2 (%): 97"), but never one written after another number ("%" of "PCV 32%" is not 97's).
 */
function unitWritten(asWritten: string, value: string, unit: string): boolean {
  if (!norm(unit)) return true;
  return unitAfter(asWritten, value, unit) || asWrittenIn(withoutNumberedUnit(asWritten, unit), unit);
}

const FREQUENCY_CODES: ReadonlyArray<readonly [string, RegExp]> = [
  ['od', /\b(?:once (?:a|per|each) day|once daily|daily|every day)\b/u],
  ['bd', /\b(?:twice (?:a|per|each) day|twice daily)\b/u],
  ['tds', /\b(?:three times (?:a|per|each) day|three times daily)\b/u],
  ['qds', /\b(?:four times (?:a|per|each) day|four times daily)\b/u],
  ['nocte', /\b(?:at night|at bedtime|every night)\b/u],
  ['mane', /\b(?:in the morning|every morning)\b/u],
  ['prn', /\b(?:when needed|as needed|as required|when required)\b/u],
];
const FREQUENCY_ALIASES: Readonly<Record<string, string>> = { od: 'od', daily: 'od', bd: 'bd', bid: 'bd',
  tds: 'tds', tid: 'tds', qds: 'qds', qid: 'qds', nocte: 'nocte', mane: 'mane', prn: 'prn' };
const DOSES = new RegExp(DOSE.source, 'gu');

/**
 * Whether the plain reading says something about the dose, how often or how long that the item's own fields
 * and text don't: a dose in plain that is neither the strength nor written in the item's text, a frequency
 * phrase for another code, or a duration number the duration doesn't have.
 */
function plainDisagrees(plain: string, own: string, strength: string, frequency: string, duration: string): boolean {
  let text = spelledUnits(norm(withoutPlaceholders(plain)));
  // A combined strength ("80/480 mg", "80 mg/480 mg") is held to the item as a whole, then its parts are taken out
  // so that "480 mg" is not read as a dose of its own; a different one ("20/120 mg") disagrees.
  const combined = combinedStrengths(text);
  const known = new Set([...combinedStrengths(own), ...combinedStrengths(strength)].map((found) => found.canonical));
  if (combined.some((found) => !known.has(found.canonical))) return true;
  for (const found of [...combined].reverse()) text = `${text.slice(0, found.start)} ${text.slice(found.end)}`;
  for (const dose of text.matchAll(DOSES)) {
    if (micrograms(dose[0]) !== micrograms(strength) && !asWrittenIn(micrograms(own), micrograms(dose[0]))) return true;
  }
  const code = FREQUENCY_ALIASES[norm(frequency)];
  if (code) {
    const said = FREQUENCY_CODES.filter(([, phrase]) => phrase.test(text)).map(([name]) => name);
    if (said.length > 0 && !said.includes(code)) return true;
  }
  const lasting = [...text.matchAll(/\bfor (\d+(?:[.,]\d+)?) (day|week|month)s?\b/gu)];
  if (lasting.length > 0) {
    // "5/7" is 5 days, "2/52" 2 weeks, "3/12" 3 months: its second number is not a duration.
    const fractions = [...norm(duration).matchAll(/(?<![\d.,])(\d+) ?\/ ?(7|52|12)(?!\d)/gu)]
      .map((match) => `${match[1]} ${FRACTION_UNITS[match[2]!]}`);
    if (fractions.length > 0) {
      if (lasting.some((match) => !fractions.includes(`${match[1]} ${match[2]}`))) return true;
    } else {
      const given = new Set(numbersIn(duration));
      if (given.size === 0 || lasting.some((match) => !given.has(match[1]!))) return true;
    }
  }
  return false;
}

const FRACTION_UNITS: Readonly<Record<string, string>> = { 7: 'day', 52: 'week', 12: 'month' };

/** A unit written as a word after a number, as its abbreviation: "500 micrograms" is "500 mcg". */
function spelledUnits(text: string): string {
  return text.replace(/(\d) ?(?:micrograms?|mcgs)(?![\p{L}\p{N}_])/gu, '$1 mcg')
    .replace(/(\d) ?(?:milligrams?|milligrammes?|mgs)(?![\p{L}\p{N}_])/gu, '$1 mg')
    .replace(/(\d) ?(?:grams?|grammes?|gms?)(?![\p{L}\p{N}_])/gu, '$1 g')
    .replace(/(\d) ?(?:millilit(?:re|er)s?|mls)(?![\p{L}\p{N}_])/gu, '$1 ml')
    .replace(/(\d) ?international units?(?![\p{L}\p{N}_])/gu, '$1 iu');
}

/** Compact, with "µg" and "ug" written as "mcg". */
function micrograms(text: string): string {
  return compact(text).replace(/(\d)(?:µg|ug)(?![\p{L}\p{N}_])/gu, '$1mcg');
}

/** A value kept only when it is written in the cited lines or elsewhere on the page; null otherwise. */
function restoreIfPresent(text: string, source: string, pageText: string, masker: Masker): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return has(source, trimmed) || has(pageText, trimmed) ? masker.restore(trimmed) : null;
}

function checkIdentity(raw: ModelPage['identity'], byId: ReadonlyMap<string, ReadLine>, pageText: string,
  masker: Masker): PaperIdentity {
  const lineIds = [...new Set(raw.lineIds)].filter((id) => byId.has(id));
  const source = lineIds.map((id) => byId.get(id)!.text).join(' ');
  const keep = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    return (lineIds.length > 0 ? has(source, trimmed) : has(pageText, trimmed)) ? masker.restore(trimmed) : null;
  };
  const identity: PaperIdentity = { nameAsWritten: keep(raw.name), dateOfBirthAsWritten: keep(raw.dateOfBirth),
    folderNumberAsWritten: keep(raw.folderNumber), sexAsWritten: keep(raw.sex), lineIds, box: null };
  if (!identity.nameAsWritten && !identity.dateOfBirthAsWritten && !identity.folderNumberAsWritten
      && !identity.sexAsWritten) return blankIdentity();
  identity.box = unionBox(lineIds.map((id) => byId.get(id)!.box));
  return identity;
}

export { blankIdentity };
