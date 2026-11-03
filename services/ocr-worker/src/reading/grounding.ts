/**
 * Deterministic text rules that hold the AI's items to the page. Pure
 * functions, ported from the design draft (ocr_extract_bedrock_draft.py:
 * _norm, _compact, _pattern, _has, _segment, _routes, _together, coverage,
 * partly_covered). Nothing here calls out or logs.
 *
 * Python's \w and [^\W\d_] are Unicode-aware; here they are spelled with
 * Unicode property escapes so a name such as "Adaeze" or "Ọlá" behaves the
 * same way. The hint patterns run on lower-cased text.
 */
import type { LineBox } from '../types';

const W = '[\\p{L}\\p{N}_]';
const LETTER = '\\p{L}';
const MEASURE = '(?:mg|mcg|µg|ug|g|ml|iu|u|units?)';

export const NUMBER = /\d+(?:[.,]\d+)*/g;
export const WORD = /\p{L}+/gu;
/** A dose: a number and its unit, but not a lab result's concentration (g/dL, mmol/L, IU/L, mg/24h, mL/min). */
export const DOSE = new RegExp('\\d+(?:[.,]\\d+)?\\s*(?:mg|mcg|µg|ug|g|ml|iu|u|units?|tabs?|caps?|puffs?|drops?|sachets?)'
  + '(?![\\p{L}\\p{N}_])(?!/(?:dl|l|mmol|min)(?![\\p{L}\\p{N}_])|/24)', 'u');
export const FREQUENCY = /(?<![\p{L}\p{N}_])(?:od|bd|bid|tds|tid|qds|qid|nocte|mane|prn|stat)(?![\p{L}\p{N}_])/u;
const CONDITION = '(?<![\\p{L}\\p{N}_])(?:hypertension|htn|diabet\\p{L}*|t[12]dm|asthma|copd|malaria|typhoid|pneumonia'
  + '|tuberculosis|tb|hiv|urti|lrti|uti|ckd|aki|ihd|ccf|chf|cva|stroke|epilepsy|cancer|sepsis|infection|disease'
  + '|disorder|syndrome|failure|fracture|ulcer|(?:carcin|lymph|melan|sarc|myel|glauc)oma'
  + '|(?!diagnosis(?![\\p{L}\\p{N}_])|prognosis(?![\\p{L}\\p{N}_]))\\p{L}{2,}(?:itis|osis|aemia|emia|pathy))(?![\\p{L}\\p{N}_])';
/** What a diagnosis or a medicine is made of: a dose, a frequency, or a condition's name. */
export const ITEM_HINTS = new RegExp(`${DOSE.source}|${FREQUENCY.source}|${CONDITION}`, 'u');
/** Words that introduce one (section labels, dosage forms): on a line no item cites, they point to a missed item too. */
export const ITEM_LABELS = new RegExp('^a ?:|(?<![\\p{L}\\p{N}_])(?:dx|ddx|imp|impression|diagnos\\p{L}*|assessment|pmh|hx'
  + '|treated for|history of|rx|tabs?|tablets?|caps?|capsules?|inj|syr|syrup|susp|inh|inhaler|cream|oint\\p{L}*|nebs?'
  + '|supp|bp|temp|pulse|spo2|wt|weight|allerg\\p{L}*|nkda)(?![\\p{L}\\p{N}_])', 'u');
/** Words on an item's own line that put an active status in doubt. */
export const STATUS_CUES = new RegExp('(?<![\\p{L}\\p{N}_])(?:no evidence of|negative for|ruled? out|r/o|query|possible'
  + '|suspected|fhx|family history|stopped|discontinued|d/c|allerg(?:y|ies)|allergic to|h/o|history of|pmh'
  + '|past history)(?![\\p{L}\\p{N}_])|\\?', 'gu');

