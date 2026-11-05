/**
 * Handwritten signs that stand for words (owner decision of 2026-11-05, about 21:00 UTC, relayed by the coordinator:
 * doctors write signs that mean words; the owner's example is two strokes pointing opposite ways, like a zigzag or
 * "⇌", meaning "alternate"). No picture of a sign is kept anywhere: each is described in words here.
 *
 * The hard-page prompt (prompt.ts hardPageMessage, rule I) gives the model this table. A sign from the table is
 * written as its meaning followed by "(sign)" ("alternate (sign) days"), so the screen shows both that a sign was
 * read and what it was read as; any other mark that may be a sign, or a sign the model is not sure of, is written
 * "[sign?]", never a guessed word. Code never expands a sign or "[sign?]" itself: it only marks the item
 * (sign_read, hard-page.ts) and keeps lists and checks from treating the marks as words (list-match.ts,
 * grounding.ts). Sources for each meaning are in the README ("Handwritten signs").
 */

/** What the model writes for a sign it read from the table: the meaning, then this. */
export const SIGN_READ_MARK = '(sign)';
/** What the model writes for a sign it could not read, or one not in the table. */
export const SIGN_UNSURE = '[sign?]';

/** A sign the hard-page prompt may read: how it looks (in words) and what it is written as. */
export interface SignEntry { looks: string; meaning: string }

export const SIGN_TABLE: readonly SignEntry[] = [
  { looks: 'two short strokes or arrows pointing opposite ways, one above the other, like a zigzag or "⇌"',
    meaning: '"alternate" (as in alternate days)' },
  { looks: 'a "c" with a bar over it ("c̄")', meaning: '"with"' },
  { looks: 'an "s" with a bar over it ("s̄")', meaning: '"without"' },
  { looks: 'an arrow pointing up ("↑")', meaning: '"increased" (raised)' },
  { looks: 'an arrow pointing down ("↓")', meaning: '"decreased" (low)' },
  { looks: 'a triangle ("Δ")', meaning: '"diagnosis"' },
  { looks: '"#" written before a bone or a part of the body (such as "# femur")',
    meaning: '"fracture"; "#" before a number ("#30") is a count, not this sign: copy it as written' },
  { looks: 'a tick ("✓")',
    meaning: '"done" where its printed heading or label is for something done or given, "present" where it is for '
      + 'a finding; where no heading or label says which, "[sign?]"' },
  { looks: 'a cross ("✗") standing alone in a box or after a label',
    meaning: '"not done" where its heading or label is for something done or given, "absent" where it is for a '
      + 'finding; where no heading or label says which, "[sign?]". A line or cross through writing is a crossing-out, '
      + 'not this sign' },
];

/**
 * Abbreviations written in letters and numbers: never a "(sign)", always copied as written (rule B); the table helps
 * the model read hard letters. Frequencies are the codes of rule D.
 */
export const ABBREVIATION_TABLE: ReadonlyArray<readonly [written: string, meaning: string]> = [
  ['Hx', 'history'], ['Rx', 'treatment (prescription)'], ['stat', 'at once'], ['prn', 'when needed'],
  ['od', 'once a day'], ['bd', 'twice a day'], ['tds', 'three times a day'], ['qds', 'four times a day'],
  ['nocte', 'at night'], ['mane', 'in the morning'],
  ['n/7 (the 7 sometimes with a small circle, "°/7")', 'n days'], ['n/52', 'n weeks'], ['n/12', 'n months'],
];

/** Whether a text holds a sign the model read ("(sign)") or could not read ("[sign?]"). */
export function hasSign(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.includes(SIGN_READ_MARK) || text.includes(SIGN_UNSURE);
}
