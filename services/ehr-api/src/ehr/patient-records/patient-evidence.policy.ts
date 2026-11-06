import { evidence, type Evidence, type OriginHint, type SourceKind } from './patient-evidence.types';

/**
 * The patient chat's second layer of protection. The patient evidence query
 * (PATIENT_EVIDENCE_QUERY) already leaves these rows and fields out; this
 * policy runs over every record of the patient's snapshot (local records, Lab
 * results and documents) before any of it reaches the AI, the search index,
 * saved history or the source viewer, so a query regression or an older Lab
 * image still cannot leak. Each kept record is rebuilt with evidence(), so its
 * content and hash cover only the cleaned data. It is never applied to the
 * staff chat, which keeps full access to its one patient.
 */

/** The text a Lab result being corrected carries instead of its values. */
export const LAB_CORRECTING = 'The lab is correcting this result.';

export interface PatientProfileInput {
  firstName?: unknown; lastName?: unknown; fullName?: unknown; dateOfBirth?: unknown; gender?: unknown;
}

const ALLOWED_ORDER_STATUSES = new Set(['active', 'on_hold', 'completed']);
export const VITAL_FIELDS = ['recorded_at', 'height_cm', 'weight_kg', 'temperature_c', 'pulse_bpm', 'respiratory_rate',
  'systolic_mmhg', 'diastolic_mmhg', 'oxygen_saturation_percent', 'source'] as const;
const LAB_VALUE_FIELDS = ['resultType', 'numericValue', 'textValue', 'unit', 'referenceRange', 'recordedFlag', 'revisionKind', 'releasedAt', 'verification'];

/**
 * The fields each kind may carry to the patient chat. Kinds not listed keep
 * their fields as today, less any internal (`_`-prefixed) key.
 */
export const PATIENT_FIELDS: Partial<Record<SourceKind, readonly string[]>> = {
  note: ['noteType', 'text', 'signedAt'],
  encounter: ['type', 'startedAt', 'endedAt', 'status'],
  diagnosis: ['codeSystem', 'code', 'condition', 'clinicalStatus', 'verificationStatus', 'onsetAt', 'abatementAt'],
  prescription: ['medication', 'doseQuantity', 'doseUnit', 'route', 'frequency', 'startsOn', 'endsOn', 'status'],
  investigation: ['test', 'codeSystem', 'code', 'status'],
  vital: VITAL_FIELDS,
  lab_result: ['test', 'codeSystem', 'code', 'specimen', 'resultType', 'numericValue', 'textValue', 'unit', 'referenceRange',
    'recordedFlag', 'revisionKind', 'collectedAt', 'releasedAt', 'verification', 'correctionPending', 'status'],
  profile: ['ageYears', 'sex'],
  // A record the patient added themselves (0116): what the evidence query reads, nothing more.
  patient_entry: ['type', 'place', 'date', 'notes'],
};

/**
 * Free text written by people, the only fields identifiers are removed from.
 * Codes, test and medicine names, units and dates are never rewritten.
 */
const FREE_TEXT_FIELDS: Partial<Record<SourceKind, readonly string[]>> = {
  note: ['text'], document: ['text'], attachment: ['text'],
  import: ['record', 'notes', 'structuredData', 'transcriptionText'],
  import_version: ['record', 'notes', 'structuredData', 'transcriptionText'],
  health_profile: ['medical_notes', 'medicalNotes'],
  patient_entry: ['place', 'notes'],
};
const FREE_TEXT_TITLES = new Set<SourceKind>(['note', 'import', 'import_version', 'patient_entry']);

/*
 * Sensitive tests, conditions and medicines (S4). Until the clinician
 * "Discussed with the patient" mark exists, these are left out of the patient
 * chat outright: hiding is the safe direction. The list is a default for Ola
 * to approve (D7, D10). Fragments use only syntax that means the same in a
 * JavaScript RegExp and a PostgreSQL ARE (letters, digits, [], ?, *, |, (?:)),
 * so the SQL filter and this policy agree. They never contain a quote.
 */
