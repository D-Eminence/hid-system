/**
 * Allergy check at prescribing (0124). A small, conservative matcher: it
 * warns when the medicine's name (display text and code) names the same
 * medicine as an allergy (brand names read as their generics, one-letter
 * misspellings of long names allowed), a medicine of the same class
 * (penicillins, cephalosporins, carbapenems, sulfonamides, NSAIDs), or a class
 * with known cross-reactivity (the beta-lactams; ceftazidime and aztreonam).
 * It is a safety prompt, not a full drug-interaction database: no match never
 * means "safe".
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
  /** A recorded allergy's facility, whether that is the current facility, and when it was recorded. */
  facilityId?: string;
  recordedHere?: boolean;
  recordedOn?: Date;
}

export interface AllergyMatch {
  source: AllergySource;
  /** A recorded allergy's id (the first, when the same allergy was recorded more than once). */
  allergyId?: string;
  /** Every recorded allergy this line stands for (the same substance, severity and reaction recorded more than once). */
  allergyIds?: string[];
  substance: string;
  reaction: string | null;
  severity: string | null;
  matchKind: AllergyMatchKind;
  /** The class that matched, in plain words (e.g. "penicillins"); absent for the same medicine. */
  className?: string;
  /** Whether a recorded allergy was recorded at the current facility (any of them, when grouped). */
  recordedHere?: boolean;
  /** When a recorded allergy was recorded (the latest, when grouped). */
  recordedOn?: Date;
  /** Plain English for the prescriber: the allergy and its severity, why it matched, and where it came from. */
  message: string;
}

type ClassKey = 'penicillins' | 'cephalosporins' | 'carbapenems' | 'sulfonamides' | 'nsaids';

interface DrugClass {
  key: ClassKey;
  /** The class in plain words, plural ("penicillins"). */
  label: string;
  /** One member of the class, for the cross-reactivity sentence ("a penicillin"). */
  singular?: string;
  /** Words that name the class itself in an allergy ("penicillin allergy", "sulfa drugs"). */
  classWords: readonly string[];
  /** Generic and common brand names of members (lower case, whole words). */
  members: readonly string[];
  /** Name prefixes that identify members (e.g. "cef"). */
  prefixes?: readonly string[];
  /** Word patterns that identify members (e.g. "-cillin"), tested on each word. */
  patterns?: readonly RegExp[];
}

const BETA_LACTAM_WORDS = ['beta-lactam', 'beta-lactams', 'betalactam', 'betalactams'];

