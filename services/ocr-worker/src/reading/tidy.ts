import type { PaperItem } from './contract';
import { matchDiagnosisName } from './diagnosis-list';
import { DRUG_ENTRIES, matchDrugName, normaliseDrugName } from './drug-list';
import { INSTRUCTION_WORDS, STATUS_WORDS } from './hard-page';
import { overlapShare, PAIR_BOX_OVERLAP, type PageCheck } from './items';
import { matchLabTestName } from './lab-list';

/**
 * The last step of a page's reading (coordinator/owner cleanups of 2026-11-10, about 20:30 UTC, after the first live
 * run with the clean hard-page reading): items that are not items are left out of what the check screen shows.
 *
 * - heading: a page heading, section title or form label read as a note ("Trauma? surgery? Treatment? sheet?",
 *   "Immediate? Management?", "Plan?"), like printed form text. The hard-page prompt (rule A, version 12) asks for
 *   them to be left out; this is the second layer, narrow and conservative (review of 2026-11-10: a word such as
 *   "surgery", "ICU" or "observation" alone, or after "for", is a plan, never a heading): only a note whose words
 *   (with "?" and punctuation off) are all HEADING_WORDS (CONNECTOR_WORDS between them, never "for") AND that either
 *   holds a form-label word (FORM_LABEL_WORDS: sheet, form, record, notes, kardex, continuation, department, unit;
 *   "chart" only with a drug, medication, prescription or treatment word: "Drug chart", never "Vital signs chart")
 *   or is one of HEADING_PHRASES ("Plan", "Immediate management", "Accident and Emergency"). Never with a digit, a
 *   reading mark or bracketed group (a crossed-out word, "[?]", "(? on paper)" and the like keep it), an instruction
 *   word (INSTRUCTION_VERBS, a stop or change word: "Admit?", "Transfer to the ward" stay) or a word or whole text on
 *   the drug, diagnosis or lab list. Never a medicine, diagnosis, lab result, allergy or vital. When in doubt the
 *   note is kept.
 * - duplicate_of_order: a note that only repeats a medicine's stop ("DC? Gentamicin?" beside the medicine "Dc
 *   Gentamicin", status stopped): the medicine is kept, the note left out. Narrow (review of 2026-11-10): only where
 *   the medicine's status is stopped (its status, never a word of its writing: a crossed-out "stop", "then stop",
 *   "stop if rash" or an "(or stop?)" option is no stop), the note names that medicine's drug (its name as read, its
 *   listed generic, or any name the drug list gives that generic), holds at least one stop word and nothing but the
 *   drug and stop words (a hold, start, continue or change word, a drug name alone, anything else keeps it), and the
 *   two share a cited line or their boxes overlap by PAIR_BOX_OVERLAP of the smaller.
 *
 * Counted per code in PageCheck.droppedByReason (codes and counts only, for the completion log). These are not
 * ungrounded items: droppedUngrounded (in the payload) is unchanged, so for a page with a heading or duplicate dropped
 * the droppedByReason counts sum to more than droppedUngrounded by these two codes.
 */
export const TIDY_DROP_REASONS = ['heading', 'duplicate_of_order'] as const;
export type TidyDropReason = (typeof TIDY_DROP_REASONS)[number];

/**
 * The words a heading, section title or form label is made of (lower case, "?" and punctuation off). Words that are
 * a plan when written alone or after "for" (theatre, observation, investigations, care, intensive, fluid, input,
 * output, vital signs) are not here; department and specialty names are, but a note made of them alone is never a
 * heading (it needs a FORM_LABEL_WORDS word or to be one of HEADING_PHRASES).
 */