export const SENSITIVE_TEST_FRAGMENTS = [
  'hiv[a-z0-9]*', 'aids', 'rvs', 'retrovir[a-z]*', 'cd[ -]?4[a-z0-9]*', 'viral[ -]?loads?',
  'hepatitis', 'hbsag', 'hbeag', 'anti[ -]?hbc', 'hbc[ -]?ab', 'hbv[a-z]*', 'hcv[a-z]*',
  'syphili[a-z]*', 'vdrl', 'rpr', 'tpha', 'treponem[a-z]*', 'chlamydi[a-z]*', 'gonorr[a-z]*', 'gonococc[a-z]*',
  'herpes', 'hsv[a-z0-9]*', 'trichomon[a-z]*', 'sti', 'std',
  'b?hcg', 'pregnan[a-z]*', 'upt',
  'psa', 'afp', 'cea', 'ca[ .-]?125', 'ca[ .-]?19[ .-]?9', 'ca[ .-]?15[ .-]?3', 'tumou?r[ -]?markers?',
  'biops[a-z]*', 'histolog[a-z]*', 'histopath[a-z]*', 'cytolog[a-z]*', 'pap', 'pap[ -]?smears?',
  'karyotyp[a-z]*', 'brca[0-9]*', 'genetic[a-z]*', 'genotyp[a-z]*',
  'phq[ -]?[0-9]*', 'gad[ -]?[0-9]+', 'psych[a-z]*',
  // Shorthand as clinicians write it: VL (viral load); Hb electrophoresis is the genotype test.
  'vl', 'hb[ -]?electrophoresis', 'ha?emoglobin[ -]?electrophoresis',
  // The same tests written out in full, as LOINC display names and lab menus write them.
  'prostate[ -]specific', '[a-z]*fetoprotein', 'carcinoembryonic', 'cancer[ -]?(?:ag|antigen)', 'chorionic', 'choriogonadotrop[a-z]*',
  'human[ -]*immuno[ -]*deficiency', 'hep[ .-]*[bc](?:[ .-]*[sec])?(?:[ .-]*a[gb])?', 'hbs[ -]?ag', 'h[ .]+i[ .]+v',
] as const;
/*
 * LOINC codes of the same tests, matched when the code system is LOINC
 * (http://loinc.org), whatever the display text. Only codes whose meaning is
 * certain are listed: HIV 1+2 Ab/Ag and HIV 1 Ab (75622-1, 56888-1, 7917-8,
 * 68961-2), HIV 1 RNA viral load (20447-9), CD4 count (24467-3), HBsAg
 * (5196-1, 5195-3), HCV Ab (16128-1, 13955-0), hCG (2106-3, 21198-7, 2119-6),
 * PSA (2857-1, 35741-8), AFP (1834-1, 19176-1), CEA (2039-6), CA-125 (10334-1);
 * HIV 1+2 Ab and HIV 1 Ab by other methods (7918-6, 29893-5, 31201-7, 5221-7),
 * HIV 1 RNA viral load by other methods (10351-5, 25836-8), hCG in serum
 * (2118-8, 19080-2). Identical to SENSITIVE_LOINC_CODES in lab-api's
 * patient-results.service.ts.
 */
