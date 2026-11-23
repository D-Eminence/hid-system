import { BRAND_ROWS, isActiveBrandRow } from './brand-names';
import { GENERATED_DRUG_GENERICS } from './drug-generics.generated';
import { editDistance, fuzzyListMatch, letterCount, LOOKALIKE_DISTANCE, MAX_EDIT_DISTANCE, MIN_FUZZY_LETTERS,
  MIN_SIMILARITY, NOT_FOR_LISTS, type ListEntry } from './list-match';

/**
 * The medicine names a hard page's best-guess drug name may be shown as (owner decision of 2026-11-05, about
 * 18:40 UTC: "Yes, use a drug list"). Used only on hard pages (see reader.ts, hard-page reads): a drug name the
 * model proposes is shown in the list's spelling when it matches a name here; otherwise (since the owner decision of
 * 2026-11-06, about 10:13 UTC) it is shown as read with "?" (hard-page.ts); before, it was "[unreadable]".
 * The list never adds a drug: it only checks, and respells, a name the model itself proposed.
 *
 * SOURCE (generic names, since 2026-11-23, on the owner's word relayed by the coordinator: "the owner wants the new
 * medicine list used by the OCR too"): the medicine rows of docs/codes/drafts/hid-medicines-and-lab-tests.csv, the
 * draft medicine and lab-test list (its README gives the details below). NEML_GENERICS is generated from it into
 * drug-generics.generated.ts by scripts/generate-ocr-drug-list.mjs; the worker never reads the CSV, and
 * drug-generics.spec.ts proves the generated file matches it. The CSV's medicines come from:
 * - Federal Ministry of Health and Social Welfare, Nigeria. "Nigeria Essential Medicines List for Adults", 8th
 *   edition, 2024 (foreword by the Coordinating Minister of Health and Social Welfare; published on the Ministry's
 *   site in August 2025): the main list and the restricted list (Appendix 2). Copy read on 2026-11-20:
 *     https://health.gov.ng/wp-content/uploads/2025/08/Final-NEML-Adult-8th-Edition.pdf
 *     (105 pages, sha256 00511d93ea52ee1c794682be6138f221c77cb88029890204ec61f2021bf6152b)
 *   The document says "All rights reserved" and presents the list "for use by the public"; it gives no licence.
 *   Only facts (medicine names) are taken; the owner is asked to confirm this use (docs/codes/drafts/README.md).
 * - World Health Organization. "WHO Model List of Essential Medicines", 24th list, 2025 ("The selection and use of
 *   essential medicines, 2025"; https://doi.org/10.2471/B09474; the PDF the owner supplied, 74 pages, sha256
 *   69daf7c8399b85978ba85e143d3af34e6ccf7f3d493b1e056daa7ef909d64eb2): only the medicines the Nigeria list lacks.
 *   Licence CC BY-NC-SA 3.0 IGO (non-commercial use, with attribution); the owner chose to use these facts on
 *   2026-11-22. Cite: "WHO Model List of Essential Medicines, 24th list. Geneva: World Health Organization; 2025.
 *   Licence: CC BY-NC-SA 3.0 IGO."
 * Left out by the CSV: the Nigeria list's primary health care lists, its list for patent and proprietary medicine
 * vendors and its vitamin appendix (nearly all their medicines are on the main list), and the WHO list's devices,
 * supplies, disinfectants and blood components. Every other medicine row is here, vaccines and immunoglobulins
 * included. The CSV is a draft awaiting a clinician's sign-off (Q124 A); the drug list uses its names as they stand.
 * Spelling: the CSV gives each name as its INN in lower case, with the source's misprints already corrected (its
 * notes column says where). A fixed combination is listed as written ("amoxicillin + clavulanic acid"); its parts
 * are listed on their own only where the CSV has them on their own. The few CSV names with a comma or brackets are
 * rewritten once, readably, by the script (its CLEANED_NAMES: "charcoal, activated" reads "activated charcoal").
 *
 * Until 2026-11-23 the names were typed by hand from the Nigeria Essential Medicines List, 7th edition, 2020
 * (https://extranet.who.int/cpcd/sites/default/files/public_file_repository/NGA_Nigeria-Essential-Medicine-List_2020.pdf).
 * Each name on that list that the new list gives under another spelling or salt is kept in SYNONYMS (marked "kept
 * from the 7th edition list"), so it is still recognised; the names the new list does not have in any form were
 * dropped.
 *
 * Other names for the same medicine (SYNONYMS): names the lists give in brackets or as "listed as" (adrenaline,
 * hydroxyurea, aspirin, co-trimoxazole, cyclosporin, busulphan, cytisinicline), the 7th edition names above, and a
 * few British, US and older names still written on Nigerian charts, marked as added here.
 *
 * BRAND NAMES (BRAND_NAMES, kept apart): the active rows of the data table in brand-names.ts, each with its source
 * (a NAFDAC Greenbook listing, registration number and address, or for the brands curated before the table
 * 'coordinator-curated 2026-11') and reviewed_by. Each maps to its generic name on the list above or, for a
 * combination brand the list does not have as a combination (Ampiclox: ampicillin + cloxacillin), to the generics
 * it combines, each of which is on the list. A row whose generic is not on the list is kept in the table but not
 * used (BRANDS_WITH_UNLISTED_GENERIC) until a reviewer points it at a listed name. A brand is shown as
 * "Brand? (generic)". Only true brand names; a manufacturer's name alone (such as a company that makes paracetamol)
 * is never a brand here.
 */

