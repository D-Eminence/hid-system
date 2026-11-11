/**
 * Sensitive classes the OCR learning rules never cover (owner decision Q43 of 2026-11-11): ARVs and HIV, TB,
 * psychiatric, sickle cell. A reading holding any item of these classes stores no correction observation (0118) and
 * shows no suggestion (0119), for the whole document: the check is deliberately broad, and a false alarm only means
 * one document teaches nothing.
 *
 * This is the versioned default list (coordinator, 2026-11-11: "use your list as the versioned default file"; it goes
 * to the owner with the phase-2 signature). Change it only with a new SENSITIVE_CLASSES_VERSION.
 *
 * Medicines are grouped by WHO ATC class: HIV agents J05AE, J05AF, J05AG, J05AJ, J05AR, J05AX; TB J04A (with
 * clofazimine); psychiatric N05A antipsychotics, N05AN lithium, N05B anxiolytics, N05C hypnotics, N06A
 * antidepressants, N06B psychostimulants; sickle cell disease: hydroxycarbamide, voxelotor, crizanlizumab,
 * L-glutamine. Diagnoses by ICD-11 code: HIV 1C60-1C62, TB 1B10-1B14, chapter 06 (mental, behavioural or
 * neurodevelopmental), sickle cell 3A51.
 */
import { matchDiagnosisName, ICD11_TITLES } from './lists/diagnosis-list';
import { matchDrugName } from './lists/drug-list';

export const SENSITIVE_CLASSES_VERSION = 'hid.ocr.sensitive/v1';

export type SensitiveClass = 'hiv' | 'tb' | 'psychiatric' | 'sickle_cell';

/** Generic names (lower case, as the drug list spells them) in each class. */
export const SENSITIVE_GENERICS: Readonly<Record<SensitiveClass, readonly string[]>> = {
  hiv: ['abacavir', 'atazanavir', 'bictegravir', 'cabotegravir', 'darunavir', 'didanosine', 'dolutegravir',
    'efavirenz', 'emtricitabine', 'etravirine', 'lamivudine', 'lopinavir', 'nevirapine', 'raltegravir', 'rilpivirine',
    'ritonavir', 'stavudine', 'tenofovir', 'tenofovir disoproxil', 'tenofovir alafenamide', 'zidovudine',
    'doravirine', 'fostemsavir', 'maraviroc', 'enfuvirtide', 'indinavir', 'saquinavir', 'nelfinavir', 'fosamprenavir'],
  tb: ['isoniazid', 'rifampicin', 'rifampin', 'rifapentine', 'rifabutin', 'pyrazinamide', 'ethambutol', 'streptomycin',
    'bedaquiline', 'delamanid', 'pretomanid', 'cycloserine', 'terizidone', 'ethionamide', 'prothionamide',
    'para-aminosalicylic acid', 'aminosalicylic acid', 'capreomycin', 'kanamycin', 'clofazimine', 'thioacetazone'],
  psychiatric: ['haloperidol', 'chlorpromazine', 'fluphenazine', 'olanzapine', 'risperidone', 'quetiapine',
    'aripiprazole', 'clozapine', 'trifluoperazine', 'flupentixol', 'zuclopenthixol', 'sulpiride', 'amisulpride',
    'paliperidone', 'ziprasidone', 'pimozide', 'perphenazine', 'thioridazine', 'lithium', 'lithium carbonate', 'diazepam', 'lorazepam', 'alprazolam',
    'bromazepam', 'chlordiazepoxide', 'clonazepam', 'nitrazepam', 'temazepam', 'zolpidem', 'zopiclone',
    'amitriptyline', 'imipramine', 'clomipramine', 'nortriptyline', 'fluoxetine', 'sertraline', 'paroxetine',
    'citalopram', 'escitalopram', 'fluvoxamine', 'mirtazapine', 'venlafaxine', 'duloxetine', 'trazodone',
    'methylphenidate', 'atomoxetine'],
  sickle_cell: ['hydroxycarbamide', 'hydroxyurea', 'voxelotor', 'crizanlizumab', 'l-glutamine'],
};

/** ICD-11 code prefixes in each class (codes from the diagnosis list's ICD11_TITLES). */
export const SENSITIVE_ICD_PREFIXES: Readonly<Record<SensitiveClass, readonly string[]>> = {
  hiv: ['1C60', '1C61', '1C62'],
  tb: ['1B10', '1B11', '1B12', '1B13', '1B14'],
  psychiatric: ['6'],
  sickle_cell: ['3A51'],
};

/**
 * Words and abbreviations that mark a document sensitive wherever they appear in an item (name, as written, plain
 * text or any field): regimens written as abbreviations (TDF/3TC/DTG, RHZE), the conditions, and their tests.
 */