export const HEADING_WORDS: ReadonlySet<string> = new Set([
  // What the form or section is.
  'sheet', 'sheets', 'treatment', 'treatments', 'management', 'plan', 'plans', 'immediate', 'chart', 'charts', 'ward',
  'wards', 'department', 'dept', 'unit', 'clinic', 'notes', 'record', 'records', 'form', 'forms', 'page',
  'history', 'clinical', 'progress', 'nursing', 'medication', 'medications', 'drug', 'drugs', 'prescription',
  'prescriptions', 'orders', 'admission', 'summary', 'assessment', 'examination', 'findings',
  'emergency', 'casualty', 'outpatient', 'inpatient', 'general', 'patient', 'patients', 'kardex', 'continuation',
  'details',
  // Department and specialty names (only with a form-label word: "Department of Surgery", "Trauma surgery treatment
  // sheet"; "Surgery" or "ICU" alone is kept).
  'surgery', 'surgical', 'medicine', 'medical', 'trauma', 'orthopaedic', 'orthopaedics', 'orthopedic', 'orthopedics',
  'paediatric', 'paediatrics', 'pediatric', 'pediatrics', 'obstetric', 'obstetrics', 'gynaecology', 'gynecology',
  'gynaecological', 'o&g', 'cardiology', 'neurology', 'neurosurgery', 'oncology', 'psychiatry', 'internal', 'ent',
  'ophthalmology', 'urology', 'renal', 'maternity', 'labour', 'icu', 'hdu', 'a&e', 'opd', 'gopd', 'sopd', 'accident',
  'dental', 'dermatology', 'haematology', 'hematology', 'nephrology', 'gastroenterology', 'endocrinology',
]);
/** Words allowed between heading words ("Accident and Emergency", "Department of Surgery"); never "for". */
export const CONNECTOR_WORDS: ReadonlySet<string> = new Set(['and', 'of', 'the', '&']);
/** The words that make a run of heading words a form label or title ("Treatment sheet", "Ward notes"). */
export const FORM_LABEL_WORDS: ReadonlySet<string> = new Set(['sheet', 'sheets', 'form', 'forms', 'record', 'records',
  'notes', 'kardex', 'continuation', 'department', 'dept', 'unit']);
/** "Chart" is a title only beside one of these ("Drug chart"); "Vital signs chart" or "Fluid chart" is a plan. */
const CHART_TITLE_WORDS: ReadonlySet<string> = new Set(['drug', 'drugs', 'medication', 'medications', 'prescription',
  'prescriptions', 'treatment', 'treatments', 'kardex']);
/** Exact headings without a form-label word (words joined by one space, "&" as "and"). */
export const HEADING_PHRASES: ReadonlySet<string> = new Set(['plan', 'plans', 'immediate management',
  'plan of management', 'accident and emergency']);
/** Instruction words that make a note an instruction, never a heading (with STATUS_WORDS and INSTRUCTION_WORDS). */
export const INSTRUCTION_VERBS: ReadonlySet<string> = new Set([
  'transfer', 'transferred', 'switch', 'stop', 'give', 'admit', 'admitted', 'discharge', 'discharged', 'review',
  'continue', 'start', 'refer', 'referred', 'repeat', 'check', 'monitor', 'send', 'call', 'observe', 'keep', 'nbm',
  'commence', 'change', 'increase', 'reduce', 'withhold', 'hold', 'omit', 'encourage', 'advise', 'counsel', 'book',
  'arrange', 'consult', 'do', 'take', 'administer', 'insert', 'remove', 'dress', 'nurse', 'follow', 'f/u', 'fu',
  'recheck', 'chase', 'inform', 'notify', 'transfuse', 'catheterise', 'catheterize', 'elevate', 'mobilise', 'mobilize',
  'see', 'seen', 'tco', 'tto',
]);

/** A word with "?" and punctuation off, lower case; "&" and "/" kept ("o&g", "d/c"). */
const plainWord = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}&/]/gu, '').replace(/^\/+|\/+$/g, '');
const isInstruction = (word: string) => INSTRUCTION_VERBS.has(word) || STATUS_WORDS.test(word) || INSTRUCTION_WORDS.test(word);

/** The words of a reading, or null where it holds a bracketed group or reading mark (such a note is never dropped). */
function plainWords(text: string): string[] | null {
  if (/[()[\]…]/.test(text)) return null;
  return text.split(/[\s—–-]+/).map(plainWord).filter(Boolean);
}