export const DRUG_CLASSES: readonly DrugClass[] = [
  {
    key: 'penicillins', label: 'penicillins', singular: 'penicillin',
    // No bare "pen": "Bee stings (carries Epi pen)" must not name the penicillins.
    classWords: ['penicillin', 'penicillins', 'pcn', ...BETA_LACTAM_WORDS],
    members: ['amoxicillin', 'amoxycillin', 'ampicillin', 'cloxacillin', 'flucloxacillin', 'dicloxacillin',
      'oxacillin', 'nafcillin', 'piperacillin', 'ticarcillin', 'benzylpenicillin', 'phenoxymethylpenicillin',
      // The plain name, as written on "Penicillin V 250mg" or "Penicillin G": the medicine side
      // recognises a class only by members, prefixes and patterns, so the name itself must be a member.
      'penicillin', 'penicillin v', 'penicillin g', 'pen v', 'pen g', 'phenoxymethyl',
      'benzathine', 'procaine penicillin', 'co-amoxiclav', 'co amoxiclav', 'coamoxiclav', 'augmentin', 'ampiclox', 'amoxil',
      'tazocin', 'pivmecillinam', 'temocillin',
      'amoxiclav', 'amoxyclav', 'orbenin', 'floxapen', 'penbritin', 'clamoxyl', 'unasyn', 'pip-tazo'],
    // "-cillin" (and the misspelling "-cilin"); "amoxi-"/"amoxy-" but never amoxapine.
    patterns: [/cill?in/, /^amox[iy]/],
  },
  {
    key: 'cephalosporins', label: 'cephalosporins', singular: 'cephalosporin',
    classWords: ['cephalosporin', 'cephalosporins', ...BETA_LACTAM_WORDS],
    members: ['cefalexin', 'cephalexin', 'cefadroxil', 'cefazolin', 'cefaclor', 'cefuroxime', 'cefprozil',
      'cefixime', 'cefpodoxime', 'cefdinir', 'cefotaxime', 'ceftriaxone', 'ceftazidime', 'cefepime',
      'ceftaroline', 'cefoxitin', 'zinnat', 'rocephin'],
    prefixes: ['cef', 'ceph'],
  },
  {
    key: 'carbapenems', label: 'carbapenems', singular: 'carbapenem',
    classWords: ['carbapenem', 'carbapenems', ...BETA_LACTAM_WORDS],
    members: ['meropenem', 'imipenem', 'ertapenem', 'doripenem', 'meronem', 'tienam'],
    patterns: [/penem$/],
  },
  {
    key: 'sulfonamides', label: 'sulfonamides (“sulfa” medicines)',
    classWords: ['sulfa', 'sulpha', 'sulfonamide', 'sulfonamides', 'sulphonamide', 'sulphonamides', 'sulphur', 'sulfur'],
    members: ['sulfamethoxazole', 'sulphamethoxazole', 'co-trimoxazole', 'co trimoxazole', 'cotrimoxazole', 'trimethoprim-sulfamethoxazole',
      'septrin', 'bactrim', 'sulfadiazine', 'sulphadiazine', 'sulfadoxine', 'sulphadoxine', 'fansidar',
      'sulfasalazine', 'sulphasalazine', 'silver sulfadiazine',
      // "SP" is the usual antenatal note for sulfadoxine-pyrimethamine (IPTp); "SMX" and "Cotrim" are common shorthand.
      'sp', 'smx', 'cotrim'],
    // Sulfacetamide, sulfadimidine and the like; never sulfate or sulphate.
    patterns: [/^sul(f|ph)a(?!te)/],
  },
  {
    key: 'nsaids', label: 'NSAIDs, the anti-inflammatory painkillers',
    classWords: ['nsaid', 'nsaids', 'non-steroidal', 'nonsteroidal', 'anti-inflammatory', 'antiinflammatory'],
    members: ['ibuprofen', 'diclofenac', 'naproxen', 'aspirin', 'acetylsalicylic', 'piroxicam', 'indomethacin',
      'indometacin', 'ketoprofen', 'meloxicam', 'celecoxib', 'etoricoxib', 'mefenamic', 'ketorolac',
      'aceclofenac', 'flurbiprofen', 'nabumetone', 'etodolac', 'voltaren', 'brufen', 'cataflam', 'felvin',
      'ponstan', 'feldene', 'celebrex', 'indocid', 'toradol', 'mobic', 'arcoxia', 'nurofen', 'naprosyn', 'asa'],
  },
];

/** Pairs with recognised cross-reactivity: [allergy class, medicine class]. */
const CROSS_REACTIVE: readonly (readonly [ClassKey, ClassKey])[] = [
  ['penicillins', 'cephalosporins'],
  ['cephalosporins', 'penicillins'],
  ['penicillins', 'carbapenems'],
  ['cephalosporins', 'carbapenems'],
  ['carbapenems', 'penicillins'],
  ['carbapenems', 'cephalosporins'],
];

/** Single medicines that share a side chain: [allergy, medicine]. */
const SIDE_CHAIN: readonly (readonly [string, string])[] = [
  ['ceftazidime', 'aztreonam'],
  ['aztreonam', 'ceftazidime'],
];

/**
 * Brand and other names, with the generic names they are or contain. A text
 * that names one is read as naming the generics too, on both sides.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'flagyl': 'metronidazole',
  'coartem': 'artemether lumefantrine',
  'camoquin': 'amodiaquine',
  'septrin': 'sulfamethoxazole trimethoprim',
  'bactrim': 'sulfamethoxazole trimethoprim',
  'co trimoxazole': 'sulfamethoxazole trimethoprim',
  'cotrimoxazole': 'sulfamethoxazole trimethoprim',
  'fansidar': 'sulfadoxine pyrimethamine',
  'augmentin': 'amoxicillin clavulanic',
  'co amoxiclav': 'amoxicillin clavulanic',
  'amoxiclav': 'amoxicillin clavulanic',
  'amoxil': 'amoxicillin',
  'ampiclox': 'ampicillin cloxacillin',
  'orbenin': 'cloxacillin',
  'floxapen': 'flucloxacillin',
  'penbritin': 'ampicillin',
  'tazocin': 'piperacillin tazobactam',
  'zinnat': 'cefuroxime',
  'rocephin': 'ceftriaxone',
  'brufen': 'ibuprofen',
  'nurofen': 'ibuprofen',
  'voltaren': 'diclofenac',
  'cataflam': 'diclofenac',
  'felvin': 'piroxicam',
  'feldene': 'piroxicam',
  'ponstan': 'mefenamic',
  'celebrex': 'celecoxib',
  'indocid': 'indomethacin',
  'phytomenadione': 'vitamin k',
  'vitamin k1': 'vitamin k',
  'konakion': 'vitamin k',
  'hep b': 'hepatitis b',
  'hepatitis b': 'hep b',
  'bicarb': 'bicarbonate',
  'bicarbonate': 'bicarb',
};

/** Words that are never an allergy on their own. */
const NOT_AN_ALLERGY = new Set(['none', 'nil', 'no', 'nkda', 'nka', 'n/a', 'na', 'unknown', 'not known',
  'no known allergies', 'no known drug allergies', 'no allergies', 'none known']);
