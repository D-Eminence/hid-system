/**
 * Allergy check at prescribing (0124). A small, conservative matcher: it
 * warns when the medicine's name (display text and code) names the same
 * medicine as an allergy, a medicine of the same class (penicillins,
 * cephalosporins, sulfonamides, NSAIDs), or a class with known
 * cross-reactivity (penicillins and cephalosporins). It is a safety prompt,
 * not a full drug-interaction database: no match never means "safe".
 */

export type AllergySource = 'recorded' | 'patient_reported';
export type AllergyMatchKind = 'same_medicine' | 'same_class' | 'cross_reactivity';

export interface AllergyForCheck {
  source: AllergySource;
  /** A recorded allergy's id; absent for the patient's own text. */
  id?: string;
  substance: string;
  reaction?: string | null;
  severity?: string | null;
}

export interface AllergyMatch {
  source: AllergySource;
  allergyId?: string;
  substance: string;
  reaction: string | null;
  severity: string | null;
  matchKind: AllergyMatchKind;
  /** The class that matched, in plain words (e.g. "penicillins"); absent for the same medicine. */
  className?: string;
  /** One plain-English sentence for the prescriber. */
  message: string;
}

interface DrugClass {
  key: 'penicillins' | 'cephalosporins' | 'sulfonamides' | 'nsaids';
  label: string;
  /** Words that name the class itself in an allergy ("penicillin allergy", "sulfa drugs"). */
  classWords: readonly string[];
  /** Generic and common brand names of members (lower case, whole words). */
  members: readonly string[];
  /** Name prefixes that identify members (e.g. "cef"). */
  prefixes?: readonly string[];
}

export const DRUG_CLASSES: readonly DrugClass[] = [
  {
    key: 'penicillins', label: 'penicillins',
    classWords: ['penicillin', 'penicillins'],
    members: ['amoxicillin', 'amoxycillin', 'ampicillin', 'cloxacillin', 'flucloxacillin', 'dicloxacillin',
      'oxacillin', 'nafcillin', 'piperacillin', 'ticarcillin', 'benzylpenicillin', 'phenoxymethylpenicillin',
      'benzathine', 'procaine penicillin', 'co-amoxiclav', 'co amoxiclav', 'coamoxiclav', 'augmentin', 'ampiclox', 'amoxil',
      'tazocin', 'pivmecillinam', 'temocillin'],
  },
  {
    key: 'cephalosporins', label: 'cephalosporins',
    classWords: ['cephalosporin', 'cephalosporins'],
    members: ['cefalexin', 'cephalexin', 'cefadroxil', 'cefazolin', 'cefaclor', 'cefuroxime', 'cefprozil',
      'cefixime', 'cefpodoxime', 'cefdinir', 'cefotaxime', 'ceftriaxone', 'ceftazidime', 'cefepime',
      'ceftaroline', 'cefoxitin', 'zinnat', 'rocephin'],
    prefixes: ['cef', 'ceph'],
  },
  {
    key: 'sulfonamides', label: 'sulfonamide antibiotics',
    classWords: ['sulfa', 'sulpha', 'sulfonamide', 'sulfonamides', 'sulphonamide', 'sulphonamides'],
    members: ['sulfamethoxazole', 'sulphamethoxazole', 'co-trimoxazole', 'co trimoxazole', 'cotrimoxazole', 'trimethoprim-sulfamethoxazole',
      'septrin', 'bactrim', 'sulfadiazine', 'sulphadiazine', 'sulfadoxine', 'sulphadoxine', 'fansidar',
      'sulfasalazine', 'sulphasalazine', 'silver sulfadiazine'],
  },
  {
    key: 'nsaids', label: 'NSAIDs (anti-inflammatory painkillers)',
    classWords: ['nsaid', 'nsaids', 'non-steroidal', 'nonsteroidal', 'anti-inflammatory', 'antiinflammatory'],
    members: ['ibuprofen', 'diclofenac', 'naproxen', 'aspirin', 'acetylsalicylic', 'piroxicam', 'indomethacin',
      'indometacin', 'ketoprofen', 'meloxicam', 'celecoxib', 'etoricoxib', 'mefenamic', 'ketorolac',
      'aceclofenac', 'flurbiprofen', 'nabumetone', 'etodolac', 'voltaren', 'brufen', 'cataflam', 'felvin'],
  },
];

/** Pairs with recognised cross-reactivity: [allergy class, medicine class]. */
const CROSS_REACTIVE: readonly (readonly [DrugClass['key'], DrugClass['key']])[] = [
  ['penicillins', 'cephalosporins'],
  ['cephalosporins', 'penicillins'],
];

/** Words that are never an allergy on their own. */
const NOT_AN_ALLERGY = new Set(['none', 'nil', 'no', 'nkda', 'nka', 'n/a', 'na', 'unknown', 'not known',
  'no known allergies', 'no known drug allergies', 'no allergies', 'none known']);