/** Whether a note is a page heading, section title or form label (see the header). */
export function isHeadingNote(item: PaperItem): boolean {
  if (item.kind !== 'note') return false;
  const texts = [item.asWritten, item.fields.text ?? ''].filter((text) => text.trim() !== '');
  if (texts.length === 0) return false;
  return texts.every((text) => {
    const list = plainWords(text);
    if (list === null || list.length === 0 || /\d/.test(text)) return false;
    if (!list.some((word) => HEADING_WORDS.has(word))) return false;
    if (!list.every((word) => HEADING_WORDS.has(word) || CONNECTOR_WORDS.has(word))) return false;
    if (list.some(isInstruction)) return false;
    const labelled = list.some((word) => FORM_LABEL_WORDS.has(word))
      || (list.some((word) => word === 'chart' || word === 'charts') && list.some((word) => CHART_TITLE_WORDS.has(word)))
      || HEADING_PHRASES.has(list.map((word) => (word === '&' ? 'and' : word)).join(' '));
    if (!labelled) return false;
    const whole = text.replace(/\?/g, ' ').trim();
    if (list.some((word) => word.length > 2 && matchDrugName(word) !== null) || matchDrugName(whole) !== null) return false;
    return matchDiagnosisName(whole) === null && matchLabTestName(whole) === null;
  });
}

/** What a stop, hold, change or other instruction word stands for, so "DC", "d/c" and "stopped" are one cue. */
function cueOf(word: string): string | null {
  if (/^(?:stops?|stopped|stopping|stp|discont\p{L}*|disc|d\/c|dc|cease\p{L}*|cancel\p{L}*|canx|withdr\p{L}*|off|halt\p{L}*)$/u
    .test(word)) return 'stop';
  if (/^(?:hold|holding|held|withh\p{L}*|omit|omitted|suspend\p{L}*)$/u.test(word)) return 'hold';
  if (/^(?:switch\p{L}*|chang\p{L}*|convert\p{L}*)$/u.test(word)) return 'switch';
  if (/^(?:start\p{L}*|commenc\p{L}*|give|given)$/u.test(word)) return 'start';
  if (/^(?:continu\p{L}*|cont)$/u.test(word)) return 'continue';
  if (/^(?:restart\p{L}*|resum\p{L}*)$/u.test(word)) return 'restart';
  if (/^(?:reduc\p{L}*|taper\p{L}*|wean\p{L}*)$/u.test(word)) return 'reduce';
  if (/^increas\p{L}*$/u.test(word)) return 'increase';
  return null;
}
/** Every name the drug list gives a generic (letters and digits), for the duplicate rule. */
const NAMES_BY_GENERIC = new Map<string, Set<string>>();
for (const entry of DRUG_ENTRIES) {
  const names = NAMES_BY_GENERIC.get(entry.target) ?? new Set<string>();
  for (const word of entry.key.split(' ')) names.add(word);
  NAMES_BY_GENERIC.set(entry.target, names);
}

/** Whether a note only repeats a stopped medicine's stop (see the header). */
export function duplicatesOrder(note: PaperItem, medicine: PaperItem): boolean {
  if (note.kind !== 'note' || medicine.kind !== 'medicine') return false;
  const samePlace = note.lineIds.some((id) => medicine.lineIds.includes(id))
    || overlapShare(note.box, medicine.box) >= PAIR_BOX_OVERLAP;
  if (!samePlace) return false;
  const list = plainWords(note.asWritten);
  if (list === null || list.length === 0) return false;
  const name = medicine.fields.name ?? '';
  const drug = new Set(normaliseDrugName(name).split(' ').filter(Boolean));
  const generic = matchDrugName(name.replace(/\([^)]*\)/g, ' '))?.generic
    ?? /\(([^()]+)\)/.exec(name)?.[1]?.trim().toLowerCase() ?? null;
  if (generic) for (const word of [...generic.split(' '), ...(NAMES_BY_GENERIC.get(generic) ?? [])]) drug.add(word);
  // Only a stop beside a medicine whose status is stopped (see the header): never a cue taken from its writing.
  if (medicine.fields.status !== 'stopped') return false;
  let named = false;
  let stop = false;
  for (const word of list) {
    if (drug.has(word)) { named = true; continue; }
    if (cueOf(word) !== 'stop') return false;
    stop = true;
  }
  return named && stop;
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