const FILLER = new Set(['allergy', 'allergies', 'allergic', 'to', 'drug', 'drugs', 'medicine', 'medicines',
  'antibiotic', 'antibiotics', 'tablet', 'tablets', 'injection', 'class', 'group', 'and', 'or', 'the', 'of', 'a', 'an',
  // How allergy notes describe a reaction ("Amoxicillin-induced rash", "Aspirin-sensitive asthma").
  'induced', 'sensitive', 'sensitivity', 'intolerance', 'intolerant', 'reaction', 'related',
  // Prefixes a hyphen splits off ("Anti-TB drugs", "Beta-lactam antibiotics", "Non-steroidal").
  'anti', 'non', 'beta', 'type']);
/**
 * Words that do not name a medicine on their own: salts, forms and the like.
 * They count only when an allergy has nothing more specific ("Vitamin K",
 * "Potassium chloride").
 */
const NON_SPECIFIC = new Set(['capsule', 'capsules', 'caps', 'syrup', 'suspension', 'solution', 'drops', 'cream', 'ointment',
  'lotion', 'infusion', 'oral', 'topical', 'spray', 'inhaler', 'sodium', 'potassium', 'calcium', 'magnesium', 'hydrochloride',
  'sulfate', 'sulphate', 'phosphate', 'acetate', 'citrate', 'maleate', 'tartrate', 'chloride', 'bromide', 'acid', 'vitamin',
  'vaccine', 'forte', 'plus']);

