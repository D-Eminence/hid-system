import type { PaperItem } from './contract';
import { DRUG_ENTRIES, matchDrugName, normaliseDrugName } from './drug-list';
import { overlapShare, PAIR_BOX_OVERLAP, type PageCheck } from './items';

/**
 * The last step of a page's reading (coordinator/owner cleanups of 2026-11-10, about 20:30 UTC, after the first live
 * run with the clean hard-page reading): items that are not items are left out of what the check screen shows.
 * Both rules match whole phrases, never word by word (re-review of 2026-11-10: "→ Renal unit", "Admission: medical
 * unit", "Stop artemether" beside Coartem were dropped by word lists). When in doubt the note is kept: a kept
 * heading costs one Keep/Change tap, a dropped plan or stop is a safety loss.
 *
 * - heading: a note whose whole text, with reading marks ("?", "(? on paper)") and case off, is exactly a form title:
 *   an optional prefix from HEADING_PREFIXES ("trauma surgery", "medical", "emergency", ...) and then one title from
 *   HEADING_TITLES ("treatment sheet", "drug chart", "immediate management", ...), or exactly one of
 *   HEADING_ALONE ("plan", "management", "treatment") with nothing else at all. The original text may hold only
 *   letters, spaces, apostrophes and the marks: a colon, an arrow (→, ->, =>, >), a slash, a digit, a bracket or any
 *   other symbol keeps the note. Nothing else is a heading ("Medical unit", "Surgery", "ICU", "Observation",
 *   "Medical management", "Accident & Emergency" stay). Never a medicine, diagnosis, lab result, allergy or vital.
 * - duplicate_of_order: a note that only repeats a medicine's stop ("DC? Gentamicin?" beside the medicine "Dc
 *   Gentamicin", status stopped). Only where all hold: the medicine's status is stopped (its status, never a word of
 *   its writing); the two share a cited line or their boxes overlap by PAIR_BOX_OVERLAP of the smaller; the note,
 *   marks off, is exactly one STOP_CUES word and a drug name, in either order, with nothing else; that drug name (its
 *   words joined) is the same drug as the medicine's live name (its name field without any bracketed group: never its
 *   crossed-out writing or an "(or …)" option): both on the drug list with the same generic, else the same whole name
 *   once normalised (a listed match only with as many words as a listed name of the generic: "Stop IV gentamicin"
 *   stays); and where the medicine is a combination, the note names the same combination, never one of its
 *   parts ("Stop artemether" beside Coartem stays). Otherwise the note is kept.
 *
 * Counted per code in PageCheck.droppedByReason (codes and counts only, for the completion log). These are not
 * ungrounded items: droppedUngrounded (in the payload) is unchanged, so for a page with a heading or duplicate dropped
 * the droppedByReason counts sum to more than droppedUngrounded by these two codes.
 */
export const TIDY_DROP_REASONS = ['heading', 'duplicate_of_order'] as const;
export type TidyDropReason = (typeof TIDY_DROP_REASONS)[number];

/** The specialty or ward a form title may start with (lower case, words joined by one space). */
export const HEADING_PREFIXES: readonly string[] = [
  'trauma', 'trauma surgery', 'surgery', 'surgical', 'general surgery', 'medical', 'medicine', 'internal medicine',
  'paediatric', 'paediatrics', 'pediatric', 'pediatrics', 'obstetric', 'obstetrics', 'gynae', 'gynaecology',
  'gynecology', 'emergency',
];
/** The form titles (lower case, words joined by one space; "doctor's" also without its apostrophe). */
export const HEADING_TITLES: readonly string[] = [
  'treatment sheet', 'drug chart', 'medication chart', 'prescription chart', 'fluid chart', 'observation chart',
  'progress notes', 'clinical notes', 'case notes', "doctor's notes", 'doctors notes', 'nursing notes',
  'immediate management',
];
/** Titles that are a heading only as the whole text, never after a prefix ("Medical management" is a plan). */
export const HEADING_ALONE: readonly string[] = ['plan', 'management', 'treatment'];

const HEADINGS: ReadonlySet<string> = new Set([...HEADING_ALONE, ...HEADING_TITLES,
  ...HEADING_PREFIXES.flatMap((prefix) => HEADING_TITLES.map((title) => `${prefix} ${title}`))]);

/** A text with its reading marks off: "(? on paper)" groups and "?" (case and spacing left to the caller). */
export const withoutMarks = (text: string) => text.replace(/\(\s*\?\s*on paper\s*\)/giu, ' ').replace(/\?/g, ' ');

