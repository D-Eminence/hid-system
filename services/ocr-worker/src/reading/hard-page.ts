import type { FlagReason, PaperItem } from './contract';
import { diagnosisLookalike, matchDiagnosisName, type ListMatch } from './diagnosis-list';
import { DRUG_ENTRIES, drugLookalike, editDistance, LOOKALIKE_DISTANCE, matchDrugName, MIN_FUZZY_LETTERS,
  normaliseDrugName, type DrugMatch, UNLISTED_LOOKALIKES } from './drug-list';
import { CROSSED_OUT_START, crossedOutParts, withoutCrossedOut } from './grounding';
import { checkReasonSentence, crossedOutOnPlace, itemId, markCrossedOut, mergeIdentity, overlapShare, PAIR_BOX_OVERLAP,
  unionBox, uniqueItemIds, type PageCheck } from './items';
import { labTestLookalike, matchLabTestName } from './lab-list';
import { SHORT_WORD } from './list-match';
import { ALTERNATIVE_OPEN, CROSSED_OUT_OPEN, FIELD_UNREAD, HARD_PAGE_FREQUENCIES, NO_LETTERS, PAPER_QUERY,
  PARTIAL_WORD, type BasisField, type FieldBasis, type HardItemExtras, type ModelItem, type ModelPage } from './prompt';
import { hasSign, SIGN_READ_MARK } from './signs';

export { PAIR_BOX_OVERLAP };

/**
 * Hard pages (owner decision of 2026-11-05, about 18:40 UTC): a page flagged handwriting or low_confidence that goes
 * to the image re-read is read twice, with the same best-guess request (prompt.ts hardPageMessage), and the two
 * readings are compared here. Everything here is codes, counts and the page's own readings: nothing is logged.
 *
 * Clean reading (owner decision of 2026-11-06, about 10:13 UTC, relayed by the coordinator: "i want the output clean
 * ... doctor no get time", after comparing with a chat reading of the same fictional page that gave rows like
 * "IV Flagyl? 500mg? 8hrly?", "Transfer to the ward", "Switch to IV Ceftriaxone 1g"): a best guess for every word,
 * "?" straight after each uncertain one, and the item's plain reading (what the check screen shows as the item) is
 * the reading itself, never a sentence about it. The tokens (prompt.ts): "[?]" (NO_LETTERS) only for writing with no
 * letter shapes at all; "(? on paper)" (PAPER_QUERY) for a question mark written on the paper; "A? (or B?)" where the
 * two readings differ; "(crossed out: X?)" for struck-out writing on its item. Nothing becomes "[?]" because the
 * readings disagree, and a drug name not on the list is shown as read with "?" (before, "[unreadable]"): safety
 * rests on every hard-page item being check_carefully, so a person keeps or changes each one. Since the owner's
 * chat transcripts (hard-page prompt 7/8): "Am…" for a word whose letters trail off (PARTIAL_WORD; never matched to
 * a list or completed, a bracketed whole-word guess always marked "?"), and "[route?]", "[drug?]", "[dose?]",
 * "[freq?]" (FIELD_UNREAD) for one part of a readable order that shows no letter shapes, so the line is kept.
 *
 * The shown text (re-review of 2026-11-06): building it from the fields kept dropping or contradicting written words
 * (a second dose, a taper, another drug on the line, "(? on paper)"), so it is now asWritten itself, word by word,
 * annotated where each field stands (displayOf): the generic after a listed brand, a list respelling as
 * "Respelled? (generic)", "?" on a field guessed from context, a certain frequency in words. The fields stay
 * structured data for the payload. A medicine whose shown text stops, holds or changes it (STATUS_WORDS), or whose
 * two readings differ on what to do with it, has status unknown.
 *
 * 1. prepareHardAnswer, on each answer before it is held to the page: the old "[unreadable]" becomes "[?]"; an
 *    item with text that looks like a description of the writing ("handwritten entry that cannot be read";
 *    isDescription, a few obvious reader phrases) is flagged description_suspected, its text kept exactly as read
 *    (review of 2026-11-06: replacing it lost clinicians' notes about handwriting); an item crossed out as a whole
 *    (nothing live outside its crossed-out writing, its crossedOut holding the whole reading, or no live drug name
 *    outside it: wholeCrossedOut) becomes a note (never an active medicine); the model's plain is dropped (built in
 *    finish). Each word asWritten marks "?" is marked in the fields that hold it (carryMarks, whole
 *    words only), so the payload's fields keep every guess. Frequency is one of HARD_PAGE_FREQUENCIES where it is
 *    one ("?" kept), else as read with every word marked; dose a number where it is one, else as read (marked where
 *    written in words); strength rebuilt from dose and unit ("500mg?"), with the model's own strength as the other
 *    option where it says another number ("500mg? (or 400mg?)"), and its "?" kept where the rebuilt one has none.
 *    A name holding a word cut short is never checked against a list. The drug name is checked against the
 *    drug list (drug-list.ts): a listed name is shown in its list spelling (a brand as "Brand (generic)"), with "?"
 *    where the model was unsure, the name came from context or the list respelled it; a name near a real unlisted
 *    look-alike is shown as read with the listed one as the other option, "Arteether? (or Artemether?)"; any other
 *    name is shown as read, every word with "?". asWritten keeps what the model read, marks and all. Every filled
 *    text field whose basis is "context" gets "?" in the field itself (markGuess, GUESSABLE_TEXT_FIELDS).
 * 2. Each answer is held to the page by checkPage (items.ts), unchanged: #194's placement rules apply to every item.
 *    Every check is made with the "?" marks and crossed-out writing taken off (grounding.ts forMatching).
 * 3. mergeHardReadings pairs the kept items of the two readings and keeps what they agree on; where they differ,
 *    read A's guess is shown with read B's after it, "A? (or B?)" (see pair), at most one other option per field and
 *    never one inside another (alternatives, mergeAsWritten, limitAlternatives; cleanup of 2026-11-10). Two
 *    medicines paired by place whose readings name different drugs (sameDrug) are two items, one per reading
 *    (splitPair). Headings and notes repeating an order are left out later, on every page (tidy.ts).
 * 4. Each kept item (finish): a diagnosis name and a lab test name are grounded to their lists (diagnosis-list.ts:
 *    ICD-11 titles and our own synonyms; lab-list.ts: our own test names): a listed one is shown as read with the
 *    listed name after it ("HTN? (Hypertensive diseases)"), or as read where it is the listed name; one near an
 *    unlisted look-alike as "As read? (or Listed?)"; any other is left as read. This comes after the checks and the
 *    comparison of the two readings, so both are made on the names as read. The plain reading is asWritten
 *    annotated in place (displayOf). An item holding a handwritten sign mark gets sign_read; one with crossed-out
 *    writing crossed_out; one with a "?" from the letters unsure_from_letters (kept apart from the code
 *    field_from_context).
 * 5. Crossed out, line by line (markStruckLines; review of 2026-11-06: matching struck names to orders kept missing
 *    cases): any crossed-out writing either reading shows makes every medicine on that line or over that place status
 *    unknown and crossed_out, with readings_disagree where only the other reading shows it. No name is matched.
 *    mergeReread (items.ts) applies the same rule with the first pass.
 * The result is then merged with the first pass by mergeReread, unchanged, so no first-pass item is lost.
 */

/** Reason codes added to hard-page items (sentences in items.ts REASON_SENTENCES). */
export const BEST_GUESS = 'best_guess_from_picture';
export const FROM_CONTEXT = 'field_from_context';
export const SINGLE_READING = 'single_reading_only';
export const READINGS_DISAGREE = 'readings_disagree';
/** A handwritten sign read as its meaning ("(sign)") or not read ("[sign?]") anywhere in the item (signs.ts). */
export const SIGN_READ = 'sign_read';
/** Writing crossed out on the paper, shown "(crossed out: X)" on the item. */
export const CROSSED_OUT = 'crossed_out';
/**
 * Some text of the item looks like a sentence about the writing instead of a reading of it (isDescription): flagged
 * only, the text is shown exactly as read.
 */
export const DESCRIPTION_SUSPECTED = 'description_suspected';
/**
 * Some of the item is marked uncertain from the shapes of its letters: a word with "?" that no field filled from
 * context holds, a word cut short ("Am…"), "[?]" or a field placeholder ("[dose?]"). Kept apart from
 * field_from_context (a field guessed from where it sits or what is usual), though the website shows both as "?".
 */
export const UNSURE_LETTERS = 'unsure_from_letters';
/**
 * Words that say an order is stopped, held or changed: a medicine showing one has status unknown (finish). Matched on
 * the word with its "?" and punctuation off, lower case; a clear abbreviation counts too ("Stp?", "Discont.", "Canx").
 */
export const STATUS_WORDS = new RegExp('^(?:stops?|stopped|stopping|stp|hold|holding|held|withhold|withholding|withheld'
  + '|omit|omitted|discont\\p{L}*|disc|d/c|dc|cease|ceased|ceasing|suspend|suspended|cancel|cancels|cancell?ed'
  + '|cancell?ing|canx|withdraw|withdrawn|withdrawing|withdrew|off|halt|halted|switch|switched|change|changed'
  + '|convert|converted)$', 'u');
/**
 * Other words that say what to do with an order: two readings differing on one (or on a STATUS_WORDS word) make its
 * status unknown.
 */
export const INSTRUCTION_WORDS = new RegExp('^(?:start|started|commence|commenced|continue|continued|cont|restart|restarted'
  + '|resume|resumed|reduce|reduced|increase|increased|taper|wean|give|given)$');

const ALLOWED_FREQUENCIES = new Set<string>(HARD_PAGE_FREQUENCIES);
/** Marks holding a "?" that is not the reading's uncertainty: a query on the paper, no letter shapes, a sign not read. */
const NOT_GUESS_MARKS = /\(\? on paper\)|\[\?\]|\[sign\?\]|\[(?:route|drug|dose|freq)\?\]/g;
const guessMarks = (text: string) => text.replace(NOT_GUESS_MARKS, ' ').match(/\?/g)?.length ?? 0;
const unsure = (text: string) => guessMarks(text) > 0;
/** Whether a text has a letter or digit outside the reading marks (else it is only "[?]", "[sign?]" or the like). */
const hasLetters = (text: string) => /[\p{L}\p{N}]/u.test(text.replace(NOT_GUESS_MARKS, ' ').replace(/\(sign\)/g, ' '));
/** A reading's text without its "?" marks, normalised (case, spacing, "5 mg" = "5mg"), for comparing two readings. */
export const bare = (text: string | null | undefined) => (text ?? '').replace(/\?/g, ' ').replace(/\s+/g, ' ')
  .replace(/\s+([)\]])/g, '$1').trim().toLowerCase().replace(/(\d)\s+(?=\p{L})/gu, '$1');
/**
 * The old "[unreadable]" (hard-page prompt 2 to 4) as the clean token "[?]"; a crossed-out group in any case or
 * spacing ("(Crossed out:X)") as CROSSED_OUT_OPEN, so every check sees one form, and one with nothing inside as
 * "(crossed out: [?])"; "[frequency?]" as "[freq?]"; a word cut
 * short written with ASCII dots ("Amox...", "Amox..") as the partial-word mark ("Amox…"), so it is never marked
 * "Amox?..." or matched to a list.
 */
const cleanTokens = (text: string) => text.replace(/\[unreadable\]/gi, NO_LETTERS)
  .replace(new RegExp(`${CROSSED_OUT_START.source}\\s*`, 'gi'), CROSSED_OUT_OPEN)
  .replace(/\(crossed out: \s*\)/g, `${CROSSED_OUT_OPEN}${NO_LETTERS})`)
  .replace(/\[frequency\?\]/gi, FIELD_UNREAD.frequency)
  .replace(/(\p{L})\.{2,3}(?=[\s)\]]|$)/gu, `$1${PARTIAL_WORD}`);
/** A reading mark that is one word on its own: "[?]", "[sign?]", "(? on paper)", "(sign)" or a field placeholder. */
const isMarkToken = (word: string) => word === SIGN_READ_MARK || word === PAPER_QUERY
  || /^\[(?:\?|sign\?|route\?|drug\?|dose\?|freq\?)\]$/.test(word);
/** A word cut short ("Am…"): never marked, matched to a list or completed in code. */
const isPartial = (word: string) => word.includes(PARTIAL_WORD);

/**
 * A text split into words, a bracketed group ("(metronidazole)", "(? on paper)", "(crossed out: 400mg?)", "[?]",
 * "[sign?]") counting as one word even with spaces inside.
 */
function words(text: string): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index]!)) { index += 1; continue; }
    let end = index;
    if (text[index] === '(' || text[index] === '[') {
      let depth = 0;
      for (; end < text.length; end += 1) {
        if (text[end] === '(' || text[end] === '[') depth += 1;
        else if (text[end] === ')' || text[end] === ']') { depth -= 1; if (depth === 0) { end += 1; break; } }
      }
    } else {
      while (end < text.length && !/\s/.test(text[end]!)) end += 1;
    }
    out.push(text.slice(index, end));
    index = end;
  }
  return out;
}