const SEVERITY_WORDS: Readonly<Record<string, string>> = {
  severe: 'SEVERE', moderate: 'moderate', mild: 'mild', unknown: 'severity not recorded',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Lower case, letters and digits kept; everything else, hyphens included, one
 * space. A hyphen separates words: "Amoxicillin-clavulanate" is two medicines
 * and "Amoxicillin-induced rash" names amoxicillin. List entries go through
 * the same function, so "co-amoxiclav" is "co amoxiclav" on both sides. The
 * British "sulph-" is spelled "sulf-", so "sulphate" and "sulfate" are one word.
 */
export function normalizeMedicineText(value: string): string {
  return ` ${value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/sulph/g, 'sulf')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** "No known allergies", "NKDA", "none" and the like: never recorded as an allergy. */
export function isNoKnownAllergy(text: string): boolean {
  return NOT_AN_ALLERGY.has(text.toLowerCase().replace(/[.!]+$/, '').trim());
}

function hasWord(normalized: string, word: string): boolean {
  return normalized.includes(` ${normalizeMedicineText(word).trim()} `);
}

function words(normalized: string): string[] {
  return normalized.trim().split(' ').filter((word) => word.length > 0);
}

/** The generic names of every alias a text contains. */
function genericsIn(normalized: string): string[] {
  return Object.entries(ALIASES).filter(([alias]) => hasWord(normalized, alias)).map(([, generic]) => generic);
}

/** The text with the generic names of every alias it contains appended. */
function expand(normalized: string): string {
  const generics = genericsIn(normalized);
  return generics.length ? `${normalized}${generics.join(' ')} ` : normalized;
}

/**
 * The same word, or a likely misspelling or plural of it: both at least 8
 * letters and one letter inserted, deleted or changed, or two neighbouring
 * letters swapped.
 */
export function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 8 || b.length < 8 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].flatMap((letter, index) => letter === b[index] ? [] : [index]);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!];
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let index = 0;
  while (index < short.length && short[index] === long[index]) index += 1;
  return short.slice(index) === long.slice(index + 1);
}

const CLASS_WORDS = new Set(DRUG_CLASSES.flatMap((drugClass) =>
  drugClass.classWords.map((word) => normalizeMedicineText(word).trim())));

function classesOf(normalized: string, includeClassWords: boolean): DrugClass[] {
  const textWords = words(normalized);
  return DRUG_CLASSES.filter((drugClass) =>
    (includeClassWords && drugClass.classWords.some((word) => hasWord(normalized, word)))
    || drugClass.members.some((member) => hasWord(normalized, member)
      || (!/[ -]/.test(member) && textWords.some((word) => near(word, member))))
    || (drugClass.prefixes ?? []).some((prefix) => textWords.some((word) => word.startsWith(prefix) && word.length >= 6))
    || (drugClass.patterns ?? []).some((pattern) => textWords.some((word) => pattern.test(word))));
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
    .filter((term) => term.length > 0 && !isNoKnownAllergy(term));
}

/**
 * The words of an allergy term that name a medicine (fillers and strengths
 * dropped). Salts, forms and words under 4 letters count only when nothing
 * more specific is left, and then every one of them must match.
 */
function nameWords(normalizedTerm: string): { words: string[]; every: boolean } {
  const kept = words(normalizedTerm).filter((word) => !FILLER.has(word) && !/^\d/.test(word));
  const specific = kept.filter((word) => word.length >= 4 && !NON_SPECIFIC.has(word));
  return specific.length ? { words: specific, every: false } : { words: kept, every: true };
}

function formatDay(value: Date): string {
  // The day in Nigeria (UTC+1, no daylight saving).
  const day = new Date(value.getTime() + 60 * 60 * 1000);
  return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

/** "Penicillin allergy: SEVERE (Anaphylaxis)." or "Patient-reported allergy: “penicillin”." */
function head(allergy: AllergyForCheck, term: string): string {
  if (allergy.source === 'patient_reported') return `Patient-reported allergy: “${term}”.`;
  const severity = SEVERITY_WORDS[allergy.severity ?? 'unknown'] ?? SEVERITY_WORDS.unknown;
  return `${allergy.substance} allergy: ${severity}${allergy.reaction ? ` (${allergy.reaction})` : ''}.`;
}

/** Where the allergy came from; empty for a recorded allergy with no date (tests). */
function origin(allergy: AllergyForCheck): string {
  if (allergy.source === 'patient_reported') {
    return 'Entered by the patient in their Health ID portal, not checked by a clinician.';
  }
  if (!allergy.recordedOn) return '';
  return `Recorded by a clinician at ${allergy.recordedHere ? 'this facility' : 'another facility'} on ${formatDay(allergy.recordedOn)}.`;
}

function sentence(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(' ');
}

/**
 * Every allergy that matches the medicine, at most one match per allergy term
 * (the strongest: same medicine, then same class, then cross-reactivity).
 * The same substance, severity and reaction recorded more than once (often at
 * different facilities) is one line, with every allergy id.
 */
export function matchAllergies(
  medicine: { display: string; code?: string | null },
  allergies: readonly AllergyForCheck[],
): AllergyMatch[] {
  const drugText = expand(normalizeMedicineText(`${medicine.display} ${medicine.code ?? ''}`));
  const drugWords = words(drugText);
  const drugClasses = classesOf(drugText, false);
  const drugMembers = membersIn(drugText);
  const named = (word: string) => hasWord(drugText, word)
    || (word.length >= 8 && !CLASS_WORDS.has(word) && drugWords.some((drugWord) => near(word, drugWord)));
  const matches: AllergyMatch[] = [];
  const grouped = new Map<string, { match: AllergyMatch; allergies: AllergyForCheck[]; why: string }>();
  for (const allergy of allergies) {
    const terms = allergy.source === 'patient_reported' ? allergyTerms(allergy.substance) : [allergy.substance];
    for (const term of terms) {
      const found = matchTerm(normalizeMedicineText(term), drugText, drugClasses, drugMembers, named);
      if (!found) continue;
      const match: AllergyMatch = {
        source: allergy.source, ...(allergy.id ? { allergyId: allergy.id, allergyIds: [allergy.id] } : {}),
        substance: allergy.source === 'patient_reported' ? term : allergy.substance,
        reaction: allergy.reaction ?? null, severity: allergy.severity ?? null,
        matchKind: found.matchKind, ...(found.className ? { className: found.className } : {}),
        ...(allergy.recordedHere !== undefined ? { recordedHere: allergy.recordedHere } : {}),
        ...(allergy.recordedOn ? { recordedOn: allergy.recordedOn } : {}),
        message: sentence(head(allergy, term), found.why, origin(allergy)),
      };
      if (allergy.source !== 'recorded') {
        matches.push(match);
        continue;
      }
      const key = JSON.stringify([normalizeMedicineText(allergy.substance), allergy.severity ?? null,
        (allergy.reaction ?? '').trim().toLowerCase(), found.matchKind]);
      const group = grouped.get(key);
      if (!group) {
        grouped.set(key, { match, allergies: [allergy], why: found.why });
        matches.push(match);
        continue;
      }
      group.allergies.push(allergy);
      regroup(group.match, group.allergies, found.why);
    }
  }
  return matches;
}

/** One line for the same allergy recorded more than once. */
function regroup(match: AllergyMatch, allergies: AllergyForCheck[], why: string): void {
  const first = allergies[0]!;
  match.allergyIds = allergies.flatMap((allergy) => allergy.id ? [allergy.id] : []);
  match.recordedHere = allergies.some((allergy) => allergy.recordedHere === true);
  const dates = allergies.flatMap((allergy) => allergy.recordedOn ? [allergy.recordedOn] : []);
  const latest = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : undefined;
  if (latest) match.recordedOn = latest;
  else delete match.recordedOn;
  const facilities = new Set(allergies.map((allergy, index) => allergy.facilityId ?? `unknown-${index}`));
  const where = facilities.size > 1
    ? `Recorded by clinicians (recorded at ${facilities.size} facilities)`
    : `Recorded ${allergies.length} times by clinicians at ${first.recordedHere ? 'this facility' : 'another facility'}`;
  match.message = sentence(head(first, first.substance), why, `${where}${latest ? `, most recently on ${formatDay(latest)}` : ''}.`);
}

function matchTerm(
  rawTerm: string, drugText: string, drugClasses: DrugClass[], drugMembers: string[],
  named: (word: string) => boolean,
): { matchKind: AllergyMatchKind; className?: string; why: string } | undefined {
  const normalizedTerm = expand(rawTerm);
  // The term as written, or the generic names of a brand or other name in it, each on its own:
  // "Vitamin K1" names vitamin K, and its "k1" need not appear in the medicine.
  const candidates = [rawTerm, ...genericsIn(rawTerm).map((generic) => normalizeMedicineText(generic))];
  const sameMedicine = candidates.some((candidate) => {
    const termWords = nameWords(candidate);
    return termWords.every
      ? termWords.words.length > 0 && termWords.words.every(named)
      : termWords.words.some(named);
  })
    || drugMembers.some((member) => hasWord(normalizedTerm, member));
  if (sameMedicine) {
    return { matchKind: 'same_medicine', why: 'This medicine may be, or may contain, the same medicine.' };
  }
  const allergyClasses = classesOf(normalizedTerm, true);
  const shared = allergyClasses.find((allergyClass) => drugClasses.some((drugClass) => drugClass.key === allergyClass.key));
  if (shared) {
    return { matchKind: 'same_class', className: shared.label,
      why: `This medicine is one of the ${shared.label}, the same group.` };
  }
  const cross = CROSS_REACTIVE.find(([allergyKey, drugKey]) =>
    allergyClasses.some((allergyClass) => allergyClass.key === allergyKey)
    && drugClasses.some((drugClass) => drugClass.key === drugKey));
  if (cross) {
    const drugClass = DRUG_CLASSES.find((candidate) => candidate.key === cross[1])!;
    const allergyClass = DRUG_CLASSES.find((candidate) => candidate.key === cross[0])!;
    return { matchKind: 'cross_reactivity', className: drugClass.label,
      why: `This medicine is a ${drugClass.singular}. Some people allergic to ${allergyClass.label} `
        + `also react to ${drugClass.label}: a risk, not a certainty.` };
  }
  const side = SIDE_CHAIN.find(([allergyName, drugName]) => hasWord(normalizedTerm, allergyName) && hasWord(drugText, drugName));
  if (side) {
    return { matchKind: 'cross_reactivity', className: side[1],
      why: `This medicine is ${side[1]}. Some people allergic to ${side[0]} also react to ${side[1]}: a risk, not a certainty.` };
  }
  return undefined;
}