/** The phrase a text reads as for the heading rule, or null where it holds anything but letters, spaces, "'". */
function headingPhrase(text: string): string | null {
  const plain = withoutMarks(text).replace(/[’‘]/g, "'");
  if (!/^[\p{L}\s']*$/u.test(plain)) return null;
  return plain.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** Whether a note is a page heading or form title (see the header). */
export function isHeadingNote(item: PaperItem): boolean {
  if (item.kind !== 'note') return false;
  const texts = [item.asWritten, item.fields.text ?? ''].filter((text) => text.trim() !== '');
  if (texts.length === 0) return false;
  return texts.every((text) => {
    const phrase = headingPhrase(text);
    return phrase !== null && HEADINGS.has(phrase);
  });
}

/** The stop words a duplicate note may hold, exactly one (lower case). */
export const STOP_CUES: ReadonlySet<string> = new Set(['dc', 'd/c', 'stop', 'stopped', 'discontinue', 'discontinued',
  'off']);

/** The drug words of a note that is one stop cue and a drug name, either order (see the header); else null. */
function stoppedDrugOf(text: string): string | null {
  const plain = withoutMarks(text).toLowerCase();
  // Letters, spaces, a hyphen inside a name and the slash of "d/c" only: a comma, a digit, a bracket keeps it.
  if (!/^[\p{L}\s/-]*$/u.test(plain)) return null;
  const words = plain.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const cues = words.filter((word) => STOP_CUES.has(word));
  if (cues.length !== 1) return null;
  const drug = STOP_CUES.has(words[0]!) ? words.slice(1) : STOP_CUES.has(words.at(-1)!) ? words.slice(0, -1) : null;
  if (drug === null || drug.some((word) => !/^\p{L}+(?:-\p{L}+)*$/u.test(word))) return null;
  return drug.join(' ');
}

/** A medicine's live name: its name field without any bracketed group ("(or …)", "(crossed out: …)", a guess). */
function liveNameOf(name: string | null): string {
  let live = name ?? '';
  for (let previous = ''; previous !== live;) { previous = live; live = live.replace(/\([^()]*\)/g, ' '); }
  return withoutMarks(live).replace(/[()]/g, ' ').trim();
}

const isCombination = (generic: string) => generic.includes('+');
const wordCount = (name: string) => name.split(' ').filter(Boolean).length;
/** The word counts of the drug list's names for each generic, so "IV gentamicin" is not taken for "gentamicin". */
const NAME_LENGTHS = new Map<string, Set<number>>();
for (const entry of DRUG_ENTRIES) {
  const lengths = NAME_LENGTHS.get(entry.target) ?? new Set<number>();
  lengths.add(wordCount(entry.key));
  NAME_LENGTHS.set(entry.target, lengths);
}

/** Whether a note's drug name and a medicine's live name are the same drug (see the header). */
function sameStoppedDrug(noteDrug: string, liveName: string): boolean {
  const noteName = normaliseDrugName(noteDrug);
  const live = normaliseDrugName(liveName);
  if (noteName === '' || live === '') return false;
  const noteMatch = matchDrugName(noteDrug);
  const liveMatch = matchDrugName(liveName);
  if (noteMatch === null || liveMatch === null) return noteName === live;
  if (noteMatch.generic !== liveMatch.generic) return false;
  // The note's words are the drug's name, nothing more: as many words as a listed name of that generic.
  if (!NAME_LENGTHS.get(noteMatch.generic)?.has(wordCount(noteName))) return false;
  // A combination only by the same whole combination (equal generics), never by one of its parts.
  return !isCombination(liveMatch.generic) || isCombination(noteMatch.generic) || noteName === live;
}

/** Whether a note only repeats a stopped medicine's stop (see the header). */
export function duplicatesOrder(note: PaperItem, medicine: PaperItem): boolean {
  if (note.kind !== 'note' || medicine.kind !== 'medicine') return false;
  if (medicine.fields.status !== 'stopped') return false;
  const samePlace = note.lineIds.some((id) => medicine.lineIds.includes(id))
    || overlapShare(note.box, medicine.box) >= PAIR_BOX_OVERLAP;
  if (!samePlace) return false;
  const texts = [note.asWritten, note.fields.text ?? ''].filter((text) => text.trim() !== '');
  if (texts.length === 0) return false;
  const liveName = liveNameOf(medicine.fields.name);
  return texts.every((text) => {
    const drug = stoppedDrugOf(text);
    return drug !== null && sameStoppedDrug(drug, liveName);
  });
}

/** The page's items without headings and notes repeating an order, each dropped item counted (see the header). */
export function tidyPage(check: PageCheck): PageCheck {
  const droppedByReason: Record<string, number> = { ...check.droppedByReason };
  const drop = (reason: TidyDropReason) => { droppedByReason[reason] = (droppedByReason[reason] ?? 0) + 1; };
  const medicines = check.items.filter((item) => item.kind === 'medicine');
  const items = check.items.filter((item) => {
    if (item.kind !== 'note') return true;
    if (isHeadingNote(item)) { drop('heading'); return false; }
    if (medicines.some((medicine) => duplicatesOrder(item, medicine))) { drop('duplicate_of_order'); return false; }
    return true;
  });
  return items.length === check.items.length ? check : { ...check, items, droppedByReason };
}