/** Generic medicine names, generated from docs/codes/drafts/hid-medicines-and-lab-tests.csv; see the header. */
export const NEML_GENERICS: readonly string[] = GENERATED_DRUG_GENERICS;

/**
 * Other names for a medicine on the list, each mapped to the name on NEML_GENERICS that is shown: the lists' own
 * bracketed names, the 7th edition list's names that the new list spells differently, and (marked "added") British,
 * US or older names still written on Nigerian charts.
 */
export const SYNONYMS: Readonly<Record<string, string>> = {
  'adrenaline': 'epinephrine',
  'hydroxyurea': 'hydroxycarbamide',
  'aspirin': 'acetylsalicylic acid',
  'co-trimoxazole': 'sulfamethoxazole + trimethoprim',
  'cyclosporin': 'ciclosporin',
  'busulphan': 'busulfan',
  'cytisinicline': 'cytisine',
  'vitamin k1': 'phytomenadione',
  'vitamin c': 'ascorbic acid',
  'vitamin d': 'colecalciferol',
  'cholecalciferol': 'colecalciferol',
  'vitamin a': 'retinol',
  'vitamin b1': 'thiamine',
  'vitamin b2': 'riboflavin',
  'vitamin b6': 'pyridoxine',
  'leuprolide': 'leuprorelin',
  'stilboestrol': 'diethylstilbestrol',
  'thioguanine': 'tioguanine',
  'mechlorethamine': 'chlormethine',
  'actinomycin d': 'dactinomycin',
  'torsemide': 'torasemide',
  'desferoxamine': 'deferoxamine',
  'imipenem': 'imipenem + cilastatin',
  // Kept from the 7th edition list: its name for a medicine the new list gives under another spelling or salt.
  'chlorpheniramine': 'chlorphenamine',
  'benzhexol': 'trihexyphenidyl',
  'sodium valproate': 'valproic acid',
  'desferrioxamine': 'deferoxamine',
  'methylene blue': 'methylthioninium chloride',
  'gentian violet': 'methylrosanilinium chloride',
  'prothionamide': 'protionamide',
  'bendrofluazide': 'bendroflumethiazide',
  'dabigatran': 'dabigatran etexilate',
  'fluocinolone': 'fluocinolone acetonide',
  'fluticasone': 'fluticasone furoate',
  'ferrous sulfate': 'ferrous salt',
  'isophane insulin': 'intermediate-acting insulin',
  'lugol\'s iodine': 'iodine + potassium iodide',
  'triiodothyronine': 'liothyronine',
  'sodium bicarbonate': 'sodium hydrogen carbonate',
  'calcium lactate': 'calcium',
  'lithium carbonate': 'lithium',
  // Added (not in the lists' brackets): British and older names commonly written in Nigeria.
  'frusemide': 'furosemide',
  'co-amoxiclav': 'amoxicillin + clavulanic acid',
  'lignocaine': 'lidocaine',
  'phenobarbitone': 'phenobarbital',
  'salbutamol sulphate': 'salbutamol',
  'ferrous sulphate': 'ferrous salt',
  'magnesium sulphate': 'magnesium sulfate',
  'hyoscine n-butylbromide': 'hyoscine butylbromide',
  'ors': 'oral rehydration salts',
  // Added (not in the lists' brackets): US names.
  'glyburide': 'glibenclamide',
  'acyclovir': 'aciclovir',
};

