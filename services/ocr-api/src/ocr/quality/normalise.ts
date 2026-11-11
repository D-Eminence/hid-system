/**
 * Normalisers for comparing what the AI reading wrote with what a reviewer kept. A TypeScript port of the OCR
 * accuracy kit's lib/normalise.mjs (tools/ocr-accuracy-kit), so a "changed" field here means the same as a
 * disagreement in the kit's score: spacing, case, unit spellings and frequency spellings do not count as a change.
 * Keep the two in step; normalise.spec.ts carries the kit's test vectors.
 */

/**
 * Lower case, Unicode-compatible forms (µ -> μ etc.), one space between words, no surrounding punctuation.
 * A leading dot before a digit is kept: ".5 mg" is half a milligram, not "5 mg".
 */
export function normText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKC').toLowerCase().replace(/[µμ]/g, 'u')
    .replace(/\s+/g, ' ').trim().replace(/^(?:[\s,;:()\-]|\.(?!\d))+|[\s.,;:()\-]+$/g, '');
}

/** A number written with no digit before its decimal point (".5") as the same number with one ("0.5"). */
const leadingZero = (text: string): string => text.replace(/(?<![\da-zÀ-ɏ.])\.(?=\d)/g, '0.');

const FORM_WORDS = new Set(['tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules', 'inj',
  'injection', 'syr', 'syrup', 'susp', 'suspension', 'mist', 'inh', 'inhaler', 'iv', 'im', 'po', 'sc', 'cream', 'oint',
  'supp']);

/** A medicine name: normText, hyphens and slashes as spaces, a leading dosage form or route dropped. */
export function normName(value: unknown): string {
  const words = normText(value).replace(/[-/]+/g, ' ').replace(/[.,]/g, ' ').split(' ').filter(Boolean);
  while (words.length > 1 && FORM_WORDS.has(words[0] as string)) words.shift();
  return words.join(' ');
}

const UNIT_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/(?<![a-z])(?:mcg|ug|microgram|micrograms)(?![a-z])/g, 'mcg'],
  [/(?<![a-z])(?:mg|mgs|milligram|milligrams)(?![a-z])/g, 'mg'],
  [/(?<![a-z])(?:g|gm|gms|gram|grams)(?![a-z])/g, 'g'],
  [/(?<![a-z])(?:ml|mls|millilitre|millilitres|milliliter|milliliters)(?![a-z])/g, 'ml'],
  [/(?<![a-z])(?:iu|units?)(?![a-z])/g, 'iu'],
  [/(?<![a-z])(?:tabs?|tablets?)(?![a-z])/g, 'tab'],
  [/(?<![a-z])(?:caps?|capsules?)(?![a-z])/g, 'cap'],
];

/** A strength: normText, unit spellings unified, no space between a number and its unit ("5 mg" == "5mg"). */
export function normStrength(value: unknown): string {
  let text = leadingZero(normText(value));
  for (const [pattern, unit] of UNIT_ALIASES) text = text.replace(pattern, unit);
  return text.replace(/(\d)\s+(?=[a-z])/g, '$1').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');
}

/**
 * How often, mapped to one code. Any spelling on the right counts as the code on the left. Dots and spaces inside
 * an abbreviation are ignored ("b.d." == "bd", "t d s" == "tds").
 */
export const FREQUENCY_TABLE: Readonly<Record<string, readonly string[]>> = {
  od: ['od', 'o.d', 'qd', 'daily', 'once daily', 'once a day', 'once per day', '1 daily', 'one daily', '24hrly',
    '24 hrly', '24 hourly', 'q24h', 'every day'],
  bd: ['bd', 'bid', 'b.i.d', 'twice daily', 'twice a day', 'twice per day', '12hrly', '12 hrly', '12 hourly',
    '12h', 'q12h', 'every 12 hours'],
  tds: ['tds', 'tid', 't.i.d', 'three times daily', 'three times a day', 'thrice daily', '8hrly', '8 hrly',
    '8 hourly', '8h', 'q8h', 'every 8 hours'],
  qds: ['qds', 'qid', 'q.i.d', 'four times daily', 'four times a day', '6hrly', '6 hrly', '6 hourly', '6h', 'q6h',
    'every 6 hours'],
  nocte: ['nocte', 'on', 'o.n', 'at night', 'at bedtime', 'every night', 'hs', 'nightly'],
  mane: ['mane', 'om', 'o.m', 'in the morning', 'every morning'],
  stat: ['stat', 'immediately', 'at once', 'now', 'single dose', 'once only'],
  prn: ['prn', 'as needed', 'as required', 'when required', 'when needed', 'sos', 'if needed'],
};
const undotted = (text: unknown): string => normText(text).replace(/\./g, '').replace(/\s+/g, ' ').trim();
const FREQUENCY_LOOKUP = new Map<string, string>();
for (const [code, spellings] of Object.entries(FREQUENCY_TABLE)) {
  for (const spelling of spellings) {
    FREQUENCY_LOOKUP.set(undotted(spelling), code);
    FREQUENCY_LOOKUP.set(undotted(spelling).replace(/ /g, ''), code);
  }
}