export const SENSITIVE_LOINC_CODES = [
  '75622-1', '56888-1', '7917-8', '68961-2', '20447-9', '24467-3', '5196-1', '5195-3', '16128-1', '13955-0',
  '2106-3', '21198-7', '2119-6', '2857-1', '35741-8', '1834-1', '19176-1', '2039-6', '10334-1',
  '7918-6', '29893-5', '31201-7', '5221-7', '10351-5', '25836-8', '2118-8', '19080-2',
] as const;
/** LOINC as a code system: its name or URL ("http://loinc.org"), or its OID (2.16.840.1.113883.6.1, also as "urn:oid:..."). Same in SQL and JS. */
export const LOINC_SYSTEM_SQL_PATTERN = '(loinc|(^|[^0-9.])2[.]16[.]840[.]1[.]113883[.]6[.]1($|[^0-9.]))';
/** The SQL list form of SENSITIVE_LOINC_CODES, for `in (...)` in patient-only SQL. Codes hold only digits and a hyphen. */
export const SENSITIVE_LOINC_SQL_LIST = SENSITIVE_LOINC_CODES.map(code => `'${code}'`).join(',');
const CANCER_SITES = 'breast|prostate|cervix|cervical|cx|colon|rectum|rectal|colorectal|lung|liver|stomach|gastric|ovary|ovarian'
  + '|uterus|uterine|endometrium|endometrial|bladder|pancreas|pancreatic|oesophagus|esophagus|thyroid|kidney|renal|skin|bone|brain'
  + '|testis|testicular|penis|penile|vulva|vulval|oral|tongue|larynx|nasopharynx|head and neck';
const SENSITIVE_CONDITION_FRAGMENTS = [
  'cancers?', '[a-z]*carcinoma[a-z]*', 'malignan[a-z]*', 'neoplas[a-z]*', '[a-z]*lymphoma[a-z]*', 'leuka?emia[a-z]*', '[a-z]*sarcoma[a-z]*',
  'metasta[a-z]*', 'tumou?rs?', 'depress[a-z]*', 'schizo[a-z]*', 'bipolar', 'psychos[a-z]*', 'psychotic', 'suicid[a-z]*',
  'self[ -]?harm', 'anxiety', 'substance', 'addict[a-z]*',
  // The display text is checked whatever the code system, so each group SENSITIVE_ICD10 hides by code
  // is named here too. Pregnancy and its care (O, Z32-Z36):
  'gestation[a-z]*', 'ante[ -]?natal', 'anc', 'post[ -]?natal', 'post[ -]?partum', 'puerper[a-z]*', 'obstetric[a-z]*',
  '[a-z]*gravid[a-z]*', '[a-z]*para', 'miscarri[a-z]*', 'abortion[a-z]*', '(?:pre[ -]?)?eclamp[a-z]*',
  'hyperemesis', 'placenta[a-z]*', 'hydatidiform', 'trimester', 'labou?r', 'ca?esarean', 'c[ -]?section',
  // Neoplasms (C, D00-D09) named without "cancer" or "carcinoma":
  'hepatoma', 'melanoma[a-z]*', 'myeloma[a-z]*', '[a-z]*blastoma[a-z]*', 'glioma[a-z]*', 'astrocytoma[a-z]*', 'seminoma[a-z]*',
  'mesothelioma[a-z]*', 'hodgkin[a-z]*', 'myelodysplas[a-z]*', 'kaposi[a-z]*', 'in[ -]situ',
  // Mental and behavioural disorders (F):
  'mental', 'ptsd', 'post[ -]?traumatic', 'obsessive', 'ocd', 'compulsive', 'panic', 'phobi[a-z]*', 'mania', 'manic',
  'adhd', 'autis[a-z]*', 'dementia', 'personality', 'anorexia[ -]nervosa', 'bulimi[a-z]*', 'eating[ -]disorders?',
  'alcoholi[a-z]*', 'dependence', 'withdrawal', 'intoxication', 'delirium', 'neurosis', 'neurotic', 'catatoni[a-z]*',
  '(?:alcohol|drug|opioid|opiate|heroin|cannabis|cocaine|amphetamine|benzodiazepine)[ -]+(?:use|abuse|misuse)',
  // Sexually transmitted infections (A50-A64) named without the infection's own word:
  'genital[ -]?warts?', 'condylom[a-z]*', 'anogenital', 'chancroid', 'lymphogranuloma', 'donovanosis', 'granuloma[ -]inguinale',
  // Shorthand: retroviral disease or infection, people living with HIV, PMTCT.
  'rvd', 'rvi', 'plwha', 'plhiv', 'pmtct',
  // "Ca breast", "Ca. of the cervix", "breast Ca": cancer of a named site.
  `ca\\.?(?:[ -]+of(?:[ -]+the)?)?[ -]+(?:${CANCER_SITES})`, `(?:${CANCER_SITES})[ -]+ca`,
] as const;
const SENSITIVE_MEDICINE_FRAGMENTS = [
  'tenofovir', 'lamivudine', 'emtricitabine', 'dolutegravir', 'efavirenz', 'nevirapine', 'zidovudine', 'abacavir',
  'lopinavir', 'atazanavir', 'darunavir', 'ritonavir', 'raltegravir', 'rilpivirine', 'cabotegravir', 'tld', 'tle',
  'arvs?', 'antiretrovir[a-z]*', 'haart', 'art',
  // Component abbreviations as regimens are written ("TDF/3TC/DTG", "AZT/3TC/NVP"), and brand names.
  'tdf', 'taf', '3tc', 'ftc', 'dtg', 'efv', 'nvp', 'azt', 'zdv', 'abc', 'lpv', 'atv', 'drv', 'ral', 'rpv',
  'truvada', 'atripla', 'kaletra', 'aluvia', 'combivir', 'triomune', 'duovir[a-z]*',
] as const;
/** ICD-10: HIV (B20-B24, Z21, R75), viral hepatitis (B15-B19), STIs (A50-A64), neoplasms (C, D00-D09), mental health (F), pregnancy (O, Z32-Z36). */
const SENSITIVE_ICD10 = /^(?:B2[0-4]|Z21|R75|B1[5-9]|A5\d|A6[0-4]|C\d\d|D0\d|F\d\d|O\d\d|Z3[2-6])/i;