/**
 * Every word of the text marked a guess: "?" after each word or number that has none yet ("Ceftriaxone 1g" is
 * "Ceftriaxone? 1g?"), before any trailing punctuation. A bracketed group (a listed generic, a reading mark) and a
 * word already holding a "?" are left as they are.
 */
export function markWords(text: string): string {
  return words(text).map((word) => /^[([]/.test(word) || word.includes('?') || isPartial(word)
    || !/[\p{L}\p{N}]/u.test(word) ? word : word.replace(/([.,;:]*)$/, '?$1')).join(' ');
}

/**
 * A guess for the whole of a word cut short, in brackets after it ("Pl… (Plasil?)", or "Pl… (or Ph…) (Plasil?)"),
 * marked "?" word by word where the model left it unmarked: it is only ever a guess.
 */
export function markPartialGuesses(text: string): string {
  if (!text.includes(PARTIAL_WORD)) return text;
  let afterPartial = false;
  return words(text).map((word) => {
    if (isPartial(word) && (!isGroup(word) || word.startsWith(ALTERNATIVE_OPEN))) { afterPartial = true; return word; }
    const guess = afterPartial && word.startsWith('(') && !word.startsWith(ALTERNATIVE_OPEN)
      && !word.startsWith(CROSSED_OUT_OPEN) && !isMarkToken(word);
    afterPartial = false;
    return guess ? `(${markWords(word.slice(1, -1).trim())})` : word;
  }).join(' ');
}

/**
 * A tally of the other options left out because a field shows at most one (owner/coordinator cleanup of 2026-11-10,
 * about 20:30 UTC). A count only, for the completion log (HardPageAgreement.alternativesDropped).
 */
export interface AlternativeDrops { count: number }

/**
 * How strong an other option is, for choosing the one a field shows (alternatives): compared element by element,
 * higher first; ties keep the order the options were offered in.
 */
export type AlternativeScore = (candidate: string, source: 'other' | 'own') => readonly number[];

/** A text's own reading and its other option, "A? (or B?)" as A and B (an other option holding one itself: its first). */
function optionsOf(text: string): [string, string | null] {
  const split = splitAlternative(text);
  if (!split) return [text, null];
  const [main] = optionsOf(split[0]);
  const [other] = optionsOf(split[1]);
  return [main, isBlank(other) ? null : other];
}

/**
 * The closeness of two texts by their letters and digits, 0 to 1 (1 the same): the "closest by fuzzy" step of the
 * choice of an other option.
 */
export function closeness(x: string, y: string): number {
  const a = wordKey(bare(x));
  const b = wordKey(bare(y));
  if (!a && !b) return 1;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

/**
 * Two readings of one field: "A? (or B?)", every word of both marked a guess; the one with letter shapes first where
 * the other has none; one alone (marked) where the other is blank. The rendering of a disagreement (pair).
 *
 * At most ONE other option (cleanup of 2026-11-10): where either reading already holds an other option of its own
 * ("Arteether? (or Artemether?)", "500mg? (or 400mg?)"), the field shows A's own reading and the strongest option of
 * the other reading: B's reading, B's own other option or A's own other option, whichever ranks first by `score`
 * (in pair: read from the letters before from context, on the list or grounded before not, then the other read's
 * before A's own, then closest to A by its letters; ties: the other read's first, in the order offered). So A's own
 * option is shown only where it is stronger (letters or listed) than every option of the other read, or where the
 * other read offers nothing different (review of 2026-11-10). An other option never holds one itself. Each option
 * left out is counted in `drops` (the readings_disagree code stays on the item).
 */
export function alternatives(first: string | null, second: string | null,
  options: { score?: AlternativeScore; drops?: AlternativeDrops } = {}): string {
  if (isBlank(second)) return isBlank(first) ? (first ?? '') : markWords(oneOption(first!, options.drops));
  if (isBlank(first)) return markWords(oneOption(second!, options.drops));
  const [a, b] = !hasLetters(first!) && hasLetters(second!) ? [second!, first!] : [first!, second!];
  const [main, ownOther] = optionsOf(a);
  const [otherMain, otherOther] = optionsOf(b);
  const differs = (option: string | null): option is string => option !== null && !isBlank(option)
    && bare(option) !== bare(main);
  const fromOther = [otherMain, otherOther].filter(differs);
  const own = [ownOther].filter(differs);
  // One pool, ranked by `score`; on a tie the other read's options first (in the order offered), then A's own.
  const pool = [...fromOther.map((candidate) => ({ candidate, source: 'other' as const })),
    ...own.filter((candidate) => !fromOther.some((other) => bare(other) === bare(candidate)))
      .map((candidate) => ({ candidate, source: 'own' as const }))];
  // Every distinct option offered that is not shown is counted once.
  const offered = [...new Set([...fromOther, ...own].map(bare))];
  if (pool.length === 0) return markWords(main);
  const ranked = pool.map((entry, index) => ({ ...entry, index, rank: options.score?.(entry.candidate, entry.source) ?? [] }))
    .sort((x, y) => {
      for (let at = 0; at < Math.max(x.rank.length, y.rank.length); at += 1) {
        const diff = (y.rank[at] ?? 0) - (x.rank[at] ?? 0);
        if (diff !== 0) return diff;
      }
      return x.index - y.index;
    });
  const chosen = ranked[0]!.candidate;
  if (options.drops) options.drops.count += offered.filter((key) => key !== bare(chosen)).length;
  return `${markWords(main)} ${ALTERNATIVE_OPEN}${markWords(chosen)})`;
}

/** A text with at most one other option: "A (or B (or C))" or "A (or B) (or C)" as "A (or B)", the rest counted. */
function oneOption(text: string, drops?: AlternativeDrops): string {
  if (!text.includes(ALTERNATIVE_OPEN)) return text;
  return limitAlternatives(text, drops);
}

/**
 * The shown text with at most one other option in a row and none inside another (cleanup of 2026-11-10): a "(or
 * …)" group straight after another is left out, and a "(or …)" inside one is taken out of it. Each counted in
 * `drops`. The guard on every shown text; the choice of the option happens before (alternatives, mergeAsWritten).
 */
export function limitAlternatives(text: string, drops?: AlternativeDrops): string {
  const out: string[] = [];
  for (const word of words(text)) {
    if (word.startsWith(ALTERNATIVE_OPEN)) {
      if (out.length > 0 && out[out.length - 1]!.startsWith(ALTERNATIVE_OPEN)) {
        if (drops) drops.count += 1;
        continue;
      }
      const inner = word.slice(ALTERNATIVE_OPEN.length, -1);
      if (inner.includes(ALTERNATIVE_OPEN)) {
        const kept = words(inner).filter((part) => {
          const nested = part.startsWith(ALTERNATIVE_OPEN);
          if (nested && drops) drops.count += 1;
          return !nested;
        });
        out.push(`${ALTERNATIVE_OPEN}${limitAlternatives(kept.join(' '), drops)})`);
        continue;
      }
    }
    out.push(word);
  }
  return out.join(' ');
}

/** "A (or B)" split into A and B where the text ends with an alternative (alternatives), else null. */
export function splitAlternative(text: string): [string, string] | null {
  if (!text.endsWith(')')) return null;
  let depth = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] === ')') depth += 1;
    else if (text[index] === '(') {
      depth -= 1;
      if (depth === 0) {
        if (index === 0 || !text.startsWith(ALTERNATIVE_OPEN, index)) return null;
        return [text.slice(0, index).trim(), text.slice(index + ALTERNATIVE_OPEN.length, -1).trim()];
      }
    }
  }
  return null;
}

/**
 * Whether a text looks like the reader describing the writing instead of reading it ("Handwritten treatment entry
 * that cannot be read; check the paper"). Non-destructive (review of 2026-11-06): it only adds description_suspected
 * and check_carefully, and the text is shown exactly as read, so a miss costs only a flag and a clinician's note that
 * matches ("Dysgraphia: handwriting that cannot be read") is never changed. Only obvious reader phrases match: "cannot
 * be read" with no subject or the writing as its subject, "illegible handwriting" and the like as the whole text, a
 * "handwritten ... entry", "check the paper" closing the text, and the writing as the subject of "appears to say".
 */
const DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /^\s*(?:(?:it|this)\s+)?(?:cannot|can ?not|can't|could ?not|couldn't)\s+be\s+(?:read|made out|deciphered)\b/i,
  /\b(?:handwriting|writing|entry|text)\s+(?:that|which)\s+(?:cannot|can ?not|can't|could ?not|couldn't)\s+be\s+(?:read|made out|deciphered)\b/i,
  /^\s*(?:illegible|unreadable|indecipherable)(?:\s+(?:handwriting|writing|entry|scribble))?\s*[.;:]?\s*$/i,
  /^\s*(?:handwriting|writing|entry)\s+(?:is\s+)?(?:illegible|unreadable|indecipherable)\s*[.;:]?\s*$/i,
  /\bhandwritten\s+(?:\p{L}+\s+){0,2}entry\b/iu,
  /(?:^|[;,.:]\s*)check\s+(?:it\s+)?(?:against\s+)?the\s+paper\s*[.;:]?\s*$/i,
  /^\s*(?:the\s+)?(?:hand)?writing\s+(?:appears|seems)\s+to\s+(?:say|read)\b/i,
];
export function isDescription(text: string): boolean {
  return DESCRIPTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * How often: one of HARD_PAGE_FREQUENCIES where it is one ("?" kept), "" where none is given, else as read, with the
 * model's own "?" marks ("alternate (sign) days", "x5/7"); "[unreadable]" is "[?]".
 */
export function normaliseFrequency(text: string): string {
  const written = cleanTokens(text).trim();
  if (written === '') return '';
  const compacted = written.toLowerCase().replace(/[\s.\-]/g, '').replace('hourly', 'hrly');
  const base = compacted.replace(/\?/g, '');
  return ALLOWED_FREQUENCIES.has(base) ? `${base}${unsure(compacted) ? '?' : ''}` : written;
}

/** A dose: a number where it is one ("400", "0.5"; "?" kept), "" where none is given, else as read ("1/2", "[?]"). */
export function normaliseDose(text: string): string {
  const written = cleanTokens(text).trim();
  const compacted = written.replace(/\s/g, '');
  const base = compacted.replace(/\?/g, '');
  if (base === '') return '';
  return /^\d+(?:\.\d+)?$/.test(base) ? `${base}${unsure(compacted) ? '?' : ''}` : written;
}

/**
 * A frequency that is none of the usual codes, or a dose written in words ("alternate days", "one"): every word
 * marked a guess, like a drug name not on the list (the codes and numbers are what a person can check at a glance).
 * A code, a number, "[?]" and the field placeholders are left as they are.
 */
function guessUnlisted(value: string, codes?: ReadonlySet<string>): string {
  if (isBlank(value) || !/\p{L}/u.test(value.replace(NOT_GUESS_MARKS, ' ').replace(/\(sign\)/g, ' '))) return value;
  if (codes?.has(value.replace(/\?+$/, ''))) return value;
  return markWords(value);
}

/** Units written straight after the number in the strength shown ("500mg", "1g"). */
const JOINED_UNITS = /^(?:mg|mcg|µg|ug|g|kg|ml|l|iu|u|%)$/i;

/**
 * The strength shown: dose and unit as read, a number and a metric unit written together with one "?" where either
 * is unsure ("500mg?", "1g"); "[?] mg" where a unit is read without its dose; "" where neither is given.
 */
export function strengthOf(dose: string, unit: string): string {
  const doseText = dose.trim();
  const unitText = unit.trim();
  if (!doseText && !unitText) return '';
  if (!doseText) return `${NO_LETTERS} ${unitText}`;
  if (!unitText) return doseText;
  const doseBare = doseText.replace(/\?+$/, '');
  const unitBare = unitText.replace(/\?+$/, '');
  if (/^\d+(?:\.\d+)?$/.test(doseBare) && JOINED_UNITS.test(unitBare)) {
    return `${doseBare}${unitBare}${doseBare !== doseText || unitBare !== unitText ? '?' : ''}`;
  }
  return `${doseText} ${unitText}`;
}

/**
 * A filled field whose basis is "context" (filled from what is usual, not read) carries "?" in the field itself, so
 * the guess shows where it is shown, whichever reason sentence the item gets.
 */
export function markGuess(value: string, basis: FieldBasis | undefined): string {
  if (basis !== 'context' || isBlank(value) || !hasLetters(value) || unsure(value)) return value;
  return `${value.trimEnd()}?`;
}

/**
 * The free-text fields of an answer item that become an item's text fields, of any kind, and so carry "?" when
 * their basis (basisKey) is "context". Not here: the enum fields (status, severity, measure, noKnownAllergies),
 * which cannot carry a mark and raise field_from_context instead (anyFromContext, pair); a medicine's strength,
 * rebuilt from its marked dose and unit; and the fields checkPage keeps only where they are written on the page
 * exactly (noteText, dateAsWritten, prescriberAsWritten, prescriptionDate), where a "?" would make it discard what
 * was read. A medicine's "unit" is not its dose unit (that is hard.doseUnit), so it is left to the dose.
 */
export const GUESSABLE_TEXT_FIELDS = ['name', 'form', 'route', 'frequency', 'duration', 'substance', 'reaction',
  'test', 'value', 'unit', 'referenceRange', 'flag'] as const;
/** Every free-text field of an answer item that a description or the old "[unreadable]" may be written in. */
const TEXT_FIELDS = [...GUESSABLE_TEXT_FIELDS, 'strength', 'noteText', 'dateAsWritten', 'prescriberAsWritten',
  'prescriptionDate'] as const;

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** A listed drug as shown: "Generic" or "Brand (generic)", with "?" after the name where it is a guess. */
function drugDisplay(match: DrugMatch, guess: boolean): string {
  const mark = guess ? '?' : '';
  return match.brand === null ? `${capitalise(match.generic)}${mark}` : `${capitalise(match.brand)}${mark} (${match.generic})`;
}

/** An item whose writing is all crossed out (rule G): a note holding the crossed-out writing, never an active item. */
function crossedOutNote(item: ModelItem): ModelItem {
  const empty = Object.fromEntries(TEXT_FIELDS.map((field) => [field, ''])) as Record<(typeof TEXT_FIELDS)[number], string>;
  return { ...item, ...empty, kind: 'note', noteText: item.asWritten, status: 'none', severity: 'none', measure: 'none',
    noKnownAllergies: false, dateAsWritten: item.dateAsWritten,
    hard: { ...item.hard!, dose: '', doseUnit: '' } };
}

/** A word's key for comparing words: its letters and digits, lower case ("Flagyl?," is "flagyl"). */
const wordKey = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/**
 * Two word keys stand for the same writing: equal, or a number and the same number written with its unit ("500" and
 * "500mg"). Never one word inside another ("ward" is not in "forward"), which marked or dropped the wrong words.
 */
const sameKey = (x: string, y: string) => x === y
  || [[x, y], [y, x]].some(([short, long]) => /^\d+(?:\.\d+)?$/.test(short!) && long!.startsWith(short!)
    && /^\p{L}{1,3}$/u.test(long!.slice(short!.length)));
const isGroup = (word: string) => /^[([]/.test(word);
const markWord = (word: string) => word.includes('?') || isPartial(word) ? word : word.replace(/([.,;:]*)$/, '?$1');

/** The keys of the words asWritten marks a guess, crossed-out writing, bracketed groups and reading marks aside. */
export function guessKeys(asWritten: string): string[] {
  return [...new Set(words(withoutCrossedOut(asWritten)).filter((word) => !isGroup(word) && unsure(word))
    .map(wordKey).filter(Boolean))];
}

/**
 * A field with "?" after each word that asWritten marks a guess (keys: guessKeys): "Flagyl" from asWritten
 * "Flagyl? 500 mg" is "Flagyl?". The keys carried are added to `carried`. Bracketed groups are left as they are.
 */
export function carryMarks(value: string, keys: readonly string[], carried: Set<string>): string {
  if (keys.length === 0 || isBlank(value)) return value;
  let changed = false;
  const out = words(value).map((word) => {
    const key = wordKey(word);
    if (isGroup(word) || !key) return word;
    const hits = keys.filter((guess) => sameKey(guess, key));
    if (hits.length === 0) return word;
    for (const hit of hits) carried.add(hit);
    const marked = markWord(word);
    if (marked !== word) changed = true;
    return marked;
  });
  return changed ? out.join(' ') : value;
}

/**
 * Whether an item is crossed out as a whole (rule G): nothing is written outside its crossed-out writing; or its
 * crossedOut holds all of asWritten where asWritten does not say "(crossed out: X)"; or (a medicine whose asWritten
 * shows the group) its drug name is written only in the crossed-out writing, so no live drug name stands outside it
 * ("IV (crossed out: Flagyl 500mg tds)"). Only the item's own writing is looked at.
 */
function wholeCrossedOut(item: ModelItem): boolean {
  const crossed = allCrossedOut(item.asWritten, item.hard?.crossedOut);
  if (!hasLetters(crossed)) return false;
  const live = withoutCrossedOut(item.asWritten);
  if (!hasLetters(live)) return true;
  if (!item.asWritten.includes(CROSSED_OUT_OPEN) && bare(crossed).includes(bare(live))) return true;
  // The drug name struck: only where asWritten itself shows the group, so the note keeps asWritten word for word.
  // Otherwise asWritten would be replaced by the crossed-out writing, losing live words ("IV 500mg tds" with
  // crossedOut "Flagyl"): the item stays a medicine and the line rule makes it unknown and crossed_out.
  return item.kind === 'medicine' && item.asWritten.includes(CROSSED_OUT_OPEN)
    && nameCrossedOut(item.name, crossed) && !nameCrossedOut(item.name, live);
}

/** Step 1 (see the header). Items without hard-page extras are left as they are. */
export function prepareHardAnswer(answer: ModelPage): ModelPage {
  return { ...answer, items: answer.items.map((original): ModelItem => {
    if (!original.hard) return original;
    let item: ModelItem = { ...original, asWritten: markPartialGuesses(cleanTokens(original.asWritten)), plain: '',
      hard: { ...original.hard, dose: cleanTokens(original.hard.dose), doseUnit: cleanTokens(original.hard.doseUnit),
        crossedOut: cleanTokens(original.hard.crossedOut ?? '').trim() } };
    // A text that looks like a description of the writing is flagged, never changed or dropped (isDescription).
    let described = isDescription(item.asWritten);
    for (const field of TEXT_FIELDS) {
      item[field] = cleanTokens(item[field]);
      if (isDescription(item[field])) described = true;
    }
    if ([item.hard!.dose, item.hard!.doseUnit, item.hard!.crossedOut ?? ''].some(isDescription)) described = true;
    if (described) item.hard = { ...item.hard!, described: true };
    // Crossed out as a whole: never an active item, whatever kind the model gave it. Where asWritten does not say
    // so, the crossed-out writing becomes the item's asWritten, so the item shows only as crossed out. Any other
    // crossed-out writing makes the medicines on its line unknown (mergeHardReadings, crossedOutOnPlace).
    if (item.kind !== 'note' && wholeCrossedOut(item)) {
      // asWritten already showing the crossed-out writing ("IV (crossed out: Flagyl 500mg tds)") is kept, every word.
      item = crossedOutNote(item.asWritten.includes(CROSSED_OUT_OPEN) ? item
        : { ...item, asWritten: `${CROSSED_OUT_OPEN}${item.hard!.crossedOut})` });
    }
    const { basis } = item.hard!;
    // Each word asWritten marks a guess is marked in the fields that hold it (the shown text is built from them).
    const keys = guessKeys(item.asWritten);
    const carried = new Set<string>();
    const carry = (value: string) => carryMarks(value, keys, carried);
    // A word cut short ("Am…") is never matched to a list or completed: shown as read, with any guess in brackets.
    const proposed = markPartialGuesses(carry(item.name.trim()));
    const partial = proposed.includes(PARTIAL_WORD);
    const match = item.kind === 'medicine' && proposed && !partial ? matchDrugName(proposed) : null;
    const prepared: ModelItem = { ...item,
      frequency: guessUnlisted(normaliseFrequency(item.frequency), ALLOWED_FREQUENCIES) };
    // How the drug name is shown where it stands in asWritten (finish): the list spelling where the list respelled
    // it, the generic after a listed brand, the other option of a look-alike, "?" where it is a guess.
    let nameShown: HardItemExtras['nameShown'];
    if (item.kind === 'medicine') {
      const guess = basis.name === 'context';
      if (!proposed) prepared.name = '';
      else if (match) {
        const marked = unsure(proposed) || !match.exact || guess;
        prepared.name = drugDisplay(match, marked);
        nameShown = { guess: marked, ...(match.exact ? {} : { replace: capitalise(match.brand ?? match.generic) }),
          ...(match.brand === null ? {} : { after: `(${match.generic})` }) };
      } else {
        const other = partial ? null : drugLookalike(proposed);
        prepared.name = other ? alternatives(proposed, other.display) : hasLetters(proposed) ? markWords(proposed) : proposed;
        // A word cut short shows its "…" (and any bracketed guess, marked) as it stands: nothing to add.
        nameShown = other ? { guess: true, replace: prepared.name } : { guess: hasLetters(proposed) && !partial };
      }
    }
    for (const field of GUESSABLE_TEXT_FIELDS) {
      if (item.kind === 'medicine' && field === 'unit') continue;
      const value = item.kind === 'medicine' && field === 'name' ? prepared[field] : carry(prepared[field]);
      prepared[field] = markGuess(value, basis[basisKey(item.kind, field)]);
    }
    const uncarried = (more: readonly string[] = []) => {
      const left = keys.filter((key) => !carried.has(key) && !more.includes(key));
      return left.length > 0 ? { uncarriedGuesses: left } : {};
    };
    if (item.kind !== 'medicine') return { ...prepared, hard: { ...prepared.hard!, ...uncarried() } };
    let rawDose = guessUnlisted(normaliseDose(item.hard!.dose));
    let rawUnit = item.hard!.doseUnit.trim();
    // A guess on the dose written with its unit ("500mg?") marks the dose.
    const joined = wordKey(`${rawDose}${rawUnit}`);
    const doseGuess = keys.find((key) => joined && key === joined);
    rawDose = carry(rawDose);
    rawUnit = carry(rawUnit);
    if (doseGuess && !unsure(rawDose)) rawDose = markWord(rawDose);
    const dose = markGuess(rawDose, basis.dose);
    const doseUnit = markGuess(rawUnit, basis.unit);
    const rebuilt = strengthOf(dose, doseUnit);
    // The model's own strength saying another number: both shown, the one rebuilt from dose and unit first.
    const own = item.strength.trim();
    const compact = (text: string) => bare(text).replace(/\s/g, '');
    const numbers = (text: string) => (bare(text).match(/\d+(?:\.\d+)?/g) ?? []).join(' ');
    const differs = !isBlank(rebuilt) && numbers(own) !== ''
      && (numbers(own) !== numbers(rebuilt) || (!isBlank(rawUnit) && compact(own) !== compact(rebuilt)));
    let strength = differs ? alternatives(rebuilt, own) : rebuilt;
    // The model's own strength marked a guess where the rebuilt one is not ("500mg?" with dose "500"): kept a guess.
    if (!differs && unsure(own) && hasLetters(strength) && !unsure(strength)) strength = markWords(strength);
    return { ...prepared, strength,
      hard: { ...item.hard!, dose, doseUnit, generic: match?.generic ?? null, nameExact: match?.exact ?? false,
        proposedName: normaliseDrugName(proposed), writtenName: proposed, ...(nameShown ? { nameShown } : {}),
        ...uncarried(doseGuess ? [doseGuess] : []) } };
  }) };
}

/** One reading of a hard page, held to the page: its check and the (prepared) answer the check was made from. */
export interface HardReading { check: PageCheck; answer: ModelPage }

/**
 * Counts only, for the completion log. drugSplits: medicines paired by place whose two readings named different drugs,
 * kept as two items (splitPair); alternativesDropped: other options left out because a field shows at most one
 * (alternatives, mergeAsWritten, limitAlternatives). Never text.
 */
export interface HardPageAgreement {
  fieldsCompared: number; fieldsAgreed: number; itemsPaired: number; itemsSingle: number; drugSplits: number;
  alternativesDropped: number;
}
export const noAgreement = (): HardPageAgreement => ({ fieldsCompared: 0, fieldsAgreed: 0, itemsPaired: 0, itemsSingle: 0,
  drugSplits: 0, alternativesDropped: 0 });

const span = (aStart: number, aSize: number, bStart: number, bSize: number) =>
  Math.max(0, Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart));

/** Which basis field a contract field's value comes under. */
function basisKey(kind: PaperItem['kind'], field: string): BasisField {
  if (field === 'name' || field === 'route' || field === 'frequency' || field === 'duration' || field === 'value') return field;
  if (field === 'unit') return 'unit';
  if (kind === 'medicine' && field === 'strength') return 'dose';
  return 'other';
}

const lineNumber = (id: string) => Number(/-l(\d+)$/.exec(id)?.[1] ?? 0);
/** A blank or absent field counts as none. */
const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && !value.trim());

/** Whichever of two agreeing texts keeps the "?" marks (a word either reading was unsure of stays marked). */
function keepUnsure(a: string | null, b: string | null): string | null {
  if (isBlank(a)) return b;
  if (isBlank(b)) return a;
  return guessMarks(b!) > guessMarks(a!) ? b : a;
}

/**
 * asWritten from two readings: the words both read the same (in order, "?" kept where either was unsure), with each
 * stretch where they differ written as the first reading's words, marked, then the second's: "IV Flagyl? 500mg?
 * (or 250mg?) 8hrly"; word by word where both stretches have as many words ("Cefuroxime? (or Ceftriaxone?) 750mg?
 * (or 1g?)"); a stretch only one reading has is shown alone, marked ("Stop? IV Ceftriaxone"; the item is
 * readings_disagree). Nothing is dropped for disagreeing, except other options past the first (below).
 * Words are split as words() does, so a bracketed group is compared whole and its brackets are never split.
 *
 * One other option each (cleanup of 2026-11-10): a reading's own "(or X?)" (the model may write one, rule B) stays
 * with the word it follows. Where the two readings differ on that word, it shows one other option, chosen as in
 * alternatives (the other reading's word first, then its own other option, then this reading's); where they differ on
 * a whole stretch of unequal length, the stretch shows the other reading's words as its one other option and the
 * readings' own options in it are left out. The other reading's crossed-out writing in a stretch is written after the
 * option, never inside it, so no group holds an "(or …)" or a stretch of the other reading's groups. Options left out
 * are counted in `drops`.
 */
export function mergeAsWritten(a: string, b: string, drops?: AlternativeDrops): string {
  // Bracketed groups stay whole ("(crossed out: 400mg)" is one word), so brackets are never split.
  const left = words(a);
  const right = words(b);
  const key = (word: string) => bare(word);
  const table = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = key(left[i]!) === key(right[j]!) ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let fromLeft: string[] = [];
  let fromRight: string[] = [];
  const isOption = (word: string) => word.startsWith(ALTERNATIVE_OPEN);
  const isStruck = (word: string) => word.startsWith(CROSSED_OUT_OPEN);
  const count = (n: number) => { if (drops && n > 0) drops.count += n; };
  /** An "(or …)" group the stretch starts with belongs to the word before it: kept there unless that has one. */
  const attachLeading = (part: string[], keep: boolean): string[] => {
    let at = 0;
    while (at < part.length && isOption(part[at]!)) {
      const last = out[out.length - 1];
      if (keep && last !== undefined && !isOption(last)) out.push(oneOption(part[at]!, drops));
      else count(1);
      at += 1;
    }
    return part.slice(at);
  };
  /** A stretch as words, each with the "(or …)" group straight after it ("IV? (or ✓?)" is one word). */
  const tokens = (part: readonly string[]): string[] => {
    const joined: string[] = [];
    for (const word of part) {
      const last = joined[joined.length - 1];
      if (isOption(word) && last !== undefined && !last.includes(ALTERNATIVE_OPEN)) joined[joined.length - 1] = `${last} ${word}`;
      else if (isOption(word)) count(1);
      else joined.push(word);
    }
    return joined;
  };
  const closeGap = () => {
    if (fromLeft.length > 0 || fromRight.length > 0) {
      const crossedOnly = (part: readonly string[]) => part.length === 1 && isStruck(part[0]!);
      const inside = (word: string) => word.slice(CROSSED_OUT_OPEN.length, -1).trim();
      if (crossedOnly(fromLeft) && crossedOnly(fromRight)) {
        // Two readings of one crossed-out stretch: one group, "(crossed out: 400mg? (or 200mg?))".
        out.push(`${CROSSED_OUT_OPEN}${alternatives(inside(fromLeft[0]!), inside(fromRight[0]!), { drops })})`);
      } else {
        const leftLeading = fromLeft.length > 0 && isOption(fromLeft[0]!);
        const ownLeft = attachLeading(fromLeft, true);
        // The other reading's option for the word before is kept only where this reading has none there.
        const ownRight = attachLeading(fromRight, !leftLeading);
        const struckRight = ownRight.filter(isStruck);
        const restRight = ownLeft.length > 0 ? ownRight.filter((word) => !isStruck(word)) : ownRight;
        if (ownLeft.length === 0 || restRight.length === 0) {
          // A stretch only one reading has is shown alone, marked ("Stop?"), never as a bare "(or Stop?)".
          const alone = ownLeft.length > 0 ? ownLeft : restRight;
          if (alone.length > 0) out.push(markWords(limitAlternatives(alone.join(' '), drops)));
        } else {
          const leftTokens = tokens(ownLeft);
          const rightTokens = tokens(restRight);
          if (leftTokens.length === rightTokens.length) {
            // As many words each side: word by word, "Cefuroxime? (or Ceftriaxone?) 750mg? (or 1g?)".
            leftTokens.forEach((word, index) => out.push(alternatives(word, rightTokens[index]!, { drops })));
          } else {
            // Unequal stretches: the other reading's words as the one option, the readings' own options left out.
            const mains = (part: readonly string[]) => part.map((token) => {
              const [main, other] = optionsOf(token);
              if (other !== null) count(1);
              return main;
            }).join(' ');
            out.push(alternatives(mains(leftTokens), mains(rightTokens), { drops }));
          }
        }
        // The other reading's crossed-out writing: after the option, as its own group.
        if (ownLeft.length > 0) for (const word of struckRight) out.push(word);
      }
    }
    fromLeft = [];
    fromRight = [];
  };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && key(left[i]!) === key(right[j]!)) {
      closeGap();
      out.push(keepUnsure(left[i]!, right[j]!)!);
      i += 1; j += 1;
    } else if (j >= right.length || (i < left.length && table[i + 1]![j]! >= table[i]![j + 1]!)) {
      fromLeft.push(left[i]!); i += 1;
    } else {
      fromRight.push(right[j]!); j += 1;
    }
  }
  closeGap();
  return limitAlternatives(out.join(' '), drops);
}