const FILLER = new Set(['allergy', 'allergies', 'allergic', 'to', 'drug', 'drugs', 'medicine', 'medicines',
  'antibiotic', 'antibiotics', 'tablet', 'tablets', 'injection', 'class', 'group', 'and', 'or', 'the', 'of', 'a', 'an']);

/** Lower case, letters, digits and hyphens kept; everything else one space. */
export function normalizeMedicineText(value: string): string {
  return ` ${value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function hasWord(normalized: string, word: string): boolean {
  return normalized.includes(` ${normalizeMedicineText(word).trim()} `);
}

function words(normalized: string): string[] {
  return normalized.trim().split(' ').filter((word) => word.length > 0);
}

function classesOf(normalized: string, includeClassWords: boolean): DrugClass[] {
  return DRUG_CLASSES.filter((drugClass) =>
    (includeClassWords && drugClass.classWords.some((word) => hasWord(normalized, word)))
    || drugClass.members.some((member) => hasWord(normalized, member))
    || (drugClass.prefixes ?? []).some((prefix) => words(normalized).some((word) => word.startsWith(prefix) && word.length >= 6)));
}

/** Known member names that appear in a text. */
function membersIn(normalized: string): string[] {
  return DRUG_CLASSES.flatMap((drugClass) => drugClass.members.filter((member) => hasWord(normalized, member)));
}

/**
 * The allergy text as separate terms: a patient may write "Penicillin, sulfa
 * drugs; peanuts". Blank, "none" and similar are dropped.
 */
export function allergyTerms(text: string): string[] {
  return text.split(/[,;\n/|]+|\band\b|\s\+\s/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && !NOT_AN_ALLERGY.has(term.toLowerCase().replace(/[.!]+$/, '').trim()));
}

/** The meaningful words of an allergy term (fillers dropped), at least 4 letters each. */
function significantWords(normalizedTerm: string): string[] {
  return words(normalizedTerm).filter((word) => word.length >= 4 && !FILLER.has(word) && !/^\d+$/.test(word));
}

function describe(source: AllergySource, substance: string): string {
  return source === 'recorded' ? `a recorded allergy to ${substance}` : `an allergy the patient reported (${substance})`;
}

/**
 * Every allergy that matches the medicine, at most one match per allergy term
 * (the strongest: same medicine, then same class, then cross-reactivity).
 */
export function matchAllergies(
  medicine: { display: string; code?: string | null },
  allergies: readonly AllergyForCheck[],
): AllergyMatch[] {
  const drugText = normalizeMedicineText(`${medicine.display} ${medicine.code ?? ''}`);
  const drugClasses = classesOf(drugText, false);
  const drugMembers = membersIn(drugText);
  const matches: AllergyMatch[] = [];
  for (const allergy of allergies) {
    const terms = allergy.source === 'patient_reported' ? allergyTerms(allergy.substance) : [allergy.substance];
    for (const term of terms) {
      const normalizedTerm = normalizeMedicineText(term);
      const base = {
        source: allergy.source, ...(allergy.id ? { allergyId: allergy.id } : {}),
        substance: allergy.source === 'patient_reported' ? term : allergy.substance,
        reaction: allergy.reaction ?? null, severity: allergy.severity ?? null,
      };
      const what = describe(allergy.source, base.substance);
      const termWords = significantWords(normalizedTerm);
      const sameMedicine = termWords.some((word) => hasWord(drugText, word))
        || drugMembers.some((member) => hasWord(normalizedTerm, member));
      if (sameMedicine) {
        matches.push({ ...base, matchKind: 'same_medicine',
          message: `This medicine may be the same as ${what}.` });
        continue;
      }
      const allergyClasses = classesOf(normalizedTerm, true);
      const shared = allergyClasses.find((allergyClass) => drugClasses.some((drugClass) => drugClass.key === allergyClass.key));
      if (shared) {
        matches.push({ ...base, matchKind: 'same_class', className: shared.label,
          message: `This medicine is in the same group (${shared.label}) as ${what}.` });
        continue;
      }
      const cross = CROSS_REACTIVE.find(([allergyKey, drugKey]) =>
        allergyClasses.some((allergyClass) => allergyClass.key === allergyKey)
        && drugClasses.some((drugClass) => drugClass.key === drugKey));
      if (cross) {
        const drugClass = DRUG_CLASSES.find((candidate) => candidate.key === cross[1])!;
        const allergyClass = DRUG_CLASSES.find((candidate) => candidate.key === cross[0])!;
        matches.push({ ...base, matchKind: 'cross_reactivity', className: drugClass.label,
          message: `This medicine is one of the ${drugClass.label}. Some people allergic to ${allergyClass.label} `
            + `also react to ${drugClass.label} (${what}).` });
      }
    }
  }
  return matches;
}