const jsPattern = (fragments: readonly string[]) => new RegExp(`(?<![a-z0-9])(?:${fragments.join('|')})(?![a-z0-9])`, 'i');
/** The PostgreSQL ARE form of the sensitive test list, for `!~*` in patient-only SQL. */
export const SENSITIVE_TEST_SQL_PATTERN = `(^|[^a-z0-9])(?:${SENSITIVE_TEST_FRAGMENTS.join('|')})($|[^a-z0-9])`;
const SENSITIVE_TEST = jsPattern(SENSITIVE_TEST_FRAGMENTS);
const SENSITIVE_CONDITION = jsPattern([...SENSITIVE_TEST_FRAGMENTS, ...SENSITIVE_CONDITION_FRAGMENTS]);
const SENSITIVE_MEDICINE = jsPattern(SENSITIVE_MEDICINE_FRAGMENTS);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const LOINC_CODES = new Set<string>(SENSITIVE_LOINC_CODES);
const LOINC_SYSTEM = new RegExp(LOINC_SYSTEM_SQL_PATTERN, 'i');
export function isSensitiveTest(name: unknown, code?: unknown, codeSystem?: unknown): boolean {
  return SENSITIVE_TEST.test(text(name)) || SENSITIVE_TEST.test(text(code))
    || (LOINC_SYSTEM.test(text(codeSystem).trim()) && LOINC_CODES.has(text(code).trim()));
}
function sensitive(record: Evidence): boolean {
  const f = record.fields;
  switch (record.kind) {
    case 'lab_result': case 'investigation': return isSensitiveTest(f.test, f.code, f.codeSystem) || isSensitiveTest(record.title);
    // The display text is checked whatever the code system (ICD-10, SNOMED CT, local); ICD-10 codes as well.
    case 'diagnosis': return SENSITIVE_CONDITION.test(text(f.condition)) || SENSITIVE_CONDITION.test(record.title)
      || (/icd/i.test(text(f.codeSystem)) && SENSITIVE_ICD10.test(text(f.code)));
    case 'prescription': return SENSITIVE_MEDICINE.test(text(f.medication)) || SENSITIVE_MEDICINE.test(record.title);
    // A record the patient added (0116) names its test, medicine or condition in its title, whatever
    // type the patient chose; the same lists apply, so the patient chat treats it as a clinician's.
    case 'patient_entry': return isSensitiveTest(record.title) || SENSITIVE_CONDITION.test(record.title) || SENSITIVE_MEDICINE.test(record.title);
    default: return false;
  }
}