export function normFrequency(value: unknown): string {
  const text = undotted(value);
  if (!text) return '';
  return FREQUENCY_LOOKUP.get(text) ?? FREQUENCY_LOOKUP.get(text.replace(/ /g, '')) ?? text;
}

/** A duration: "x5/7", "5/7", "for 5 days" all read as "5/7"; weeks as "/52". */
export function normDuration(value: unknown): string {
  const text = normText(value).replace(/^(?:x|for)\s*/, '');
  const days = /^(\d+)\s*(?:days?|\/7)$/.exec(text);
  if (days) return `${days[1]}/7`;
  const weeks = /^(\d+)\s*(?:weeks?|wks?|\/52)$/.exec(text);
  if (weeks) return `${weeks[1]}/52`;
  return text.replace(/\s+/g, '');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** 1 for identical strings, 0 for nothing in common (1 - edit distance / longer length). */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Words and numbers: letter runs and number runs ("2.5", "80/480" -> "80", "480"), lower case. ".5" is "0.5". */
export function tokens(value: unknown): string[] {
  return leadingZero(normText(value)).match(/\d+(?:\.\d+)?|[a-zÀ-ɏ]+/g) ?? [];
}

/** A word token matches another: numbers exactly, words allowing small OCR slips. */
export function tokenMatches(want: string, have: string): boolean {
  if (want === have) return true;
  if (/\d/.test(want) || /\d/.test(have)) return false;
  const allowed = want.length >= 8 ? 2 : want.length >= 4 ? 1 : 0;
  return allowed > 0 && Math.abs(want.length - have.length) <= allowed && levenshtein(want, have) <= allowed;
}

/**
 * Whether a value is written in the given lines: every one of its tokens is found, in order, within one window of
 * up to three consecutive lines. Numbers must match exactly; words may differ by one letter (two for 8 or more).
 */
export function onPage(value: unknown, pageLines: readonly string[], windowSize = 3): boolean {
  const want = tokens(value);
  if (want.length === 0) return true;
  const lineTokens = pageLines.map((line) => tokens(line));
  for (let start = 0; start < lineTokens.length; start += 1) {
    const have = lineTokens.slice(start, start + windowSize).flat();
    let position = 0;
    let ok = true;
    for (const token of want) {
      while (position < have.length && !tokenMatches(token, have[position] as string)) position += 1;
      if (position >= have.length) { ok = false; break; }
      position += 1;
    }
    if (ok) return true;
  }
  return false;
}

/** Token overlap (Jaccard) between two texts. */
export function overlap(a: unknown, b: unknown): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Longest word compared with edit distance; longer words must match exactly (keeps each comparison bounded). */
const MAX_FUZZY_WORD = 40;

/** A comparison allowance shared by many onPrepared calls; when it runs out the answer is "not checked". */
export interface MatchBudget { left: number }

/**
 * The lines tokenised once, as the flat token list of every window of up to `windowSize` consecutive lines, so
 * many values can be looked for in one text without tokenising it again for each.
 */
export function prepareLines(pageLines: readonly string[], windowSize = 3): string[][] {
  const lineTokens = pageLines.map((line) => tokens(line));
  return lineTokens.map((_, start) => lineTokens.slice(start, start + windowSize).flat());
}

/**
 * onPage over prepareLines output, counting every token comparison against `budget`. A value with no tokens is
 * not found (it cannot be evidence). Returns null when the budget ran out before an answer.
 */
export function onPrepared(want: readonly string[], windows: readonly string[][],
  budget: MatchBudget): boolean | null {
  if (want.length === 0) return false;
  for (const have of windows) {
    let position = 0;
    let ok = true;
    for (const token of want) {
      while (position < have.length) {
        if (budget.left <= 0) return null;
        budget.left -= 1;
        const candidate = have[position] as string;
        if (token === candidate || (token.length <= MAX_FUZZY_WORD && candidate.length <= MAX_FUZZY_WORD
          && tokenMatches(token, candidate))) break;
        position += 1;
      }
      if (position >= have.length) { ok = false; break; }
      position += 1;
    }
    if (ok) return true;
  }
  return false;
}