const SENSITIVE_WORDS = new RegExp(String.raw`(?<![a-z0-9])(?:` + [
  'hiv', 'aids', 'plhiv', 'pvh', 'retroviral', 'rvs', 'r[/-]?v[/-]?d', 'haart', 'art', 'arvs?', 'cd4', 'viral load',
  'tdf', '3tc', 'dtg', 'efv', 'nvp', 'azt', 'lpv', 'atv', 'tld', 'tle', 'ftc',
  'tb', 'ptb', 'eptb', 'tuberculo[a-z]*', 'genexpert', 'gene xpert', 'afb', 'acid[- ]fast', 'mantoux', 'tuberculin',
  'rhze', 'rhz', 'rh', 'inh', 'dots',
  'psych[a-z]*', 'schizo[a-z]*', 'bipolar', 'depressi[a-z]*', 'mania', 'manic', 'anxiety', 'ssri', 'antipsychotic[a-z]*',
  'sickle[a-z]*', 'scd', 'sca', 'hbss', 'hb ss', 'genotype', 'electrophoresis',
].join('|') + String.raw`)(?![a-z0-9])`, 'i');

const ALL_GENERICS = new Map<string, SensitiveClass>(
  (Object.entries(SENSITIVE_GENERICS) as [SensitiveClass, readonly string[]][])
    .flatMap(([kind, names]) => names.map((name) => [name, kind] as const)));
const CODE_OF_TITLE = new Map(ICD11_TITLES.map(([title, code]) => [title, code]));

const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
};

/** The sensitive class a medicine name stands for on the drug list (any part of a combination), or null. */
export function sensitiveMedicine(name: string): SensitiveClass | null {
  const match = matchDrugName(name);
  if (!match) return null;
  for (const part of match.generic.toLowerCase().split(/\s*\+\s*/)) {
    const kind = ALL_GENERICS.get(part);
    if (kind) return kind;
  }
  return null;
}

/** The sensitive class a diagnosis name stands for on the ICD-11 list, or null. */
export function sensitiveDiagnosis(name: string): SensitiveClass | null {
  const match = matchDiagnosisName(name);
  const code = match ? CODE_OF_TITLE.get(match.title) : null;
  if (!code) return null;
  for (const [kind, prefixes] of Object.entries(SENSITIVE_ICD_PREFIXES) as [SensitiveClass, readonly string[]][]) {
    if (prefixes.some((prefix) => code.startsWith(prefix))) return kind;
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether one reading item (any kind) belongs to a sensitive class: a sensitive word or a sensitive generic name
 * anywhere in it, or its name (a medicine's, a diagnosis's) grounded to a sensitive class on the lists.
 */
export function itemIsSensitive(item: unknown): boolean {
  const texts = strings(item);
  if (texts.some((text) => SENSITIVE_WORDS.test(text))) return true;
  const lower = texts.map((text) => text.toLowerCase());
  if (lower.some((text) => [...ALL_GENERICS.keys()].some((generic) => text.includes(generic)))) return true;
  if (!isRecord(item)) return false;
  const fields = isRecord(item.fields) ? item.fields : {};
  const names = [fields.name, item.asWritten].filter((value): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 120);
  if (item.kind === 'medicine') return names.some((name) => sensitiveMedicine(name) !== null);
  if (item.kind === 'diagnosis') return names.some((name) => sensitiveDiagnosis(name) !== null);
  return false;
}

/**
 * Whether one value (what a reviewer saved, or a rule's suggestion) stands for a sensitive class: a sensitive word, a
 * sensitive generic name, or a name grounded to a sensitive medicine or diagnosis. A correction to "Lamivudine" on a
 * reading that never named it is sensitive too, so it is never learned or suggested.
 */
export function valueIsSensitive(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (SENSITIVE_WORDS.test(value)) return true;
  const lower = value.toLowerCase();
  if ([...ALL_GENERICS.keys()].some((generic) => lower.includes(generic))) return true;
  return value.length <= 120 && (sensitiveMedicine(value) !== null || sensitiveDiagnosis(value) !== null);
}

/**
 * Whether a reading is sensitive: any item, or any line of its pages (an "ART clinic" heading or an "RVS +ve" line
 * that never became an item). Then it teaches nothing and shows no suggestion.
 */
export function readingIsSensitive(items: readonly unknown[], pageTexts: readonly string[] = []): boolean {
  return items.some(itemIsSensitive) || pageTexts.some((text) => SENSITIVE_WORDS.test(text)
    || [...ALL_GENERICS.keys()].some((generic) => text.toLowerCase().includes(generic)));
}