/** Whole years of age on `today` in Lagos, so the value (and the hash) only changes on the birthday. */
export function ageYears(dateOfBirth: unknown, today: Date): number | null {
  const birth = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(dateOfBirth));
  if (!birth || !Number.isFinite(today.getTime())) return null;
  const lagos = /^(\d{4})-(\d{2})-(\d{2})$/.exec(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(today));
  if (!lagos) return null;
  const y = Number(lagos[1]), m = Number(lagos[2]), d = Number(lagos[3]);
  const by = Number(birth[1]), bm = Number(birth[2]), bd = Number(birth[3]);
  if (bm < 1 || bm > 12 || bd < 1 || bd > 31) return null;
  const age = y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  return age >= 0 && age < 150 ? age : null;
}
const SEXES = new Set(['female', 'male', 'intersex', 'other', 'unknown']);
export function sex(gender: unknown): string | null {
  return typeof gender === 'string' && SEXES.has(gender) ? gender : null;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (body: string, flags = 'giu') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, flags);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/**
 * Names that are also words clinicians capitalise mid-sentence ("next Sunday",
 * "Will review"). Alone they are left as written; next to another name, or in
 * the full name, they are still removed.
 */
const COMMON_WORD_NAMES = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', ...MONTHS, 'will']);
/** The written-as-a-name forms of a name (capitalised, in capitals, or as stored if that starts with a capital), case-sensitive. */
const nameForms = (name: string) => [...new Set([name.charAt(0).toLocaleUpperCase() + name.slice(1).toLocaleLowerCase(),
  name.toLocaleUpperCase(), ...(/^\p{Lu}/u.test(name) ? [name] : [])])].map(escape).join('|');
const tokens = (value: unknown) => text(value).trim().split(/\s+/).filter(t => t.length >= 2);
function dateOfBirthPatterns(dateOfBirth: unknown): RegExp[] {
  const birth = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(dateOfBirth));
  if (!birth) return [];
  const [, y, m, d] = birth;
  const dd = `0?${Number(d)}`, mm = `0?${Number(m)}`;
  const month = MONTHS[Number(m) - 1];
  if (!month) return [];
  const name = `${month.slice(0, 3)}(?:${month.slice(3)})?\\.?`;
  const sep = '\\s*[/.-]\\s*', yy = y!.slice(2), year = `(?:${y}|${yy})`;
  const d2 = d!, m2 = m!;
  // Only right after "born", "DOB", "date of birth" or "birthday": forms that clinical numbers can share
  // ("dose 12.3.90", "RR 12 03 1990", "BP 1/12/12"), so they are removed only when they are said to be the birth date.
  const cue = '(?<=(?:born|dob|d\\.o\\.b\\.?|date\\s+of\\s+birth|birth\\s*date|birth\\s*day)[\\s:,.-]*(?:(?:on|is|was)\\s+)?)';
  return [
    // A full date with a four-digit year, a month name, or as stored ("1990-03-12T00:00"): wherever it appears.
    word(`${y}${sep}${mm}${sep}${dd}(?:T[\\d:.]+(?:Z|[+-]\\d{2}:?\\d{2})?)?`),
    word(`${dd}${sep}${mm}${sep}${y}`),
    word(`${d2}${m2}${y}|${y}${m2}${d2}`),
    word(`${dd}(?:st|nd|rd|th)?(?:\\s*of)?[\\s./-]+${name}[\\s.,/-]+${year}`),
    word(`${name}[\\s./-]*${dd}(?:st|nd|rd|th)?[\\s.,/-]+${year}`),
    // After a birth cue: a two-digit year, plain spaces, month first, or digits run together.
    word(`${cue}(?:${dd}(?:${sep}|\\s+)${mm}(?:${sep}|\\s+)${year}|${mm}(?:${sep}|\\s+)${dd}(?:${sep}|\\s+)${year}`
      + `|${y}\\s+${mm}\\s+${dd}|${d2}${m2}${yy})`),
  ];
}
/**
 * Removes identifiers from free text: Health IDs, phone numbers, 11-digit ID
 * numbers (NIN, BVN), hospital or folder numbers, email addresses, the date of
 * birth and the patient's own name. Clinical values such as `12.5 g/dL`,
 * `120/80` and visit dates are left as they are.
 */