const ROUTE_WORDS: Readonly<Record<string, string>> = {
  intravenous: 'iv|i\\.v\\.?|intravenous(?:ly)?',
  intramuscular: 'im|i\\.m\\.?|intramuscular(?:ly)?',
  oral: 'po|p\\.o\\.?|oral(?:ly)?|by mouth',
  subcutaneous: 'sc|sq|s/c|s\\.c\\.?|subcut|subcutaneous(?:ly)?',
  rectal: 'pr|p\\.r\\.?|rectal(?:ly)?|per rectum',
  sublingual: 'sl|sublingual(?:ly)?',
  topical: 'topical(?:ly)?',
  inhaled: 'inhaled|inhalation|nebs?|nebuli[sz]ed|nebuli[sz]er',
  intrathecal: 'intrathecal(?:ly)?',
  vaginal: 'pv|vaginal(?:ly)?|per vagina',
  nasal: 'nasal(?:ly)?|intranasal(?:ly)?',
  intradermal: 'intradermal(?:ly)?',
  transdermal: 'transdermal(?:ly)?',
};
const ROUTES = Object.entries(ROUTE_WORDS)
  .map(([route, words]) => [route, new RegExp(`(?<!${W})(?:${words})(?!${W})`, 'u')] as const);

export function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Normalised, with no space between a number and its unit: "5 mg" and "5mg" read the same. */
export function compact(text: string): string {
  return norm(text).replace(/(\d)\s+(?=\p{L})/gu, '$1');
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/**
 * A pattern that finds part in normalised text as whole words and whole numbers.
 *
 * "Warfarin 5" is not in "Warfarin 50 mg" or "Morphine 5-10mg", "5 mg" is not in "2.5 mg", "15mg" is not in
 * "15mg/kg" and "Amoxicillin" is not in "Amoxicillin-clavulanate"; but "HTN" is in "HTN/T2DM": the rule
 * against a neighbouring "." "," "/" or "-" applies only next to a digit.
 */
export function pattern(part: string): string {
  const p = norm(part);
  const first = p.slice(0, 1);
  const last = p.slice(-1);
  return `(?<!${W})` + (/\d/.test(first) ? '(?<!\\d[.,/-])' : '') + escapeRegExp(p)
    + `(?!${W})` + (/\d/.test(last) ? '(?![.,/-]\\d)' : `(?!-${LETTER})`)
    + (new RegExp(`\\d\\s*${MEASURE}$`, 'u').test(p) ? `(?!/${LETTER})` : '');
}

/** Whether part appears in text as whole words and whole numbers (see pattern). An empty part is never present. */
export function has(text: string, part: string): boolean {
  if (!norm(part)) return false;
  return new RegExp(pattern(part), 'u').test(norm(text));
}

/**
 * The medicine's own part of its text, normalised, so that another medicine's dose doesn't count for it.
 *
 * The text is split at , ; and line breaks where both sides have a dose of their own ("Paracetamol 1g, tds"
 * stays whole), the part holding the name is kept, and it is cut where another listed medicine's name
 * starts. With no name, or the name in more than one part, the whole text is kept.
 */
export function segment(text: string, name: string, others: readonly string[]): string {
  const parts: string[] = [];
  for (const part of norm(text.replace(/[;\n]/g, ',')).split(',')) {
    const previous = parts[parts.length - 1];
    if (previous !== undefined && DOSE.test(part) && DOSE.test(previous)) parts.push(part);
    else if (previous !== undefined) parts[parts.length - 1] = `${previous},${part}`;
    else parts.push(part);
  }
  const holding = parts.filter((part) => norm(name) && has(part, name));
  if (holding.length !== 1) return norm(text);
  const own = holding[0]!;
  const at = new RegExp(pattern(name), 'u').exec(own);
  if (!at) return norm(text);
  const atStart = at.index;
  const atEnd = at.index + at[0].length;
  let start = 0;
  let end = own.length;
  for (const other of others) {
    if (!norm(other)) continue;
    for (const found of own.matchAll(new RegExp(pattern(other), 'gu'))) {
      const foundStart = found.index;
      const foundEnd = found.index + found[0].length;
      if (foundEnd <= atStart) start = atStart;
      else if (foundStart >= atEnd) end = Math.min(end, foundStart);
    }
  }
  if (parts.length === 1 && start === 0 && end === own.length) return norm(text);
  return own.slice(start, end).replace(/^[ ,]+|[ ,]+$/g, '');
}

export function routes(text: string): Set<string> {
  const normalised = norm(text);
  return new Set(ROUTES.filter(([, words]) => words.test(normalised)).map(([route]) => route));
}

export interface PlacedLine { id: string; box: LineBox | null }

function overlap(a: LineBox, b: LineBox, axis: 'vertical' | 'horizontal'): number {
  return axis === 'vertical'
    ? Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
    : Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
}

/**
 * Whether lines sit on one visual row, or form one wrapped block: next in reading order, each directly under
 * the one before, in the same column. Lines without a position never count as together.
 */
export function together(lines: readonly PlacedLine[], order: ReadonlyMap<string, number>): boolean {
  if (new Set(lines.map((line) => line.id.split('-')[0])).size > 1) return false;
  if (lines.some((line) => line.box === null || !order.has(line.id))) return false;
  const boxes = lines.map((line) => line.box!);
  const oneRow = boxes.every((a, n) => boxes.slice(n + 1)
    .every((b) => overlap(a, b, 'vertical') >= Math.min(a.height, b.height) / 2));
  if (oneRow) return true;
  const ordered = [...lines].sort((left, right) => order.get(left.id)! - order.get(right.id)!);
  const places = ordered.map((line) => order.get(line.id)!);
  if (places.some((place, index) => place !== places[0]! + index)) return false;
  for (let index = 1; index < ordered.length; index += 1) {
    const a = ordered[index - 1]!.box!;
    const b = ordered[index]!.box!;
    const gap = b.top - (a.top + a.height);
    if (!(-a.height / 2 <= gap && gap <= Math.max(a.height, b.height)) || overlap(a, b, 'horizontal') <= 0) return false;
  }
  return true;
}

export interface TextLine { id: string; text: string }

/** Uncited lines that look like a diagnosis, a medicine or a reading: a possible missed item. */
export function suspiciousUncited(lines: readonly TextLine[], cited: ReadonlySet<string>): string[] {
  return lines.filter((line) => !cited.has(line.id))
    .filter((line) => ITEM_HINTS.test(norm(line.text)) || ITEM_LABELS.test(norm(line.text)))
    .map((line) => line.id);
}

/**
 * The cited lines that still hold a dose, a frequency or a condition once the asWritten of every item citing
 * them is taken out: a diagnosis or medicine left out of a line that another item came from.
 */
export function partlyCovered(lines: readonly TextLine[],
  items: readonly { lineIds: readonly string[]; asWritten: string }[]): string[] {
  const texts = new Map(lines.map((line) => [line.id, norm(line.text)]));
  const covered = new Map([...texts].map(([id, text]) => [id, new Array<boolean>(text.length).fill(false)]));
  const cited = new Set<string>();
  for (const item of items) {
    const ids = [...new Set(item.lineIds)].filter((id) => texts.has(id));
    ids.forEach((id) => cited.add(id));
    if (ids.length === 0 || !norm(item.asWritten)) continue;
    const joined = ids.map((id) => texts.get(id)!).join(' ');
    const starts: number[] = [];
    let offset = 0;
    for (const id of ids) { starts.push(offset); offset += texts.get(id)!.length + 1; }
    for (const found of joined.matchAll(new RegExp(pattern(item.asWritten), 'gu'))) {
      const foundStart = found.index;
      const foundEnd = found.index + found[0].length;
      ids.forEach((id, index) => {
        const start = starts[index]!;
        const length = texts.get(id)!.length;
        for (let at = Math.max(foundStart, start); at < Math.min(foundEnd, start + length); at += 1) {
          covered.get(id)![at - start] = true;
        }
      });
    }
  }
  return lines.filter((line) => cited.has(line.id)).filter((line) => {
    const text = texts.get(line.id)!;
    const hits = covered.get(line.id)!;
    // covered is indexed by UTF-16 code unit (as text.length and match indices are), so the text is too.
    const rest = text.split('').map((unit, index) => (hits[index] ? ' ' : unit)).join('');
    return ITEM_HINTS.test(rest);
  }).map((line) => line.id);
}

/** Numbers as written in a text (normalised). */
export function numbersIn(text: string): string[] {
  return norm(text).match(NUMBER) ?? [];
}

/** Words (letters only) as written in a text (normalised). */
export function wordsIn(text: string): string[] {
  return norm(text).match(WORD) ?? [];
}

/** A dd/mm/yy-style date whose first two parts could be read either way. */
export function ambiguousDate(text: string): boolean {
  for (const match of norm(text).matchAll(/(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?!\d)/g)) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first >= 1 && first <= 12 && second >= 1 && second <= 12 && first !== second) return true;
  }
  return false;
}