const LISTED_GENERICS = new Set(NEML_GENERICS);
/** Whether a brand row's generic is on the list, as written or (for a combination brand) each part on its own. */
const genericIsListed = (generic: string) =>
  LISTED_GENERICS.has(generic) || generic.split(' + ').every((part) => LISTED_GENERICS.has(part));

/** Brand names: the active rows of brand-names.ts (see there) whose generic is on the list, brand to generic. */
export const BRAND_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  BRAND_ROWS.filter((row) => isActiveBrandRow(row) && genericIsListed(row.generic)).map((row) => [row.brand, row.generic]));

/**
 * Active brand rows whose generic is not on the list, so not used: humulin ('insulin', a brand sold as several
 * insulins, while the list names each insulin on its own). Kept in brand-names.ts for a reviewer to point at a
 * listed name.
 */
export const BRANDS_WITH_UNLISTED_GENERIC: readonly string[] = BRAND_ROWS
  .filter((row) => isActiveBrandRow(row) && !genericIsListed(row.generic)).map((row) => row.brand);

/**
 * Fuzzy match thresholds: the shared strict rules of list-match.ts (one edit, similarity 0.85, same first letter,
 * same short words and digits, names of six letters or more, ambiguous is no match). Most look-alike medicines
 * differ at the start (pefloxacin / ofloxacin, esomeprazole / omeprazole). A name within LOOKALIKE_DISTANCE of a
 * real medicine that is not on the list (UNLISTED_LOOKALIKES) is no match either, since the proposal may well be
 * that medicine.
 */
export { editDistance, LOOKALIKE_DISTANCE, MAX_EDIT_DISTANCE, MIN_FUZZY_LETTERS, MIN_SIMILARITY };

/**
 * Real medicines that are not on the list but are spelled within a letter or two of one that is (curated, not
 * exhaustive). A proposed name near one of these is never respelled into the listed medicine: on a hard page it is
 * shown as read with the listed one as the other option, "Arteether? (or Artemether?)" (drugLookalike). Each is
 * within LOOKALIKE_DISTANCE of a listed name. The edit-distance and first-letter rules above already keep most of
 * them apart; this keeps apart a misreading of one of them as well (arteether is one letter from artemether, which
 * the distance rule alone would let through). Lorazepam and folinic acid left this list on 2026-11-23, when the new
 * source listed them; gemifloxacin left it then too, since gatifloxacin, the listed name it was near, is not on the
 * new list.
 */
export const UNLISTED_LOOKALIKES: readonly string[] = [
  'arteether', 'clobetasone', 'pefloxacin', 'norfloxacin', 'esomeprazole', 'ganciclovir',
  'famciclovir', 'oxazepam', 'felodipine', 'nisoldipine', 'prednisone', 'dicloxacillin', 'ornidazole',
  'econazole', 'bifonazole', 'tioconazole', 'methsuximide', 'dihydralazine', 'quinidine', 'rocuronium',
  'ropivacaine', 'mepivacaine', 'digitoxin', 'fosinopril', 'pentobarbital', 'saxagliptin',
];

/** Salt and form words written after a name that do not change which medicine it is. */
const SALT_WORDS = new Set(['hydrochloride', 'hcl', 'sodium', 'potassium', 'sulfate', 'sulphate', 'maleate',
  'phosphate', 'acetate', 'citrate', 'tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules',
  'inj', 'injection', 'syrup', 'syr', 'susp', 'suspension', 'cream', 'oint', 'ointment', 'drops', 'iv', 'im', 'po']);