interface Side { item: PaperItem; extras: HardItemExtras | undefined }

function sidesOf(reading: HardReading): Side[] {
  return reading.check.items.map((item, index) => ({ item,
    extras: reading.answer.items[reading.check.rawIndexes?.[index] ?? -1]?.hard }));
}

/** A field's basis said "context" in this reading (and the field is filled). */
function fromContext(side: Side, field: string, value: unknown): boolean {
  return !isBlank(value) && side.extras?.basis[basisKey(side.item.kind, field)] === 'context';
}

/**
 * The item's values held outside its fields: its date and, for a medicine, the prescriber and prescription date.
 * They carry no "?" (checkPage keeps them only where written exactly on the page) and come under basis "other".
 */
function outsideFields(item: PaperItem): Array<[string, string | null]> {
  return [['dateAsWritten', item.dateAsWritten], ['prescriberAsWritten', item.prescription?.prescriberAsWritten ?? null],
    ['prescriptionDate', item.prescription?.dateAsWritten ?? null]];
}

const anyFromContextOutside = (side: Side) =>
  outsideFields(side.item).some(([field, value]) => fromContext(side, field, value));

function anyFromContext(side: Side): boolean {
  const fields = side.item.fields as Record<string, unknown>;
  if (Object.entries(fields).some(([field, value]) => fromContext(side, field, value))) return true;
  if (anyFromContextOutside(side)) return true;
  // A medicine's dose and unit are kept apart in the extras; the unit's basis is "unit" (as in pair).
  return side.item.kind === 'medicine' && (fromContext(side, 'strength', side.extras?.dose)
    || fromContext(side, 'unit', side.extras?.doseUnit));
}

/**
 * What each hard-page frequency code means, for the plain reading. "od" is not here: it is "once a day", but also
 * "oculus dexter" (the right eye) on an eye-drop prescription, and normaliseFrequency lower-cases "OD", so it is
 * kept as written, never put in words.
 */
export const FREQUENCY_WORDS: Readonly<Partial<Record<(typeof HARD_PAGE_FREQUENCIES)[number], string>>> = {
  bd: 'twice a day', tds: 'three times a day', qds: 'four times a day', '6hrly': 'every 6 hours',
  '8hrly': 'every 8 hours', '12hrly': 'every 12 hours', nocte: 'at night', mane: 'in the morning', stat: 'at once',
  prn: 'when needed',
};
const DURATION_UNITS: Readonly<Record<string, string>> = { 7: 'days', 52: 'weeks', 12: 'months' };

/**
 * Dose shorthand in words, only where the read is certain (the field carries no "?" and no "[?]" or
 * "[sign?]"): a frequency code as "tds (three times a day)" ("od" kept as written: see FREQUENCY_WORDS), a duration written "5/7" as "5/7 (5 days)" ("/52"
 * weeks, "/12" months). Anything else is kept as written.
 */
