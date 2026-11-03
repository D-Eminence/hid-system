// Normalisation used by the scorer. Documented in README.md ("How the score is worked out").

/** Lower case, Unicode-compatible forms (µ -> μ etc.), one space between words, no surrounding punctuation. */
export function normText(value) {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKC').toLowerCase().replace(/[µμ]/g, 'u')
    .replace(/\s+/g, ' ').trim().replace(/^[\s.,;:()\-]+|[\s.,;:()\-]+$/g, '');
}

const FORM_WORDS = new Set(['tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules', 'inj', 'injection',
  'syr', 'syrup', 'susp', 'suspension', 'mist', 'inh', 'inhaler', 'iv', 'im', 'po', 'sc', 'cream', 'oint', 'supp']);

/** A medicine name: normText, hyphens and slashes as spaces, a leading dosage form or route dropped. */
export function normName(value) {
  const words = normText(value).replace(/[-/]+/g, ' ').replace(/[.,]/g, ' ').split(' ').filter(Boolean);
  while (words.length > 1 && FORM_WORDS.has(words[0])) words.shift();
  return words.join(' ');
}

const UNIT_ALIASES = [
  [/(?<![a-z])(?:mcg|ug|microgram|micrograms)(?![a-z])/g, 'mcg'],
  [/(?<![a-z])(?:mg|mgs|milligram|milligrams)(?![a-z])/g, 'mg'],
  [/(?<![a-z])(?:g|gm|gms|gram|grams)(?![a-z])/g, 'g'],
  [/(?<![a-z])(?:ml|mls|millilitre|millilitres|milliliter|milliliters)(?![a-z])/g, 'ml'],
  [/(?<![a-z])(?:iu|units?)(?![a-z])/g, 'iu'],
  [/(?<![a-z])(?:tabs?|tablets?)(?![a-z])/g, 'tab'],
  [/(?<![a-z])(?:caps?|capsules?)(?![a-z])/g, 'cap'],
];

/** A strength: normText, unit spellings unified, no space between a number and its unit ("5 mg" == "5mg"). */
export function normStrength(value) {
  let text = normText(value);
  for (const [pattern, unit] of UNIT_ALIASES) text = text.replace(pattern, unit);
  return text.replace(/(\d)\s+(?=[a-z])/g, '$1').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');
}

/**
 * How often, mapped to one code. The table is the documented mapping: any spelling on the left counts as the
 * code on the right. Dots and spaces inside an abbreviation are ignored ("b.d." == "bd", "t d s" == "tds").
 */
export const FREQUENCY_TABLE = {
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
const FREQUENCY_LOOKUP = new Map();
const undotted = (text) => normText(text).replace(/\./g, '').replace(/\s+/g, ' ').trim();
for (const [code, spellings] of Object.entries(FREQUENCY_TABLE)) {
  for (const spelling of spellings) {
    FREQUENCY_LOOKUP.set(undotted(spelling), code);
    FREQUENCY_LOOKUP.set(undotted(spelling).replace(/ /g, ''), code);
  }
}

export function normFrequency(value) {
  const text = undotted(value);
  if (!text) return '';
  return FREQUENCY_LOOKUP.get(text) ?? FREQUENCY_LOOKUP.get(text.replace(/ /g, '')) ?? text;
}

/** A duration: "x5/7", "5/7", "for 5 days" all read as "5/7"; weeks as "/52". */
export function normDuration(value) {
  const text = normText(value).replace(/^(?:x|for)\s*/, '');
  const days = /^(\d+)\s*(?:days?|\/7)$/.exec(text);
  if (days) return `${days[1]}/7`;
  const weeks = /^(\d+)\s*(?:weeks?|wks?|\/52)$/.exec(text);
  if (weeks) return `${weeks[1]}/52`;
  return text.replace(/\s+/g, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** 1 for identical strings, 0 for nothing in common (1 - edit distance / longer length). */
export function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Words and numbers: letters runs and number runs ("2.5", "80/480" -> "80", "480"), lower case. */
export function tokens(value) {
  return normText(value).match(/\d+(?:\.\d+)?|[a-zÀ-ɏ]+/g) ?? [];
}

/** A word token from a value matches a token on the paper: numbers exactly, words allowing small OCR slips. */
export function tokenMatches(want, have) {
  if (want === have) return true;
  if (/\d/.test(want) || /\d/.test(have)) return false;
  const allowed = want.length >= 8 ? 2 : want.length >= 4 ? 1 : 0;
  return allowed > 0 && Math.abs(want.length - have.length) <= allowed && levenshtein(want, have) <= allowed;
}

/**
 * Whether a value is written on the page: every one of its tokens is found, in order, within one window of
 * up to three consecutive lines of the key's page text. Numbers must match exactly; words may differ by one
 * letter (two for words of 8 letters or more).
 */
export function onPage(value, pageLines, windowSize = 3) {
  const want = tokens(value);
  if (want.length === 0) return true;
  const lineTokens = pageLines.map((line) => tokens(line));
  for (let start = 0; start < lineTokens.length; start += 1) {
    const have = lineTokens.slice(start, start + windowSize).flat();
    let position = 0;
    let ok = true;
    for (const token of want) {
      while (position < have.length && !tokenMatches(token, have[position])) position += 1;
      if (position >= have.length) { ok = false; break; }
      position += 1;
    }
    if (ok) return true;
  }
  return false;
}

/** Token overlap (Jaccard) between two texts. */
export function overlap(a, b) {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}
