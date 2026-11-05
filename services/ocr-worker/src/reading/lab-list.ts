import { listEntries, matchListName, type ListMatch } from './diagnosis-list';
import type { ListEntry } from './list-match';

/**
 * Laboratory test names a hard page's best-guess lab result may be grounded to (owner decision of 2026-11-05, about
 * 21:00 UTC, relayed by the coordinator: "add all those list now"). Our own names and the abbreviations written on
 * Nigerian request forms and result slips, in our own words: no LOINC content, names or codes. Curated, not
 * exhaustive. Matching is the strict matching of list-match.ts, applied only on hard pages (hard-page.ts), like the
 * drug list: an abbreviation is shown as read with the name after it, "FBC? (full blood count)"; a name already
 * listed as written is left as read; an unlisted test is left as read.
 *
 * Left out on purpose, as they stand for more than one test: "PT" (prothrombin time or pregnancy test), "BG" (blood
 * group or blood glucose), "GT" and "CS". Such a name is never expanded (tested in list-match.spec.ts).
 */
export const LAB_TESTS: Readonly<Record<string, readonly string[]>> = {
  'full blood count': ['fbc', 'cbc', 'complete blood count'],
  'packed cell volume': ['pcv', 'haematocrit', 'hematocrit', 'hct'],
  'haemoglobin': ['hb', 'hgb', 'hemoglobin'],
  'white blood cell count': ['wbc', 'twbc', 'wcc', 'total white cell count', 'white cell count'],
  'platelet count': ['plt', 'platelets'],
  'erythrocyte sedimentation rate': ['esr'],
  'malaria parasite test': ['mp', 'mps', 'bfmp', 'blood film for malaria parasites', 'malaria parasites'],
  'malaria rapid diagnostic test': ['mrdt', 'malaria rdt'],
  'widal test': ['widal'],
  'random blood sugar': ['rbs', 'rbg', 'random blood glucose'],
  'fasting blood sugar': ['fbs', 'fbg', 'fasting blood glucose'],
  'hba1c': ['a1c', 'glycated haemoglobin', 'glycated hemoglobin'],
  'electrolytes, urea and creatinine': ['e/u/cr', 'eucr', 'e/u/c', 'u/e/cr', 'u&e', 'e&u', 'electrolytes urea creatinine',
    'eu cr'],
  'serum creatinine': ['creatinine', 'creat', 'cr'],
  'liver function tests': ['lft', 'lfts', 'liver function test'],
  'urinalysis': ['u/a', 'urine dipstick', 'urine analysis'],
  'microscopy, culture and sensitivity': ['mcs', 'm/c/s', 'm/c/s/', 'mc/s'],
  'urine microscopy, culture and sensitivity': ['urine mcs', 'urine m/c/s'],
  'hiv screening test': ['hiv screen', 'hiv screening', 'rvs', 'retroviral screening', 'hiv 1 & 2', 'hiv 1&2'],
  'hepatitis b surface antigen': ['hbsag'],
  'hepatitis c antibody': ['hcv', 'anti-hcv', 'anti hcv', 'hcv antibody'],
  'vdrl': ['vdrl test'],
  'lipid profile': ['flp', 'fasting lipid profile', 'lipids'],
  'prostate-specific antigen': ['psa'],
  'thyroid function tests': ['tft', 'tfts', 'thyroid function test'],
  'clotting profile': ['clotting screen', 'coagulation profile', 'clotting'],
  'prothrombin time and inr': ['pt/inr', 'pt inr'],
  'blood group': ['blood grouping', 'abo group', 'grouping'],
  'haemoglobin genotype': ['genotype', 'hb genotype', 'hb electrophoresis', 'haemoglobin electrophoresis'],
  'pregnancy test': ['upt', 'urine pregnancy test', 'preg test'],
  'c-reactive protein': ['crp'],
  'sputum afb': ['afb', 'sputum for afb', 'zn stain'],
  'stool microscopy': ['stool m/c/s', 'stool mcs', 'stool analysis'],
};

/** Every lab test name and abbreviation, normalised, with the name it stands for. */
export const LAB_ENTRIES: readonly ListEntry<string>[] = listEntries(Object.keys(LAB_TESTS),
  Object.fromEntries(Object.entries(LAB_TESTS).flatMap(([name, others]) => others.map((other) => [other, name]))));

/** The listed test a proposed lab test name stands for, or null (see diagnosis-list.ts matchListName). */
export function matchLabTestName(proposed: string): ListMatch | null {
  return matchListName(proposed, LAB_ENTRIES);
}