export function shorthandInWords(field: 'frequency' | 'duration', value: string): string {
  const text = value.trim();
  if (!text || /\?|\[/.test(text)) return value;
  if (field === 'frequency') {
    const words = FREQUENCY_WORDS[text.toLowerCase() as keyof typeof FREQUENCY_WORDS];
    return words ? `${text} (${words})` : value;
  }
  const fraction = /^(\d+) ?\/ ?(7|52|12)$/.exec(text);
  if (!fraction) return value;
  const count = Number(fraction[1]);
  const unit = DURATION_UNITS[fraction[2]!]!;
  return `${text} (${count} ${count === 1 ? unit.slice(0, -1) : unit})`;
}

/**
 * The reading built from an item's fields alone, in the order a prescription is written (route, drug, strength, how
 * often, how long; a diagnosis its name; a lab result test, value, unit and flag; a note its text). Used only where
 * asWritten holds no reading at all; otherwise the shown text is asWritten itself (displayOf).
 */
function fieldsText(kind: PaperItem['kind'], fields: PaperItem['fields']): string {
  const values = fields as Record<string, unknown>;
  const keys = kind === 'medicine' ? ['route', 'name', 'strength', 'frequency', 'duration']
    : kind === 'diagnosis' ? ['name'] : kind === 'lab_result' ? ['test', 'value', 'unit', 'flag']
      : kind === 'note' ? ['text'] : ['substance', 'reaction', 'value', 'unit'];
  return keys.map((key) => values[key]).filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join(' ');
}

/** All the crossed-out writing of a reading: its crossedOut and each "(crossed out: X)" in asWritten, joined by "; ". */
function allCrossedOut(asWritten: string, given: string | undefined): string {
  const parts = [...(isBlank(given) ? [] : [given!.trim()]), ...crossedOutParts(asWritten)];
  return [...new Set(parts)].join('; ');
}

/**
 * Whether a drug name (its letters, "?" marks, a listed generic in brackets and other options aside) is written in
 * the crossed-out writing: every word of the name, as whole words.
 */
function nameCrossedOut(name: string | null | undefined, crossed: string): boolean {
  if (isBlank(name) || isBlank(crossed)) return false;
  const split = splitAlternative(name!);
  if (split) return split.some((option) => nameCrossedOut(option, crossed));
  const keys = words(name!).filter((word) => !isGroup(word)).map(wordKey).filter(Boolean);
  const struck = words(crossed.replace(/[;()]/g, ' ')).map(wordKey).filter(Boolean);
  return keys.length > 0 && keys.every((key) => struck.some((other) => sameKey(other, key)));
}

/** The crossed-out writing an item shows: the reading's crossedOut, else what asWritten writes as "(crossed out: X)". */
function crossedOutOf(asWritten: string, given: string | undefined): string {
  if (!isBlank(given)) return given!.trim();
  return crossedOutParts(asWritten).join('; ');
}

/**
 * How one field is shown where its words stand in asWritten (displayOf). `asRead`: the field's words as read (found
 * in asWritten by their letters and digits, "?" marks, case and spacing aside); `replace`: shown instead of them (a
 * list respelling, a look-alike pair); `after`: added straight after them (a listed brand's generic, a diagnosis or
 * test's listed name); `guess`: shown with "?" after each word; `shorthand`: a frequency or duration put in words
 * where it is certain ("tds (three times a day)"); `generic`: a listed drug's generic, to find a name written in
 * another spelling.
 */
export interface DisplayNote {
  asRead: string;
  replace?: string;
  after?: string;
  guess: boolean;
  shorthand?: 'frequency' | 'duration';
  generic?: string | null;
}

/** A word's key for finding a field among the shown words: a reading mark is its own key, never the letters in it. */
const findKey = (word: string) => isMarkToken(word) ? word : wordKey(word);
const runKey = (run: readonly string[]) => run.map(findKey).join('');
/** A strength's key with the unit's other spellings as one ("1gm", "1 gram" and "1g"; "500mgs" and "500mg"). */
const strengthKey = (key: string) => key.replace(/^(\d+(?:\.\d+)?)(?:gms?|grams?|grammes?)$/, '$1g')
  .replace(/^(\d+(?:\.\d+)?)(?:mgs|milligrams?)$/, '$1mg');
/** The most words one field may take in asWritten. */
const MAX_RUN = 12;
const isPlainGroup = (word: string) => word.startsWith('(') && !word.startsWith(ALTERNATIVE_OPEN)
  && !word.startsWith(CROSSED_OUT_OPEN) && !isMarkToken(word);

/**
 * The first run of words, not yet taken, that `matches`. A run never starts with the other reading's words ("(or
 * B)", which are searched on their own) and never holds crossed-out writing (it is not the item).
 */
function findRun(ws: readonly string[], taken: readonly boolean[], matches: (run: readonly string[]) => boolean):
  [number, number] | null {
  for (let i = 0; i < ws.length; i += 1) {
    const first = ws[i]!;
    if (taken[i] || !findKey(first) || first.startsWith(ALTERNATIVE_OPEN) || first.startsWith(CROSSED_OUT_OPEN)) continue;
    for (let j = i + 1; j <= Math.min(ws.length, i + MAX_RUN); j += 1) {
      if (taken[j - 1] || ws[j - 1]!.startsWith(CROSSED_OUT_OPEN)) break;
      if (matches(ws.slice(i, j))) return [i, j];
    }
  }
  return null;
}

/** Where a field's words stand: by their letters and digits; a frequency also by its code; a listed drug by the list. */
function locate(ws: readonly string[], taken: readonly boolean[], note: DisplayNote): [number, number] | null {
  const key = runKey(words(note.asRead));
  const found = key ? findRun(ws, taken, (run) => runKey(run) === key) : null;
  if (found) return found;
  if (/^\d/.test(key) && strengthKey(key) !== key || /^\d+(?:\.\d+)?(?:g|mg)$/.test(key)) {
    const byUnit = findRun(ws, taken, (run) => run.length <= 2 && strengthKey(runKey(run)) === strengthKey(key));
    if (byUnit) return byUnit;
  }
  if (note.shorthand === 'frequency' && key) {
    const code = bare(normaliseFrequency(note.asRead));
    const byCode = findRun(ws, taken, (run) => run.length <= 3 && bare(normaliseFrequency(run.join(' '))) === code);
    if (byCode) return byCode;
  }
  if (note.generic) {
    const byList = findRun(ws, taken, (run) => run.length <= 3 && !run.some(isGroup)
      && !run.some(isPartial) && matchDrugName(run.join(' '))?.generic === note.generic);
    if (byList) return byList;
  }
  // A field the two readings gave differently ("500mg? (or 250mg?)") written as "500? (or 250?) mg": the first
  // option's words with the other reading's in between. Only where every "(or …)" in the run is that other option:
  // render shows the field's own two options in place of the run, so a group holding more ("(or 2g? Flagyl?)", "(or
  // ✓?)") would lose its other words; such a field is found by its options one by one instead (displayOf).
  const split = splitAlternative(note.replace ?? note.asRead);
  const firstKey = split ? runKey(words(split[0])) : '';
  if (firstKey) {
    const secondKey = runKey(words(split![1]));
    // That option written without its unit ("(or 250?)" for "250mg?") counts as it.
    const isOption = (word: string) => sameKey(runKey(words(word.slice(ALTERNATIVE_OPEN.length, -1))), secondKey);
    return findRun(ws, taken, (run) => run.some((word) => word.startsWith(ALTERNATIVE_OPEN))
      && run.filter((word) => word.startsWith(ALTERNATIVE_OPEN)).every(isOption)
      && runKey(run.filter((word) => !word.startsWith(ALTERNATIVE_OPEN))) === firstKey);
  }
  return null;
}

/** A field's words as shown: replaced or marked as the note says, with what goes after them. */
function render(run: readonly string[], note: DisplayNote, next: string | undefined): string {
  // The other reading's option inside the run: shown as the field gives the two, "500mg? (or 250mg?)".
  if (run.some((word) => word.startsWith(ALTERNATIVE_OPEN)) && splitAlternative(note.replace ?? note.asRead)) {
    return note.replace ?? note.asRead;
  }
  const written = run.join(' ');
  let base = note.replace ?? written;
  if (note.replace !== undefined) {
    if (note.guess || unsure(written)) base = markWords(base);
  } else if (note.guess && !unsure(written)) {
    // A number and its unit written apart ("400 mg") are marked as one strength, "400mg?".
    const [number, unit] = run;
    base = run.length === 2 && /^\d+(?:\.\d+)?$/.test(number!) && JOINED_UNITS.test(unit!) ? `${number}${unit}?`
      : markWords(base);
  }
  let after = note.after ?? '';
  if (!after && note.shorthand && !note.guess && !unsure(written) && !/\[/.test(written)) {
    const value = note.asRead.trim();
    const inWords = shorthandInWords(note.shorthand, value);
    if (inWords !== value) after = inWords.slice(value.length).trim();
  }
  // Already written after them (a model that wrote "Flagyl (metronidazole)"): not said twice.
  if (after && next !== undefined && isPlainGroup(next) && bare(next) === bare(after)) after = '';
  return after ? `${base} ${after}` : base;
}

/** Applies each pending note to the first run of words it is found at; found notes are no longer pending. */
function applyNotes(ws: readonly string[], notes: readonly DisplayNote[], pending: boolean[]): string[] {
  const taken = ws.map(() => false);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  notes.forEach((note, index) => {
    if (!pending[index]) return;
    const run = locate(ws, taken, note);
    if (!run) return;
    const [start, end] = run;
    for (let at = start; at < end; at += 1) taken[at] = true;
    edits.push({ start, end, text: render(ws.slice(start, end), note, ws[end]) });
    pending[index] = false;
  });
  const out: string[] = [];
  for (let at = 0; at < ws.length; at += 1) {
    const edit = edits.find((candidate) => candidate.start === at);
    if (edit) { out.push(edit.text); at = edit.end - 1; } else out.push(ws[at]!);
  }
  return out;
}

/** "X (or X)" once annotated (the same listed medicine under two spellings): shown once, marked a guess. */
function collapseSame(ws: readonly string[]): string[] {
  const out: string[] = [];
  for (const word of ws) {
    if (word.startsWith(ALTERNATIVE_OPEN)) {
      const inner = bare(word.slice(ALTERNATIVE_OPEN.length, -1));
      let same = false;
      for (let count = 1; count <= Math.min(out.length, MAX_RUN) && !same; count += 1) {
        const before = out.slice(out.length - count).join(' ');
        if (bare(before) === inner) { out.splice(out.length - count, count, markWords(before)); same = true; }
      }
      if (same) continue;
    }
    out.push(word);
  }
  return out;
}

/** Whether a note shows something the reading as written would not: a guess, another spelling, a listed name. */
const noteNeeded = (note: DisplayNote) => note.guess || note.replace !== undefined || note.after !== undefined
  || note.shorthand !== undefined;

/**
 * What the check screen shows as a hard-page item (its plain reading): the reading itself, asWritten word by word in
 * the order written, with its "?" marks, "(or B?)" options, "(crossed out: X?)", "[?]", field placeholders and
 * "(? on paper)", never a word dropped or moved; each field annotated where its words stand (DisplayNote): a listed
 * drug's generic after its name ("Flagyl? (metronidazole)"), a list respelling as "Respelled? (generic)", a
 * grounded diagnosis or test name, "?" on a field that is a guess (from context, or two readings), a certain
 * frequency or duration in words. The other reading's words in "(or B)" are annotated the same way. A field that is
 * a guess or a respelling but whose words are not found in asWritten is added at the end, marked, so no guess is
 * lost; crossed-out writing asWritten does not show is added as "(crossed out: X)". asWritten with no reading at all
 * falls back to the fields (fieldsText).
 */
export function displayOf(asWritten: string, notes: readonly DisplayNote[], crossed: string,
  fallback = '', drops?: AlternativeDrops): string {
  const unique = notes.filter((note, index) => !isBlank(note.asRead)
    && notes.findIndex((other) => runKey(words(other.asRead)) === runKey(words(note.asRead))
      && JSON.stringify(other) === JSON.stringify(note)) === index);
  const readable = hasLetters(asWritten) || /\[\?\]|\[(?:route|drug|dose|freq)\?\]|…/.test(asWritten);
  let text: string;
  if (!readable) {
    text = fallback.trim() || asWritten.trim();
  } else {
    const pending = unique.map(noteNeeded);
    let ws = applyNotes(words(asWritten), unique, pending);
    // The other reading's words ("(or B)") take the notes not found in the first reading's.
    ws = ws.map((word) => !word.startsWith(ALTERNATIVE_OPEN) || !pending.some(Boolean) ? word
      : `${ALTERNATIVE_OPEN}${applyNotes(words(word.slice(ALTERNATIVE_OPEN.length, -1)), unique, pending).join(' ')})`);
    // A field the two readings gave differently ("500mg? (or 400mg?)") whose one option is written: that option where
    // it stands, the other after it.
    unique.forEach((note, index) => {
      if (!pending[index]) return;
      const split = splitAlternative(note.replace ?? note.asRead);
      if (!split) return;
      const shownKey = wordKey(ws.join(' '));
      for (const [side, other] of [[split[0], split[1]], [split[1], split[0]]] as const) {
        const key = runKey(words(side));
        const run = key ? findRun(ws, ws.map(() => false), (candidate) => runKey(candidate) === key) : null;
        if (!run) continue;
        // The other option is already shown (in the other reading's words): nothing to add.
        const otherKey = wordKey(other);
        if (otherKey && shownKey.includes(otherKey)) { pending[index] = false; break; }
        const found = ws.slice(run[0], run[1]).join(' ');
        pending[index] = false;
        // The words already followed by an other option (the readings' asWritten): one is shown, this one counted.
        if (ws[run[1]]?.startsWith(ALTERNATIVE_OPEN)) { if (drops) drops.count += 1; break; }
        ws = [...ws.slice(0, run[0]), `${markWords(found)} ${ALTERNATIVE_OPEN}${markWords(other)})`, ...ws.slice(run[1])];
        break;
      }
    });
    ws = collapseSame(ws);
    text = ws.join(' ');
    // A guess, a respelling or a listed name whose words are not in asWritten: added at the end, marked.
    const missed = unique.filter((note, index) => pending[index] && (note.guess || note.replace !== undefined
      || note.after !== undefined));
    // A name written only in crossed-out writing ("IV (crossed out: Flagyl) 500mg") is shown there, struck: never
    // added again at the end as if it were live.
    const struck = crossedOutParts(text).join(' ');
    const struckWords = words(struck.replace(/[;()]/g, ' '));
    for (const note of missed) {
      const shown = note.replace ?? note.asRead;
      if ([note.asRead, note.replace].some((value) => value !== undefined && nameCrossedOut(value, struck))) continue;
      // A listed drug struck under its other name (the generic struck, the brand read, or the other way round).
      if (note.generic && struckWords.some((word) => matchDrugName(word)?.generic === note.generic)) continue;
      // (Looked for outside crossed-out writing: a "[?]" struck there is not this field's.)
      if (!hasLetters(shown)) { if (!withoutCrossedOut(text).includes(shown.trim())) text = `${text} ${shown.trim()}`; continue; }
      text = `${text} ${markWords(shown)}${note.after ? ` ${note.after}` : ''}`;
    }
  }
  if (!isBlank(crossed) && !text.includes(CROSSED_OUT_OPEN)) text = `${text} ${CROSSED_OUT_OPEN}${crossed})`;
  // At most one other option in a row, none inside another (cleanup of 2026-11-10).
  return limitAlternatives(text.replace(/\s+/g, ' ').trim(), drops);
}

/**
 * A name grounded to its list (step 4 of the header): "As read? (listed name)" where listed and changed, as read
 * where it is the listed name, "As read? (or Listed?)" where a real unlisted look-alike is as near, as read
 * otherwise. Each side of "A (or B)" is grounded on its own; both standing for one listed name, it is said once after
 * them. "[?]", "[sign?]" and "(sign)" never match.
 */
function groundName(text: string, match: (name: string) => ListMatch | null, lookalike: (name: string) => string | null): string {
  const split = splitAlternative(text);
  if (split) {
    const [x, y] = split;
    const mx = match(x);
    const my = match(y);
    if (mx && my && mx.title === my.title) return `${x} ${ALTERNATIVE_OPEN}${y}) (${mx.title})`;
    // Already two options: each grounded to its listed name only, never given a look-alike as a third (at most one
    // other option, cleanup of 2026-11-10).
    return `${mx?.display ?? x} ${ALTERNATIVE_OPEN}${my?.display ?? y})`;
  }
  const found = match(text);
  if (found) return found.display;
  const other = lookalike(text);
  return other ? alternatives(text, other) : text;
}

/** A hard-page item's fields with a diagnosis name or a lab test name grounded to its list (groundName). */
function groundedFields(item: PaperItem): PaperItem['fields'] {
  if (item.kind === 'diagnosis' && item.fields.name) {
    return { ...item.fields, name: groundName(item.fields.name, matchDiagnosisName, diagnosisLookalike) };
  }
  if (item.kind === 'lab_result' && item.fields.test) {
    return { ...item.fields, test: groundName(item.fields.test, matchLabTestName, labTestLookalike) };
  }
  return item.fields;
}

/** Whether the item holds a handwritten sign mark (signs.ts) in its asWritten or in any text field. */
function holdsSign(item: PaperItem): boolean {
  return hasSign(item.asWritten) || Object.values(item.fields as Record<string, unknown>)
    .some((value) => typeof value === 'string' && hasSign(value));
}

/** Whether any text of the item (plain, asWritten, a field, a date or prescriber) holds a "?" of any kind. */
export function hasQuestionMark(item: PaperItem): boolean {
  const texts = [item.plain, item.asWritten, item.dateAsWritten, item.prescription?.prescriberAsWritten,
    item.prescription?.dateAsWritten, ...Object.values(item.fields as Record<string, unknown>)];
  return texts.some((value) => typeof value === 'string' && value.includes('?'));
}

/** The words of a text (crossed-out writing aside) that say what to do with an order, lower case. */
function instructionWords(text: string, which: (word: string) => boolean): string[] {
  return withoutCrossedOut(text).toLowerCase().split(/[^\p{L}/]+/u).map((word) => word.replace(/^\/+|\/+$/g, ''))
    .filter(which);
}
const isStatusWord = (word: string) => STATUS_WORDS.test(word);
const isInstructionWord = (word: string) => STATUS_WORDS.test(word) || INSTRUCTION_WORDS.test(word);

/**
 * What finish shows besides the fields: the crossed-out writing, the drug name notes of each reading (a pair has
 * two), the words asWritten marks a guess that no field carries (uncarriedGuesses, for the fields), and the keys of
 * the words a field filled from context holds (so their "?" is not counted as one from the letters).
 */
interface Shown {
  crossed: string; described: boolean; uncarried: readonly string[]; names: readonly DisplayNote[];
  contextKeys: ReadonlySet<string>;
}

/** The text fields a "?" is carried into for the payload where asWritten marks a guess no field shows. */
const SHOWN_TEXT_FIELDS = ['route', 'name', 'strength', 'frequency', 'duration', 'test', 'value', 'unit', 'flag', 'text',
  'substance', 'reaction'] as const;

function nameNote(side: Side): DisplayNote | null {
  const extras = side.extras;
  if (side.item.kind !== 'medicine' || !extras?.writtenName || isBlank(extras.writtenName)) return null;
  return { asRead: extras.writtenName, guess: false, ...extras.nameShown, generic: extras.generic ?? null };
}

function shownOf(side: Side): Shown {
  const fields = side.item.fields as Record<string, unknown>;
  const contextKeys = new Set<string>();
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value === 'string' && fromContext(side, field, value)) for (const word of words(value)) contextKeys.add(wordKey(word));
  }
  if (side.item.kind === 'medicine' && fromContext(side, 'strength', side.extras?.dose)) {
    for (const word of words(String(fields.strength ?? ''))) contextKeys.add(wordKey(word));
  }
  const name = nameNote(side);
  return { crossed: crossedOutOf(side.item.asWritten, side.extras?.crossedOut), described: side.extras?.described === true,
    uncarried: side.extras?.uncarriedGuesses ?? [], names: name ? [name] : [], contextKeys };
}

