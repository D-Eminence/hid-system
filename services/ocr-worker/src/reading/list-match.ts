/**
 * The strict matching shared by the reading lists (drug-list.ts, diagnosis-list.ts, lab-list.ts). A list only ever
 * checks, and respells, a name the model itself proposed; it never adds one. Pure functions; nothing is logged.
 *
 * Exact first (each list says how it normalises a name). Otherwise a fuzzy match corrects one slip of the pen or of
 * the reading, never a different entry: a name of MIN_FUZZY_LETTERS letters or more matches a listed key at an edit
 * distance of at most MAX_EDIT_DISTANCE (one character added, dropped or changed), a similarity ratio
 * (1 - distance / longer length) of at least MIN_SIMILARITY, the same first character, and the same short words
 * (words of fewer than SHORT_WORD letters, such as "b12", "c", "1", "+", "-ve") and the same digits: a respelling
 * never changes "vitamin c" into "vitamin e", "type 1" into "type 2" or "hepatitis b" into "hepatitis c". Two
 * different targets matching equally well is no match (ambiguous): the screen never picks one of two look-alikes.
 * Tested in list-match.spec.ts, which also proves that no two entries of a list are within this threshold of each
 * other.
 */
export const MIN_FUZZY_LETTERS = 6;
export const MAX_EDIT_DISTANCE = 1;
export const MIN_SIMILARITY = 0.85;
/** How near a name may be to a known unlisted look-alike before a fuzzy match is refused (drug-list.ts). */
export const LOOKALIKE_DISTANCE = 2;
/** Words shorter than this must be the same in a fuzzy match. */
export const SHORT_WORD = 4;

export function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(above + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

/** The number of letters a to z in a normalised key. */
export const letterCount = (text: string) => text.replace(/[^a-z]/g, '').length;
const digits = (text: string) => text.replace(/\D/g, '');
const shortWords = (text: string) => text.split(' ').filter((word) => word.length > 0 && word.length < SHORT_WORD).sort().join(' ');

/** The edit distance between two normalised keys when one may be a fuzzy correction of the other, else null. */
export function fuzzyDistance(name: string, key: string): number | null {
  if (letterCount(name) < MIN_FUZZY_LETTERS || letterCount(key) < MIN_FUZZY_LETTERS) return null;
  if (digits(name) !== digits(key) || shortWords(name) !== shortWords(key)) return null;
  const distance = editDistance(name, key);
  const similarity = 1 - distance / Math.max(name.length, key.length);
  return distance <= MAX_EDIT_DISTANCE && similarity >= MIN_SIMILARITY ? distance : null;
}

/** Whether one key is within the fuzzy threshold of the other (the first-character rule included). */
export function withinFuzzyThreshold(a: string, b: string): boolean {
  return a !== b && a.charAt(0) === b.charAt(0) && fuzzyDistance(a, b) !== null;
}

export interface ListEntry<T> { key: string; target: string; value: T }

/**
 * The closest entry to any of the candidate names (normalised the way the list's keys are) within the fuzzy
 * threshold, or null: null where none is near, where two entries with different targets are equally near
 * (ambiguous), or where the closest starts with another character.
 */
export function fuzzyListMatch<T>(candidates: readonly string[], entries: readonly ListEntry<T>[]):
  { entry: ListEntry<T>; name: string } | null {
  let best: { entry: ListEntry<T>; distance: number; name: string } | null = null;
  let ambiguous = false;
  for (const name of candidates) {
    for (const entry of entries) {
      const distance = fuzzyDistance(name, entry.key);
      if (distance === null) continue;
      if (best === null || distance < best.distance) { best = { entry, distance, name }; ambiguous = false; }
      else if (distance === best.distance && entry.target !== best.entry.target) ambiguous = true;
    }
  }
  if (best === null || ambiguous || best.name.charAt(0) !== best.entry.key.charAt(0)) return null;
  return { entry: best.entry, name: best.name };
}

/**
 * A handwritten sign the hard-page prompt could not read with confidence ("[sign?]"), an unreadable stretch (the old
 * "[unreadable]", or "[?]", writing with no letter shapes), or a sign the model read and wrote as its meaning
 * ("alternate (sign)"): a list never matches a name holding one, so a sign or a gap is never turned into a listed
 * name.
 */
export const NOT_FOR_LISTS = /\[unreadable\]|\[\?\]|\[sign\?\]|\(sign\)/i;