export function redactIdentifiers<T>(value: T, profile: PatientProfileInput): T {
  const first = tokens(profile.firstName), last = tokens(profile.lastName);
  const full = text(profile.fullName).trim().split(/\s+/).filter(Boolean);
  const fullNames = [...new Set([full.join(' '), [...first, ...last].join(' '), [...last, ...first].join(' ')]
    .filter(n => n.length >= 2 && n.includes(' ')))].sort((a, b) => b.length - a.length);
  const surnames = [...new Set(last.length ? last : full.slice(-1).filter(t => t.length >= 2))];
  const given = [...new Set([...first, ...full.slice(0, -1).filter(t => t.length >= 2)])].filter(t => !surnames.includes(t));
  const dob = dateOfBirthPatterns(profile.dateOfBirth);
  const clean = (input: string): string => {
    let s = input
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
      .replace(/(?<![A-Z0-9])HID-[A-HJ-NP-Z2-9]{6,32}(?![A-Z0-9])/gi, '[Health ID removed]')
      // Without the hyphen ("HID AB2CD3EF", "hid ab2cd3ef"): the code must hold a digit, or both be in capitals,
      // so the verb "hid" in "hid tablets" stays.
      .replace(/(?<![A-Z0-9])HID\s*(?=[A-HJ-NP-Z]*[2-9])[A-HJ-NP-Z2-9]{6,32}(?![A-Z0-9])/gi, '[Health ID removed]')
      .replace(/(?<![A-Za-z0-9])HID\s+[A-HJ-NP-Z2-9]{6,32}(?![A-Za-z0-9])/g, '[Health ID removed]')
      .replace(/\b((?:MRN|hospital\s*(?:no|number|num)|hosp\.?\s*no|folder\s*(?:no|number)|card\s*(?:no|number)|file\s*(?:no|number))\.?\s*[:#]?\s*)[A-Z0-9][A-Z0-9/-]{2,}/gi,
        '$1[record number removed]')
      .replace(/\b((?:NIN|BVN)\s*(?:no\.?|number)?\s*[:#]?\s*)\d(?:[\s-]?\d){10}(?!\d)/gi, '$1[ID number removed]')
      // Local and +234 numbers, with spaces, hyphens, dots, brackets or "(0)": "(0803) 123 4567", "+234 (0) 803 123 4567".
      .replace(/(?<![\d+(])(?:\(?\+?\(?234\)?[\s.-]*(?:\(0\)[\s.-]*)?|\(?0)[789][01]\d\)?(?:[\s.-]?\d){7}(?!\d)/g, '[phone removed]')
      .replace(/(?<!\d)\+\d[\d\s-]{8,14}\d(?!\d)/g, '[phone removed]')
      .replace(/(?<!\d|\d\.)\d{11}(?!\d|\.\d)/g, '[ID number removed]')
      .replace(/(?<!\d|\d\.)\d{4}[\s-]\d{4}[\s-]\d{3}(?!\d|\.\d)/g, '[ID number removed]');
    for (const pattern of dob) s = s.replace(pattern, '[date of birth removed]');
    for (const name of fullNames) s = s.replace(word(name.split(' ').map(escape).join('\\s+')), 'the patient');
    // A surname next to another name is someone else of the same family, or
    // the patient under another name: the whole name goes.
    // Names are often also words (Sunday, Will, Blessing, Hope), so only their
    // written-as-a-name forms are replaced, never the lower-case word.
    for (const surname of surnames) {
      const n = nameForms(surname);
      s = s.replace(word(`\\p{Lu}[\\p{L}'’-]+\\s+(?:${n})|(?:${n})\\s+\\p{Lu}[\\p{L}'’-]+`, 'gu'), '[name removed]');
      if (!COMMON_WORD_NAMES.has(surname.toLocaleLowerCase())) s = s.replace(word(n, 'gu'), '[name removed]');
    }
    for (const name of given) {
      if (!COMMON_WORD_NAMES.has(name.toLocaleLowerCase())) s = s.replace(word(nameForms(name), 'gu'), 'the patient');
    }
    return s;
  };
  const walk = (v: unknown): unknown => typeof v === 'string' ? clean(v) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value) as T;
}

function hint(record: Evidence): OriginHint {
  if (record.kind === 'note') return record.origin === 'scanned_paper' ? 'scanned_paper' : null;
  if (record.kind === 'import' || record.kind === 'import_version') return record.origin === 'health_worker' ? 'provider-authored' : 'patient-provided';
  return null;
}
const pick = (fields: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter(k => Object.hasOwn(fields, k)).map(k => [k, fields[k]]));
const internal = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([k]) => !k.startsWith('_')));

/** Whether the record stays out of the patient chat altogether. */
function excluded(record: Evidence): boolean {
  const f = record.fields;
  switch (record.kind) {
    case 'diagnosis': if (f.verificationStatus !== 'confirmed') return true; break;
    case 'prescription': case 'investigation':
      if (!ALLOWED_ORDER_STATUSES.has(text(f.status)) || f._encounterStatus !== 'completed') return true; break;
    case 'note': if (f._encounterStatus !== 'completed') return true; break;
    case 'encounter': if (f.status !== 'completed') return true; break;
    default: break;
  }
  return sensitive(record);
}

/** The patient's Health ID profile as the chat may see it: age and sex only. */
export function profileFields(profile: PatientProfileInput, today: Date) {
  return { ageYears: ageYears(profile.dateOfBirth, today), sex: sex(profile.gender) };
}

export function patientEvidence(records: Evidence[], profile: PatientProfileInput, today: Date): Evidence[] {
  const result: Evidence[] = [];
  for (const record of records) {
    if (excluded(record)) continue;
    let fields = internal(record.fields);
    let { title, provenance, quality } = record;
    const allowed = PATIENT_FIELDS[record.kind];
    if (record.kind === 'profile') { fields = profileFields(profile, today); title = 'Age and sex'; }
    else if (record.kind === 'lab_result' && fields.correctionPending === true) {
      fields = { ...pick(fields, allowed!.filter(k => !LAB_VALUE_FIELDS.includes(k))), correctionPending: true, status: LAB_CORRECTING };
      provenance = 'Laboratory result being corrected'; quality = 'correction pending; no value shown';
    } else if (allowed) fields = pick(fields, allowed);
    if (record.kind === 'lab_result' && fields.correctionPending !== true) { delete fields.correctionPending; delete fields.status; }
    if (record.kind === 'document') title = 'Clinical document';
    if (record.kind === 'attachment') title = 'Imported document';
    for (const key of FREE_TEXT_FIELDS[record.kind] ?? []) if (Object.hasOwn(fields, key)) fields[key] = redactIdentifiers(fields[key], profile);
    if (FREE_TEXT_TITLES.has(record.kind)) title = redactIdentifiers(title, profile);
    const rebuilt = evidence({ kind: record.kind, id: record.id, version: record.version, title, recordedAt: record.recordedAt,
      effectiveAt: record.effectiveAt, provenance, quality, fields, originHint: hint(record),
      ...(record.encounterId ? { encounterId: record.encounterId } : {}) });
    // The origin is worked out from the original row; it is not part of the hash.
    result.push({ ...rebuilt, origin: record.origin });
  }
  return result;
}