/** Whether every guess key is shown with its "?" in the text (a word of it, marked, standing for the same writing). */
function guessesShown(text: string, keys: readonly string[]): boolean {
  const marked = words(text).filter((word) => !isGroup(word) && unsure(word)).map(wordKey).filter(Boolean);
  return keys.every((key) => marked.some((shown) => sameKey(shown, key)));
}

/** A field's note: "?" where the field is a guess (or shows no letter shapes), a certain frequency or duration in words. */
const fieldNote = (value: unknown, shorthand?: 'frequency' | 'duration'): DisplayNote | null =>
  typeof value !== 'string' || isBlank(value) ? null
    : { asRead: value, guess: unsure(value) || !hasLetters(value), ...(shorthand ? { shorthand } : {}) };

/**
 * The notes of an item's fields for its shown text (displayOf): a medicine's route, drug name (from each reading's
 * name note, or the field), strength, frequency and duration; a diagnosis or lab test name grounded to its list;
 * any other text field marked where it is a guess.
 */
function displayNotes(item: PaperItem, fields: PaperItem['fields'], names: readonly DisplayNote[]): DisplayNote[] {
  const values = fields as Record<string, unknown>;
  const raw = item.fields as Record<string, unknown>;
  const notes: Array<DisplayNote | null> = [];
  if (item.kind === 'medicine') {
    notes.push(fieldNote(values.route));
    if (names.length > 0) notes.push(...names); else notes.push(fieldNote(values.name));
    notes.push(fieldNote(values.strength), fieldNote(values.frequency, 'frequency'), fieldNote(values.duration, 'duration'));
  } else {
    for (const [field, value] of Object.entries(values)) {
      if (typeof value !== 'string' || isBlank(value)) continue;
      const before = raw[field];
      if ((field === 'name' || field === 'test') && typeof before === 'string' && before !== value) {
        notes.push({ asRead: before, replace: value, guess: unsure(before) });
      } else if (item.kind === 'note' && field === 'text') {
        continue;
      } else notes.push(fieldNote(value));
    }
  }
  return notes.filter((note): note is DisplayNote => note !== null && noteNeeded(note));
}

/** Whether the shown text has uncertainty from the letters: a "?" on a word no context field holds, "…", "[?]" or a placeholder. */
function unsureFromLetters(display: string, contextKeys: ReadonlySet<string>): boolean {
  if (/\[\?\]|\[(?:route|drug|dose|freq)\?\]|…/.test(display)) return true;
  return display.replace(NOT_GUESS_MARKS, ' ').split(/[\s()]+/).filter((token) => token.includes('?'))
    .map(wordKey).some((key) => key !== '' && !contextKeys.has(key));
}

function finish(item: PaperItem, codes: readonly string[], sourceSha256Hex: string, shown: Shown,
  statusDiffers = false, drops?: AlternativeDrops): PaperItem {
  const checkReasons = [...item.checkReasons];
  const signs = holdsSign(item) ? [SIGN_READ] : [];
  const crossed = !isBlank(shown.crossed) || item.asWritten.includes(CROSSED_OUT_OPEN) ? [CROSSED_OUT] : [];
  const described = shown.described ? [DESCRIPTION_SUSPECTED] : [];
  let fields = groundedFields(item);
  const plain = displayOf(item.asWritten, displayNotes(item, fields, shown.names), shown.crossed,
    fieldsText(item.kind, fields), drops);
  // A medicine whose shown text says it is stopped, held or changed, or whose two readings differ on what to do with
  // it, is not known to be current: status unknown (a status already stopped or past is kept).
  const statusCodes: string[] = [];
  if (item.kind === 'medicine') {
    const status = (fields as { status: string }).status;
    const cue = instructionWords(plain, isStatusWord).length > 0;
    // Crossed-out writing on the item itself: not known to be current either (the line rule does the same for the
    // other items on its line).
    if ((cue || statusDiffers || crossed.length > 0) && status !== 'stopped' && status !== 'past') {
      fields = { ...fields, status: 'unknown' } as PaperItem['fields'];
    }
    if (cue || statusDiffers) statusCodes.push('status_cue_on_line');
    if (statusDiffers) statusCodes.push(READINGS_DISAGREE);
  }
  const letters = unsureFromLetters(plain, shown.contextKeys) ? [UNSURE_LETTERS] : [];
  for (const code of [...codes, ...statusCodes, ...described, ...crossed, ...signs, ...letters, BEST_GUESS,
    'read_from_image']) {
    if (!checkReasons.includes(code)) checkReasons.push(code);
  }
  // A word asWritten marks a guess that the fields do not show marked (no field held it as such before the checks,
  // as a note's text): carried into the fields that hold it now, by whole words. A guess on a word no field holds
  // ("Switch?") marks no field: the shown text is asWritten itself, so it shows every mark where it stands (before,
  // every field was marked so a text built from the fields would not lose it).
  if (!guessesShown(fieldsText(item.kind, fields), shown.uncarried)) {
    const values = { ...fields } as Record<string, unknown>;
    for (const key of SHOWN_TEXT_FIELDS) {
      const value = values[key];
      if (typeof value === 'string' && hasLetters(value)) values[key] = carryMarks(value, shown.uncarried, new Set());
    }
    fields = values as PaperItem['fields'];
  }
  // Every hard-page item, and so every item showing a "?", goes to a person to keep or change (owner decision of
  // 2026-11-06): check_carefully, whatever the reasons.
  return { ...item, fields, plain,
    id: itemId(sourceSha256Hex, item.kind, item.lineIds, item.asWritten), readBy: 'reread',
    confidence: 'check_carefully', checkReasons, checkReason: checkReasonSentence(checkReasons) } as PaperItem;
}

/** An item only one reading found (it passed every placement rule in its own reading). */
function single(side: Side, sourceSha256Hex: string, drops?: AlternativeDrops): PaperItem {
  const item = { ...side.item, fields: { ...side.item.fields } } as PaperItem;
  return finish(item, [SINGLE_READING, ...(anyFromContext(side) ? [FROM_CONTEXT] : [])], sourceSha256Hex, shownOf(side),
    false, drops);
}

/**
 * A medicine's drug as one reading names it, for the whole-drug rule (sameDrug): the listed generic; for an unlisted
 * name its key (normaliseDrugName, its words: NOT_IDENTITY_WORDS left out, IDENTITY_ALIASES looked up first); for a word cut short ("cr… (Pentazocine?)") the letters
 * before "…" and the bracketed whole-word guess, if any; null where the name says nothing (blank, "[drug?]", "[?]").
 * A name with an other option of its own ("Omeprazole? (or Enoxaparin?)") counts as its first reading.
 */
type DrugIdentity = { generic: string } | { key: string } | { prefix: string; guess: DrugIdentity | null };

const lettersKey = (text: string) => normaliseDrugName(text).replace(/[^a-z0-9]/g, '');

/**
 * Words that say how a medicine is given or released, not which medicine it is ("Inj", "Tab", "IV", "retard",
 * "SR"): left out of a name's identity, so "Nifedipine retard" and "Nifedipine" are one drug (review of 2026-11-10).
 * Only for the whole-drug rule; the name is still shown as read.
 */
const NOT_IDENTITY_WORDS = new Set(['tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules', 'inj',
  'injection', 'syr', 'syrup', 'susp', 'suspension', 'iv', 'im', 'po', 'sc', 'retard', 'sr', 'xr', 'xl', 'er', 'cr', 'mr',
  'la']);
/**
 * Ward abbreviations for a listed medicine, for the whole-drug rule only (never shown, never a respelling): "vit" is
 * read as "vitamin" first, so "Vit C" is the listed vitamin c (ascorbic acid). Added here, review of 2026-11-10.
 */
const IDENTITY_ALIASES: Readonly<Record<string, string>> = {
  'vitamin k': 'phytomenadione',
  'pcm': 'paracetamol',
  'mgso4': 'magnesium sulfate',
  'mg sulphate': 'magnesium sulfate',
  'mg sulfate': 'magnesium sulfate',
  'mag sulphate': 'magnesium sulfate',
  'ca gluconate': 'calcium gluconate',
  'kcl': 'potassium chloride',
};
// Hyphens and other separators split words too ("Vitamin-C" is "vitamin c"), so a joined or hyphenated name has the
// same identity as the spaced one (review of 2026-11-10).
// A vitamin written joined ("VitaminK", "VitC", "VitB12") is split from its letter first, so it has the spaced form's
// identity and its letter still tells it from another vitamin.
const identityWords = (text: string) => normaliseDrugName(text).replace(/[-_/.]+/g, ' ')
  .replace(/\bvit(?:amin)?([a-z]\d{0,2})\b/g, 'vitamin $1').split(' ')
  .filter((word) => word.length > 0 && !NOT_IDENTITY_WORDS.has(word))
  .map((word) => (word === 'vit' ? 'vitamin' : word)).join(' ');

export function drugIdentityOf(name: string | null | undefined, generic: string | null = null): DrugIdentity | null {
  if (generic) return { generic };
  if (isBlank(name)) return null;
  const [main] = optionsOf(name!.trim());
  if (main.includes(PARTIAL_WORD)) {
    const prefix = lettersKey(main.slice(0, main.indexOf(PARTIAL_WORD)).split(/\s+/).pop() ?? '');
    const group = words(main).find((word) => word.startsWith('(') && !isMarkToken(word) && !word.startsWith(ALTERNATIVE_OPEN));
    const guess = group ? drugIdentityOf(group.slice(1, -1)) : null;
    return prefix || guess ? { prefix, guess } : null;
  }
  const text = main.replace(NOT_GUESS_MARKS, ' ').replace(/\(sign\)/g, ' ');
  if (!/\p{L}/u.test(text)) return null;
  const named = identityWords(text);
  if (IDENTITY_ALIASES[named]) return { generic: IDENTITY_ALIASES[named]! };
  const match = matchDrugName(text) ?? (named && named !== normaliseDrugName(text) ? matchDrugName(named) : null);
  if (match) return { generic: match.generic };
  const key = lettersKey(named) ? named : normaliseDrugName(text);
  return lettersKey(key) ? { key } : null;
}