/** Lower case, "?" and punctuation other than "+" and "-" removed, "/" and "&" read as "+", spaces collapsed. */
export function normaliseDrugName(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[/&]/g, ' + ')
    .replace(/[^a-z0-9+\-' ]/g, ' ').replace(/\s*\+\s*/g, ' + ').replace(/\s+/g, ' ').trim();
}

const withoutSalts = (name: string) => name.split(' ').filter((word) => !SALT_WORDS.has(word)).join(' ').trim();

export interface DrugMatch {
  /** The generic name(s) the proposed name stands for, as on the list. */
  generic: string;
  /** The brand name as listed, when the proposed name matched a brand. */
  brand: string | null;
  /** What the drug name field shows: "Generic?" or "Brand? (generic)". Always marked "?" (a best guess). */
  display: string;
  /** Whether the proposed name was a listed name as written (not respelled by the fuzzy match). */
  exact: boolean;
}

type Entry = ListEntry<{ generic: string; brand: string | null }>;
const entry = (name: string, generic: string, brand: string | null): Entry =>
  ({ key: normaliseDrugName(name), target: generic, value: { generic, brand } });
/** Every name the drug list knows, normalised, with the generic it stands for (list-match.spec.ts checks them all). */
export const DRUG_ENTRIES: readonly Entry[] = [
  ...NEML_GENERICS.map((name) => entry(name, name, null)),
  ...Object.entries(SYNONYMS).map(([name, generic]) => entry(name, generic, null)),
  ...Object.entries(BRAND_NAMES).map(([name, generic]) => entry(name, generic, name)),
];

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const LOOKALIKE_KEYS = UNLISTED_LOOKALIKES.map(normaliseDrugName);

/**
 * The listed medicine a proposed drug name stands for, or null. Exact (normalised, salt and form words taken off)
 * first; then the closest by edit distance within the thresholds, only when one medicine is closest, it starts with
 * the same letter, and no unlisted look-alike is as near. "[unreadable]", "[?]" or a name with no letters never
 * matches.
 */
export function matchDrugName(proposed: string): DrugMatch | null {
  if (NOT_FOR_LISTS.test(proposed)) return null;
  const whole = normaliseDrugName(proposed);
  if (letterCount(whole) === 0) return null;
  const candidates = [...new Set([whole, withoutSalts(whole)].filter((name) => name.length > 0))];
  const found = ({ value: { generic, brand } }: Entry, exact: boolean): DrugMatch => ({ generic, brand, exact,
    display: brand === null ? `${capitalise(generic)}?` : `${capitalise(brand)}? (${generic})` });
  for (const name of candidates) {
    const exact = DRUG_ENTRIES.find((candidate) => candidate.key === name);
    if (exact) return found(exact, true);
  }
  const best = fuzzyListMatch(candidates, DRUG_ENTRIES);
  if (best === null) return null;
  const nearUnlisted = candidates.some((name) =>
    LOOKALIKE_KEYS.some((key) => editDistance(name, key) <= LOOKALIKE_DISTANCE));
  return nearUnlisted ? null : found(best.entry, false);
}

/**
 * The listed medicine a proposed name would have been respelled into, where the strict fuzzy match found one but a
 * real unlisted look-alike (UNLISTED_LOOKALIKES) is as near, so matchDrugName refused it; else null ("Arteether" is
 * a letter from the listed artemether). Never used to pick a name: hard-page.ts shows the name as read with this one
 * as the other option, "Arteether? (or Artemether?)", so a look-alike pair is never resolved silently.
 */
export function drugLookalike(proposed: string): DrugMatch | null {
  if (NOT_FOR_LISTS.test(proposed) || matchDrugName(proposed) !== null) return null;
  const whole = normaliseDrugName(proposed);
  if (letterCount(whole) === 0) return null;
  const candidates = [...new Set([whole, withoutSalts(whole)].filter((name) => name.length > 0))];
  const best = fuzzyListMatch(candidates, DRUG_ENTRIES);
  if (best === null) return null;
  const { generic, brand } = best.entry.value;
  return { generic, brand, exact: false,
    display: brand === null ? `${capitalise(generic)}?` : `${capitalise(brand)}? (${generic})` };
}