/** The names (normalised, words kept) a listed generic goes by on the drug list: the generic, its synonyms and brands. */
const LISTED_NAMES = new Map<string, string[]>();
for (const entry of DRUG_ENTRIES) {
  const names = LISTED_NAMES.get(entry.target) ?? [];
  names.push(entry.key);
  LISTED_NAMES.set(entry.target, names);
}
const namesOf = (identity: { generic: string } | { key: string }) =>
  'generic' in identity ? LISTED_NAMES.get(identity.generic) ?? [normaliseDrugName(identity.generic)] : [identity.key];

/**
 * Two spellings of one unlisted name: the same drug only when their letters and digits are exactly the same, spaces,
 * hyphens and other separators aside ("Vitamin-C", "VitaminC" and "Vitamin C" are one name; "Vitamin C" and "Vitamin
 * K", "Vit B1" and "Vit B6", "Ca gluconate" and "K gluconate" are not). No fuzzy match here (review of 2026-11-10):
 * wrongly splitting one drug only shows the order twice, each check_carefully, while wrongly joining two drugs mixes
 * their fields in one order. Spellings the drug list knows still join through their listed generic (sameDrug).
 */
const LOOKALIKE_LETTER_KEYS = UNLISTED_LOOKALIKES.map(lettersKey);
const isUnlistedLookalike = (key: string) => LOOKALIKE_LETTER_KEYS.some((lookalike) => lookalike === key
  || (lookalike.length >= MIN_FUZZY_LETTERS && editDistance(lookalike, key) <= 1));
function sameName(nameA: string, nameB: string): boolean {
  const [a, b] = [lettersKey(nameA), lettersKey(nameB)];
  return a !== '' && a === b;
}

/**
 * Whether two readings name the same drug (whole-drug rule, cleanup of 2026-11-10): two listed names by their generic
 * (a brand and its generic, or two spellings the list matches, are one drug); a listed name and an unlisted one, or
 * two unlisted ones, by their letters (sameName, against every name the list gives the listed one); a word cut short
 * by its guess, or by its letters starting the other name. Where either says nothing (null), the same: only a clear
 * difference of drug splits an item.
 */
export function sameDrug(x: DrugIdentity | null, y: DrugIdentity | null): boolean {
  if (x === null || y === null) return true;
  if ('prefix' in x || 'prefix' in y) {
    const [cut, other] = 'prefix' in x ? [x, y] : [y as { prefix: string; guess: DrugIdentity | null }, x];
    if (cut.guess !== null && !('prefix' in other) && sameDrug(cut.guess, other)) return true;
    if ('prefix' in other) {
      if (cut.guess !== null && other.guess !== null && sameDrug(cut.guess, other.guess)) return true;
      return cut.prefix !== '' && other.prefix !== '' && (cut.prefix.startsWith(other.prefix) || other.prefix.startsWith(cut.prefix));
    }
    return cut.prefix !== '' && namesOf(other).some((name) => lettersKey(name).startsWith(cut.prefix));
  }
  if ('generic' in x && 'generic' in y) return x.generic === y.generic;
  // A real unlisted look-alike (drug-list.ts UNLISTED_LOOKALIKES: "Quinidine" beside the listed quinine) is a
  // different drug from the listed one, never one item (review of 2026-11-10).
  if (('generic' in x) !== ('generic' in y) && isUnlistedLookalike(lettersKey('key' in x ? x.key : (y as { key: string }).key))) {
    return false;
  }
  return namesOf(x).some((a) => namesOf(y).some((b) => sameName(a, b)));
}

const identityOfSide = (side: Side) => drugIdentityOf(side.extras?.writtenName
  ?? (side.item.fields as { name?: string | null }).name,
  side.extras?.generic ?? null);

/**
 * Two medicines paired by place whose readings name different drugs (sameDrug): never one item with mixed fields.
 * Each reading's item is kept as it read it (its own fields, asWritten and crossed-out writing), both on the lines and
 * box of the two together, read A's first (the reading with more fields read from the letters, as in pair),
 * check_carefully and readings_disagree (not single_reading_only: both readings saw an order
 * here). The drug name of each is marked a guess ("?"), in the field and where it is shown.
 */
function splitPair(first: Side, second: Side, sourceSha256Hex: string, drops?: AlternativeDrops):
  { items: PaperItem[]; swapped: boolean } {
  // The reading with more fields read from the letters first, as read A of a pair.
  const swapped = lettersRead(second) > lettersRead(first);
  const lineIds = [...new Set([...first.item.lineIds, ...second.item.lineIds])].sort((x, y) => lineNumber(x) - lineNumber(y));
  const box = unionBox([first.item.box, second.item.box]) ?? first.item.box;
  const items = (swapped ? [second, first] : [first, second]).map((side) => {
    const fields = { ...side.item.fields } as Record<string, unknown>;
    // The drug name is the reading the other contradicts: marked a guess in the field and where it is shown.
    if (typeof fields.name === 'string' && hasLetters(fields.name) && !unsure(fields.name)) fields.name = markWords(fields.name);
    const item = { ...side.item, lineIds, box, fields } as PaperItem;
    const shown = shownOf(side);
    return finish(item, [READINGS_DISAGREE, ...(anyFromContext(side) ? [FROM_CONTEXT] : [])], sourceSha256Hex,
      { ...shown, names: shown.names.map((note) => ({ ...note, guess: true })) }, false, drops);
  });
  return { items, swapped };
}

/**
 * Two readings of one item, field by field after normalisation (bare: "?" marks, case and spacing aside):
 * - agreeing: the best guess, keeping "?" where either reading was unsure, and basis "context" where either said so;
 * - disagreeing (any text field: a drug name, a number, unit, route, frequency, any text): read A's guess, then read
 *   B's, "A? (or B?)", every word of both marked (alternatives); nothing becomes "[?]" for disagreeing. Read A is
 *   chosen once for the whole item (never field by field, so the first options never make an order neither reading
 *   gave): the reading with more fields read from the letters (lettersRead), so a guess from context is the second
 *   option where the other reading read the letters; else the first reading. asWritten (merged word by word,
 *   mergeAsWritten, which the shown text is) and the crossed-out writing list the two in the same order. A field only
 *   one reading filled is that reading's, marked. The same listed medicine under two spellings respelled by the list
 *   is that medicine, marked "?", and still readings_disagree;
 * - any difference in asWritten is readings_disagree; a difference in the words that say what to do with an order
 *   (STATUS_WORDS, INSTRUCTION_WORDS) also makes a medicine's status unknown (finish);
 * - a disagreeing medicine status becomes 'unknown', an allergy severity none (null), and a diagnosis keeps the
 *   first reading's status with readings_disagree.
 * The dose and unit of a medicine are compared apart (each counts as a field); the strength is rebuilt from the two
 * where they agree, else shown as each reading's strength, "500mg? (or 250mg?)". Crossed-out writing is kept from
 * either reading ("A (or B)" where they differ; not tallied).
 */
/** How many of a reading's fields it read from the letters (its basis), for choosing read A (pair). */
const lettersRead = (side: Side) => Object.values(side.extras?.basis ?? {}).filter((basis) => basis === 'letters').length;

function pair(first: Side, second: Side, sourceSha256Hex: string, tally: HardPageAgreement,
  drops?: AlternativeDrops): PaperItem {
  // Read A is chosen once for the whole item, so the first options of all its fields are one reading's order.
  const [a, b] = lettersRead(second) > lettersRead(first) ? [second, first] : [first, second];
  let disagree = false;
  let context = false;
  const compare = (equal: boolean) => { tally.fieldsCompared += 1; if (equal) tally.fieldsAgreed += 1; else disagree = true; };
  /**
   * The one other option a field shows (alternatives): read from the letters before from context (the basis of the
   * reading it came from), on its list before not (a drug name on the drug list, a diagnosis or test name on its list,
   * a frequency one of the codes), then the other read's before read A's own, then closest to read A's reading by
   * its letters.
   */
  const scoreFor = (field: string, shownA: string | null): AlternativeScore => (candidate, source) => {
    const side = source === 'other' ? b : a;
    const letters = side.extras?.basis[basisKey(side.item.kind, field)] === 'context' ? 0 : 1;
    return [letters, listed(side.item.kind, field, candidate) ? 1 : 0, source === 'other' ? 1 : 0,
      closeness(candidate, optionsOf(shownA ?? '')[0])];
  };
  const choose = (field: string, x: string | null, y: string | null) => alternatives(x, y, { score: scoreFor(field, x), drops });
  const textField = (field: string, x: string | null, y: string | null): string | null => {
    if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
    if (isBlank(x) && isBlank(y)) { compare(true); return x; }
    const equal = bare(x) === bare(y);
    compare(equal);
    return equal ? keepUnsure(x, y) : choose(field, x, y);
  };
  const fieldsA = a.item.fields as Record<string, unknown>;
  const fieldsB = b.item.fields as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [field, x] of Object.entries(fieldsA)) {
    const y = fieldsB[field];
    if (a.item.kind === 'medicine' && field === 'strength') continue;
    if (a.item.kind === 'medicine' && field === 'name') {
      // The same listed medicine under two spellings (a brand and its generic) is agreement when each reading wrote
      // a listed name as such, or both proposed the same spelling. Two different spellings of which one was respelled
      // by the fuzzy match: the readings disagree on the letters, but both stand for that one listed medicine, so it
      // is shown once, marked a guess (a real unlisted look-alike never matches: drug-list.ts UNLISTED_LOOKALIKES).
      const listedA = a.extras?.generic ?? null;
      const listedB = b.extras?.generic ?? null;
      const sameWriting = (a.extras?.nameExact === true && b.extras?.nameExact === true)
        || (a.extras?.proposedName !== undefined && a.extras.proposedName === b.extras?.proposedName);
      if (listedA !== null && listedA === listedB) {
        compare(sameWriting);
        if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
        const kept = keepUnsure(x as string | null, y as string | null);
        fields[field] = sameWriting ? kept : bare(x as string) === bare(y as string) ? markWords(kept ?? '')
          : choose(field, x as string | null, y as string | null);
      } else {
        fields[field] = textField(field, x as string | null, y as string | null);
      }
      continue;
    }
    if (field === 'status' || field === 'severity' || field === 'measure' || field === 'noKnownAllergies') {
      // An enum carries no "?": a value either reading filled from context is said by field_from_context.
      if (fromContext(a, field, x) || fromContext(b, field, y)) context = true;
      compare(x === y);
      fields[field] = x === y ? x : a.item.kind === 'medicine' && field === 'status' ? 'unknown'
        : field === 'severity' ? null : x;
      continue;
    }
    fields[field] = textField(field, x as string | null, y as string | null);
  }
  if (a.item.kind === 'medicine') {
    const doseA = a.extras?.dose ?? '';
    const doseB = b.extras?.dose ?? '';
    const unitA = a.extras?.doseUnit ?? '';
    const unitB = b.extras?.doseUnit ?? '';
    if (fromContext(a, 'strength', doseA) || fromContext(b, 'strength', doseB)
      || fromContext(a, 'unit', unitA) || fromContext(b, 'unit', unitB)) context = true;
    const doseAgrees = bare(doseA) === bare(doseB);
    const unitAgrees = bare(unitA) === bare(unitB);
    compare(doseAgrees);
    compare(unitAgrees);
    // Where dose and unit agree but a reading showed its own strength beside the rebuilt one ("500mg? (or 400mg?)",
    // prepareHardAnswer) or kept the model's "?" on it, that reading's strength is kept.
    const strengthA = fieldsA.strength as string | null;
    const strengthB = fieldsB.strength as string | null;
    const ownStrength = [strengthA, strengthB].some((value) => value?.includes(ALTERNATIVE_OPEN))
      ? keepUnsure(strengthA, strengthB) : null;
    const rebuilt = strengthOf(keepUnsure(doseA, doseB) ?? '', keepUnsure(unitA, unitB) ?? '');
    const marked = [strengthA, strengthB].some((value) => unsure(value ?? '')) && hasLetters(rebuilt) && !unsure(rebuilt)
      ? markWords(rebuilt) : rebuilt;
    fields.strength = (doseAgrees && unitAgrees ? ownStrength ?? marked
      : choose('strength', strengthOf(doseA, unitA), strengthOf(doseB, unitB))) || null;
  }
  // A date or prescriber either reading filled from context is said by field_from_context (it carries no "?").
  if (anyFromContextOutside(a) || anyFromContextOutside(b)) context = true;
  const mergeText = (x: string | null, y: string | null) => isBlank(x) && isBlank(y) ? x
    : bare(x) === bare(y) ? keepUnsure(x, y) : alternatives(x, y, { drops });
  const prescriptionA = a.item.prescription;
  const prescriptionB = b.item.prescription;
  const prescription = prescriptionA === null && prescriptionB === null ? null : {
    prescriberAsWritten: mergeText(prescriptionA?.prescriberAsWritten ?? null, prescriptionB?.prescriberAsWritten ?? null),
    dateAsWritten: mergeText(prescriptionA?.dateAsWritten ?? null, prescriptionB?.dateAsWritten ?? null) };
  // The shown text is the merged asWritten: any difference in it is a disagreement the person must see.
  const sameWords = bare(a.item.asWritten) === bare(b.item.asWritten);
  if (!sameWords) disagree = true;
  const asWritten = sameWords ? keepUnsure(a.item.asWritten, b.item.asWritten)!
    : mergeAsWritten(a.item.asWritten, b.item.asWritten, drops);
  const shownA = shownOf(a);
  const shownB = shownOf(b);
  const crossed = isBlank(shownA.crossed) && isBlank(shownB.crossed) ? ''
    : bare(shownA.crossed) === bare(shownB.crossed) ? keepUnsure(shownA.crossed, shownB.crossed) ?? ''
      : alternatives(shownA.crossed, shownB.crossed, { drops });
  if (bare(shownA.crossed) !== bare(shownB.crossed)) disagree = true;
  // The two readings differ on what to do with the order ("Start" against "Stop", "Continue" against nothing).
  const said = (side: Side) => [...new Set(instructionWords(side.item.asWritten, isInstructionWord))].sort().join(' ');
  // Crossed-out writing on the line is the line rule's (mergeHardReadings), not matched by name here.
  const statusDiffers = a.item.kind === 'medicine' && said(a) !== said(b);
  const lineIds = [...new Set([...a.item.lineIds, ...b.item.lineIds])].sort((x, y) => lineNumber(x) - lineNumber(y));
  const reasons = [...a.item.checkReasons, ...b.item.checkReasons.filter((code) => !a.item.checkReasons.includes(code))];
  const merged = { ...a.item, asWritten, lineIds, box: unionBox([a.item.box, b.item.box]) ?? a.item.box,
    dateAsWritten: mergeText(a.item.dateAsWritten, b.item.dateAsWritten), fields,
    prescription: a.item.kind === 'medicine' ? prescription : null, checkReasons: reasons } as PaperItem;
  tally.itemsPaired += 1;
  return finish(merged, [...(disagree ? [READINGS_DISAGREE] : []), ...(context ? [FROM_CONTEXT] : [])], sourceSha256Hex,
    { crossed, described: shownA.described || shownB.described, names: [...shownA.names, ...shownB.names],
      uncarried: [...new Set([...shownA.uncarried, ...shownB.uncarried])],
      contextKeys: new Set([...shownA.contextKeys, ...shownB.contextKeys]) }, statusDiffers, drops);
}

/** Whether an other option is on its field's list (the "list-matched/grounded" step of choosing one, pair). */
function listed(kind: PaperItem['kind'], field: string, candidate: string): boolean {
  const text = candidate.replace(/\?/g, '').trim();
  if (!text) return false;
  if (field === 'name' && kind === 'medicine') return matchDrugName(text) !== null;
  if (field === 'name' && kind === 'diagnosis') return matchDiagnosisName(text) !== null;
  if (field === 'test') return matchLabTestName(text) !== null;
  if (field === 'frequency') return ALLOWED_FREQUENCIES.has(bare(text).replace(/\s/g, ''));
  return false;
}

/** Whether two items of the two readings may be the same writing: same kind, same place, nothing that rules it out. */
function pairScore(a: PaperItem, b: PaperItem): number | null {
  if (a.kind !== b.kind) return null;
  if (a.kind === 'vital' && b.kind === 'vital' && a.fields.measure !== b.fields.measure) return null;
  if (a.kind === 'allergy' && b.kind === 'allergy' && a.fields.noKnownAllergies !== b.fields.noKnownAllergies) return null;
  const shared = a.lineIds.filter((id) => b.lineIds.includes(id)).length;
  const overlap = overlapShare(a.box, b.box);
  if (shared === 0 && overlap < PAIR_BOX_OVERLAP) return null;
  return shared + overlap;
}

/** Two neighbouring medicines are in the same column when their boxes share this much of the narrower one's width. */
export const NEIGHBOUR_COLUMN_OVERLAP = 0.5;
/** Slack for comparing box fractions, so a share of exactly NEIGHBOUR_COLUMN_OVERLAP counts whatever the rounding. */
const BOX_EPSILON = 1e-9;

/**
 * Two medicines left unpaired by place that are the same listed medicine on neighbouring rows of one column: their
 * boxes share at least NEIGHBOUR_COLUMN_OVERLAP of the narrower one's width, and their cited lines are at most one
 * line apart or their boxes share part of their height. The smaller the gap the better; null when not neighbours.
 * Nothing pairs across columns or along one row: the same medicine at one height in two columns is two orders, and
 * two halves of one written line ("Metronidazole" | "400 mg tds"), each found by one reading, stay two
 * single_reading_only items (a safe duplicate: merging them would show every field the other half fills as a
 * disagreement, and a lone name beside a full order would swallow that order).
 */
function neighbourGap(a: Side, b: Side): number | null {
  if (a.item.kind !== 'medicine' || b.item.kind !== 'medicine') return null;
  const generic = a.extras?.generic ?? null;
  if (generic === null || generic !== (b.extras?.generic ?? null)) return null;
  const boxA = a.item.box;
  const boxB = b.item.box;
  const narrower = Math.min(boxA.width, boxB.width);
  const across = span(boxA.left, boxA.width, boxB.left, boxB.width);
  if (!(narrower > 0) || across + BOX_EPSILON < NEIGHBOUR_COLUMN_OVERLAP * narrower) return null;
  const down = span(boxA.top, boxA.height, boxB.top, boxB.height);
  const linesA = a.item.lineIds.map(lineNumber);
  const linesB = b.item.lineIds.map(lineNumber);
  const lineGap = Math.min(...linesA.flatMap((x) => linesB.map((y) => Math.abs(x - y))));
  if (lineGap > 1 && down <= 0) return null;
  return down > 0 ? 0 : lineGap;
}

/**
 * Crossed out, line by line (no name matching, any kind of item): any crossed-out writing a reading shows (a
 * "(crossed out: X)" group in its asWritten, or its crossedOut) makes every medicine kept on one of its lines or over
 * its box (crossedOutOnPlace) status unknown (unless stopped or past) and crossed_out, whatever was read there; where
 * a reading the item came from shows no strike there (one reading read the line live, the other struck),
 * readings_disagree too. `from` says which readings each item came from.
 */
function markStruckLines(items: PaperItem[], from: ReadonlyArray<ReadonlySet<'left' | 'right'>>,
  sides: ReadonlyArray<{ side: Side; read: 'left' | 'right' }>): void {
  const marks = sides.filter(({ side }) => !isBlank(crossedOutOf(side.item.asWritten, side.extras?.crossedOut)))
    .map(({ side, read }) => ({ lineIds: side.item.lineIds, box: side.item.box, read }));
  items.forEach((item, index) => {
    const hits = item.kind === 'medicine' ? marks.filter((mark) => crossedOutOnPlace(item, mark)) : [];
    if (hits.length === 0) return;
    markCrossedOut(item);
    // The readings disagree where any reading the item was built from shows no strike there (a pair where only one
    // reading saw it, or an item only the other reading saw struck).
    const struckBy = new Set(hits.map((mark) => mark.read));
    if ([...from[index]!].some((read) => !struckBy.has(read)) && !item.checkReasons.includes(READINGS_DISAGREE)) {
      item.checkReasons.push(READINGS_DISAGREE);
      item.checkReason = checkReasonSentence(item.checkReasons);
    }
  });
}

/**
 * The hard page's reading from its two readings (or from one, when the other failed or was declined: every item
 * then single_reading_only). Items are paired one to one by kind and place (a shared cited line, or boxes
 * overlapping by PAIR_BOX_OVERLAP of the smaller), best pairs first, then the same listed medicine on neighbouring
 * rows of one column (neighbourGap); each pair is merged by `pair`, and an item only
 * one reading found is kept with single_reading_only. Every item: check_carefully, readBy 'reread', read_from_image
 * and best_guess_from_picture, plus field_from_context where any field's basis was context. Identity is merged as in
 * mergeIdentity (a conflict flags the page ai_unsure); the page flags are both readings' flags; the dropped counts are
 * the first reading's (the one the page is held to first), or the only reading's. An item holding a handwritten
 * sign mark ("(sign)" or "[sign?]", signs.ts) in its asWritten or any field also gets sign_read.
 */
export function mergeHardReadings(readings: readonly HardReading[], sourceSha256Hex: string):
  { check: PageCheck; agreement: HardPageAgreement } {
  const tally = noAgreement();
  const [first, second] = readings;
  if (!first) throw new Error('mergeHardReadings needs a reading');
  const drops: AlternativeDrops = { count: 0 };
  if (!second) {
    const sides = sidesOf(first);
    const items = sides.map((side) => single(side, sourceSha256Hex, drops));
    markStruckLines(items, items.map(() => new Set(['left'] as const)), sides.map((side) => ({ side, read: 'left' })));
    tally.itemsSingle += items.length;
    tally.alternativesDropped += drops.count;
    return { check: { ...first.check, items: uniqueItemIds(items), rawIndexes: undefined }, agreement: tally };
  }
  const left = sidesOf(first);
  const right = sidesOf(second);
  const candidates: Array<{ i: number; j: number; score: number }> = [];
  left.forEach((a, i) => right.forEach((b, j) => {
    const score = pairScore(a.item, b.item);
    if (score !== null) candidates.push({ i, j, score });
  }));
  candidates.sort((x, y) => y.score - x.score || x.i - y.i || x.j - y.j);
  const usedLeft = new Map<number, number>();
  const usedRight = new Set<number>();
  for (const { i, j } of candidates) {
    if (usedLeft.has(i) || usedRight.has(j)) continue;
    usedLeft.set(i, j);
    usedRight.add(j);
  }
  // Then the same listed medicine read on neighbouring lines (the two readings cited different fragments of one
  // handwritten line): paired, so one medicine is never shown twice with two doses.
  const neighbours: Array<{ i: number; j: number; gap: number }> = [];
  left.forEach((a, i) => right.forEach((b, j) => {
    if (usedLeft.has(i) || usedRight.has(j)) return;
    const gap = neighbourGap(a, b);
    if (gap !== null) neighbours.push({ i, j, gap });
  }));
  neighbours.sort((x, y) => x.gap - y.gap || x.i - y.i || x.j - y.j);
  for (const { i, j } of neighbours) {
    if (usedLeft.has(i) || usedRight.has(j)) continue;
    usedLeft.set(i, j);
    usedRight.add(j);
  }
  const items: PaperItem[] = [];
  /** Which readings each kept item came from, for the crossed-out rule. */
  const from: Array<ReadonlySet<'left' | 'right'>> = [];
  left.forEach((a, i) => {
    const j = usedLeft.get(i);
    if (j === undefined) { items.push(single(a, sourceSha256Hex, drops)); from.push(new Set(['left'])); }
    else if (a.item.kind === 'medicine' && !sameDrug(identityOfSide(a), identityOfSide(right[j]!))) {
      // The two readings name different drugs here: two items, one per reading, never one with mixed fields.
      const split = splitPair(a, right[j]!, sourceSha256Hex, drops);
      items.push(...split.items);
      from.push(new Set([split.swapped ? 'right' : 'left']), new Set([split.swapped ? 'left' : 'right']));
      tally.drugSplits += 1;
    } else { items.push(pair(a, right[j]!, sourceSha256Hex, tally, drops)); from.push(new Set(['left', 'right'])); }
  });
  right.forEach((b, j) => {
    if (!usedRight.has(j)) { items.push(single(b, sourceSha256Hex, drops)); from.push(new Set(['right'])); }
  });
  markStruckLines(items, from, [...left.map((side) => ({ side, read: 'left' as const })),
    ...right.map((side) => ({ side, read: 'right' as const }))]);
  tally.itemsSingle += items.length - tally.itemsPaired - 2 * tally.drugSplits;
  tally.alternativesDropped += drops.count;
  const firstLine = (item: PaperItem) => Math.min(...item.lineIds.map(lineNumber));
  const ordered = items.map((item, index) => ({ item, index }))
    .sort((x, y) => firstLine(x.item) - firstLine(y.item) || x.index - y.index).map(({ item }) => item);
  const { identity, conflict } = mergeIdentity(first.check.identity, second.check.identity);
  const flags = new Set<FlagReason>([...first.check.flagReasons, ...second.check.flagReasons,
    ...(conflict ? ['ai_unsure' as const] : [])]);
  const order: readonly FlagReason[] = ['low_confidence', 'handwriting', 'many_dropped', 'ai_unsure',
    'possible_missed_item', 'ai_declined'];
  return { check: { ...first.check, items: uniqueItemIds(ordered), identity,
    pageUnsure: first.check.pageUnsure || second.check.pageUnsure,
    flagReasons: order.filter((flag) => flags.has(flag)), rawIndexes: undefined }, agreement: tally };
}
