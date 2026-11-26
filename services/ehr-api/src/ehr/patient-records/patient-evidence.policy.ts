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
};
const FREE_TEXT_TITLES = new Set<SourceKind>(['note', 'import', 'import_version']);

/*
 * Sensitive tests, conditions and medicines (S4). Until the clinician
 * "Discussed with the patient" mark exists, these are left out of the patient
 * chat outright: hiding is the safe direction. The list is a default for Ola
 * to approve (D7, D10). Fragments use only syntax that means the same in a
 * JavaScript RegExp and a PostgreSQL ARE (letters, digits, [], ?, *, +, |,
 * (?:)), so the SQL filter and this policy agree. They never contain a quote.
 */
/*
 * The initialisms of the test list. Each is also matched with dots or spaces
 * between its letters ("R.V.S.", "V.D.R.L", "C. D. 4"), a form made by
 * dottedInitialism. lab-api's copy (patient-results.service.ts) makes it the
 * same way from the same list, so the test pattern stays one string in both
 * (Ola's call as clinical owner, design note on #258, 26 Nov 2026).
 */
export const SENSITIVE_TEST_INITIALISMS = [
  'hiv', 'aids', 'rvs', 'cd4', 'vl', 'hbv', 'hcv', 'hsv', 'vdrl', 'rpr', 'tpha', 'sti', 'std', 'hcg', 'bhcg', 'upt',
  'psa', 'afp', 'cea', 'phq',
] as const;
/** An initialism with one or more dots or spaces between its letters: 'rvs' gives 'r[ .]+v[ .]+s'. */
export const dottedInitialism = (letters: string): string => [...letters].join('[ .]+');
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
  'human[ -]*immuno[ -]*deficiency', 'hep[ .-]*[bc](?:[ .-]*[sec])?(?:[ .-]*a[gb])?', 'hbs[ -]?ag',
  // HIV rapid-test kits named alone: Determine, Uni-Gold and Stat-Pak are the three tests of Nigeria's serial HIV
  // algorithm, and OraQuick is sold for self-testing. A facility's own test is ordered by its name only (0155), so
  // its name is all that can hide it. A false match hides a test the patient could have seen: the safe side.
  'determine', 'uni[ -]?gold', 'stat[ -]?pak', 'ora[ -]?quick',
  // The initialisms above with dots or spaces ("H.I.V", "R.V.S.", "C.D.4").
  ...SENSITIVE_TEST_INITIALISMS.map(dottedInitialism),
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
/** The initialisms of the condition list below, each also matched dotted (dottedInitialism). */
const SENSITIVE_CONDITION_INITIALISMS = ['rvd', 'rvi', 'plwha', 'plhiv', 'pmtct', 'anc', 'ptsd', 'ocd', 'adhd'] as const;
const SENSITIVE_CONDITION_FRAGMENTS = [
  'cancers?', '[a-z]*carcinoma[a-z]*', 'malignan[a-z]*', 'neoplas[a-z]*', '[a-z]*lymphoma[a-z]*', 'leuka?emia[a-z]*', '[a-z]*sarcoma[a-z]*',
  'metasta[a-z]*', 'tumou?rs?', 'depress[a-z]*', 'schizo[a-z]*', 'bipolar', 'psychos[a-z]*', 'psychotic', 'suicid[a-z]*',
  'self[ -]?harm', 'anxiety', 'substance', 'addict[a-z]*',
  // The display text is checked whatever the code system, so each group SENSITIVE_ICD10 (and SENSITIVE_ICD11_GROUPS)
  // hides by code is named here too. Pregnancy and its care (O, Z32-Z36):
  'gestation[a-z]*', 'ante[ -]?natal', 'anc', 'post[ -]?natal', 'post[ -]?partum', 'puerper[a-z]*', 'obstetric[a-z]*',
  '[a-z]*gravid[a-z]*', '[a-z]*para', 'miscarri[a-z]*', 'abortion[a-z]*', '(?:pre[ -]?)?eclamp[a-z]*',
  'hyperemesis', 'placenta[a-z]*', 'hydatidiform', 'trimester', 'labou?r', 'ca?esarean', 'c[ -]?section',
  // Neoplasms (C, D00-D09) named without "cancer" or "carcinoma":
  'hepatoma', 'melanoma[a-z]*', 'myeloma[a-z]*', '[a-z]*blastoma[a-z]*', 'glioma[a-z]*', 'astrocytoma[a-z]*', 'seminoma[a-z]*',
  'mesothelioma[a-z]*', 'hodgkin[a-z]*', 'myelodysplas[a-z]*', 'kaposi[a-z]*', 'in[ -]situ',
  // Mental and behavioural disorders (F):
  'mental', 'ptsd', 'post[ -]?traumatic', 'obsessive', 'ocd', 'compulsive', 'panic', 'phobi[a-z]*', 'mania', 'manic', 'hypomani[a-z]*',
  'adhd', 'autis[a-z]*', 'dementia', 'personality', 'anorexia[ -]nervosa', 'bulimi[a-z]*', 'eating[ -]disorders?',
  'alcoholi[a-z]*', 'dependence', 'withdrawal', 'intoxication', 'delirium', 'neurosis', 'neurotic', 'catatoni[a-z]*',
  '(?:alcohol|drug|opioid|opiate|heroin|cannabis|cocaine|amphetamine|benzodiazepine)[ -]+(?:use|abuse|misuse)',
  // Sexually transmitted infections (A50-A64) named without the infection's own word:
  'genital[ -]?warts?', 'condylom[a-z]*', 'anogenital', 'chancroid', 'lymphogranuloma', 'donovanosis', 'granuloma[ -]inguinale',
  // Shorthand: retroviral disease or infection, people living with HIV, PMTCT.
  'rvd', 'rvi', 'plwha', 'plhiv', 'pmtct',
  // "Ca breast", "Ca. of the cervix", "breast Ca": cancer of a named site.
  `ca\\.?(?:[ -]+of(?:[ -]+the)?)?[ -]+(?:${CANCER_SITES})`, `(?:${CANCER_SITES})[ -]+ca`,
  // The condition list's own initialisms with dots or spaces ("R.V.D.", "P.M.T.C.T."), made as the test list's are.
  ...SENSITIVE_CONDITION_INITIALISMS.map(dottedInitialism),
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
/**
 * A facility's own item (0155): code system HID-FACILITY and the item's id, a UUID that means nothing. Only its name
 * can hide it, as lab-api's copy checks names only; a UUID's letter groups ("cd41") are not read as a test's name.
 */
const FACILITY_ITEM_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSensitiveTest(name: unknown, code?: unknown, codeSystem?: unknown): boolean {
  const facilityItemCode = text(codeSystem).trim().toUpperCase() === 'HID-FACILITY' && FACILITY_ITEM_CODE.test(text(code).trim());
  return SENSITIVE_TEST.test(text(name)) || (!facilityItemCode && SENSITIVE_TEST.test(text(code)))
    || (LOINC_SYSTEM.test(text(codeSystem).trim()) && LOINC_CODES.has(text(code).trim()));
}

/*
 * ICD-11 (MMS, release 2026-01): the groups SENSITIVE_ICD10 hides, as a table of WHO codes and ranges.
 * DRAFT, waiting for the clinical lead: Health ID's named clinical lead confirms these ranges before release
 * (owner decision Q124 A sign-off; Ola's decision 5 on #258). They were read from WHO's 2026-01 release files:
 * the tabular list, the simple tabulation and the 10-to-11 and 11-to-10 maps
 * (https://icdcdn.who.int/static/releasefiles/2026-01/mapping.zip).
 *
 * Each entry of `codes` and `except` is written as WHO writes it and takes in every code under it:
 * - 'QA40', a category: QA40, QA40.x and QA40.xx;
 * - 'KA62.6', a code with a dot: KA62.6 and KA62.6x;
 * - '1C60-1C62.Z', a range: every code whose category (the four characters before the dot) lies between the
 *   two categories, both included. Categories sort as plain text (digits, then letters, Y and Z last), the
 *   order WHO numbers them in.
 * `exactly` lists codes that count alone, without the codes under them.
 */
export interface Icd11SensitiveGroup {
  readonly group: string;
  /** The ICD-10 codes SENSITIVE_ICD10 hides for the same group. */
  readonly icd10: string;
  readonly codes: readonly string[];
  readonly exactly?: readonly string[];
  readonly except?: readonly string[];
}
export const SENSITIVE_ICD11_GROUPS: readonly Icd11SensitiveGroup[] = [
  // Z21 (asymptomatic HIV) is 1C62.0, inside the block. KA62.6 is congenital HIV infection (likely: WHO maps it
  // back to P35, but in ICD-10 practice these infants are coded B20-B24).
  { group: 'HIV disease', icd10: 'B20-B24, Z21', codes: ['1C60-1C62.Z', 'KA62.6'] },
  // MA14.0 alone: the rest of MA14 (MA14.1x: tuberculin, ANA, CRP...) is not about HIV.
  { group: 'Laboratory evidence of HIV', icd10: 'R75', codes: ['MA14.0'] },
  { group: 'Viral hepatitis', icd10: 'B15-B19', codes: ['1E50-1E5Z'] },
  { group: 'Predominantly sexually transmitted infections', icd10: 'A50-A64', codes: ['1A60-1A9Z'] },
  { group: 'Malignant neoplasms, except of lymphoid, haematopoietic or central nervous system tissues',
    icd10: 'C00-C69, C73-C80, C97', codes: ['2B50-2E2Z'] },
  // Likely: the whole block, which also holds what ICD-10 files under D45-D47 (polycythaemia vera, myelodysplastic
  // syndromes, MGUS...). Matching ICD-10 exactly would take those codes out; the clinical lead decides. The groups
  // below hide more codes whose only ICD-10 codes in WHO's 11-to-10 map are shown today; each is named at its group.
  { group: 'Neoplasms of haematopoietic or lymphoid tissues', icd10: 'C81-C96', codes: ['2A20-2B3Z'] },
  // Uncertain: an ICD-11 stem code does not tell a malignant central nervous system tumour from a benign one
  // (C71, D33.0 and D43.0 all map to 2A00.5), so the block is hidden less 2A02.3 and 2A02.4. It still hides codes
  // that WHO maps back only to benign D33 codes, shown in ICD-10: 2A00.21 (mixed neuronal-glial tumours, D33.2) and
  // 2A00.22 (choroid plexus tumours, D33.0 and D33.1). The clinical lead decides whether they go into `except`.
  { group: 'Neoplasms of the central nervous system', icd10: 'C70-C72', codes: ['2A00-2A0Z'], except: ['2A02.3', '2A02.4'] },
  { group: 'In situ neoplasms', icd10: 'D00-D09', codes: ['2E60-2E6Z'] },
  { group: 'Mental, behavioural or neurodevelopmental disorders (chapter 06)', icd10: 'F00-F99', codes: ['6A00-6E8Z'] },
  // Likely: F conditions ICD-11 moved out of chapter 06: sexual dysfunctions and sexual pain (F52), gender
  // incongruence (F64), tic disorders (F95), F98.4, F80.3, Rett syndrome (F84.2), acute stress reaction (F43.0) and
  // F66; and the sleep-wake codes WHO maps back to F51, each alone (chapter 07 also holds G47 conditions such as
  // narcolepsy and sleep apnoea, so neither the chapter nor these categories are taken whole). 7A0Z (insomnia
  // disorders, unspecified) maps back to G47.0 but is where WHO's 10-to-11 map sends F51.0, so it goes with 7A00 and
  // 7A01; if the clinical lead decides insomnia should not follow F51.0, all three go.
  // Hidden here although WHO maps them back only to ICD-10 codes shown today (the clinical lead decides each):
  // HA01.1-HA01.1Z (male erectile dysfunction, N48.4: ICD-10 hid only F52.2, so ICD-11 hides all erectile
  // dysfunction, diabetic and hypertensive included); 7A85 and 7A86 (neurological; only the catch-all F51.9);
  // 8A05.11 (G25.6); QA15.1 (Z70.1).
  { group: 'Mental or behavioural conditions outside chapter 06', icd10: 'F51, F52, F64, F95, F98.4, F80.3, F84.2, F43.0, F66',
    codes: ['HA00-HA0Z', 'HA20-HA2Z', 'HA60-HA6Z', '8A05', '8A07.0', '8A62.2', 'LD90.4', 'QE84', 'QA15.1'],
    exactly: ['7A00', '7A01', '7A0Z', '7A23', '7A25', '7A26', '7A2Y', '7A2Z', '7A85', '7A86', '7A88', '7A8Y', '7A8Z', '7B00.1', '7B00.2',
      '7B01', '7B01.2', '7B01.Y', '7B01.Z', '7B02', '7B02.2', '7B0Y', '7B0Z', '7B2Y', '7B2Z'] },
  { group: 'Pregnancy, childbirth or the puerperium (chapter 18)', icd10: 'O00-O99', codes: ['JA00-JB6Z'] },
  // Pregnancy test, pregnant state, supervision of normal and high-risk pregnancy, antenatal screening. Not QA44
  // (expectant parent pre-birth visit, which maps back only to the block Z30-Z39) or QA46-QA4B (Z37-Z39 and others).
  { group: 'Pregnancy care contacts', icd10: 'Z32-Z36', codes: ['QA40', 'QA41', 'QA42', 'QA43', 'QA45'] },
];
/**
 * An ICD-11 stem code at the start of a part: the category (the chapter, a letter (never I or O), a digit, one more
 * character), then optionally a dot and up to two more characters. The dot may be missing ("1C620" is 1C62.0).
 */
const ICD11_STEM = /^([1-9A-HJ-NP-Z][A-HJ-NP-Z][0-9][0-9A-HJ-NP-Z])\.?([0-9A-HJ-NP-Z]{0,2})/;
/**
 * A code system naming ICD-10 or ICD-11: "ICD-10", "icd10", "ICD-10-CM", "ICD-11 MMS", "ICD11MMS", or a WHO or HL7 URI.
 * "ICD-10/11" and "ICD 10 / 11" name both.
 */
const ICD10_SYSTEM = /icd[ ._-]*10(?![0-9])|id\.who\.int\/icd\/release\/10(?![0-9])/i;
const ICD11_SYSTEM = /icd[ ._-]*(?:10[ ._-]*\/[ ._-]*)?11(?![0-9])|id\.who\.int\/icd\/(?:release\/11(?![0-9])|entity)/i;
/**
 * Which ICD a diagnosis code system names: 'icd10', 'icd11', 'icd' when it says only "ICD" (or names both, or
 * another revision), or null when it does not contain "ICD" (SNOMED CT, local codes), the same test as before.
 */
export function icdRevision(codeSystem: unknown): 'icd10' | 'icd11' | 'icd' | null {
  const system = text(codeSystem);
  if (!/icd/i.test(system)) return null;
  const ten = ICD10_SYSTEM.test(system), eleven = ICD11_SYSTEM.test(system);
  return ten === eleven ? 'icd' : ten ? 'icd10' : 'icd11';
}
/**
 * The stem codes in an ICD-11 code, cluster or list ("1C62.0", "1A62.2Y&XA6KU8", "5A11/1C62.1", "QE84, 7A00",
 * "HA60 gender incongruence"), in capitals and with the dot put back ("1C620" gives 1C62.0): each part between
 * '&', '/', ',', ';' or spaces that starts in stem form, less extension codes (X...), which never stand alone.
 */
function icd11Stems(code: unknown): string[] {
  return text(code).toUpperCase().split(/[&/,;\s]+/).filter(part => !part.startsWith('X')).flatMap(part => {
    const stem = ICD11_STEM.exec(part);
    return stem ? [stem[2] ? `${stem[1]}.${stem[2]}` : stem[1]!] : [];
  });
}
const covers = (entry: string, stem: string) => {
  const dash = entry.indexOf('-');
  if (dash < 0) return stem === entry || stem.startsWith(entry.includes('.') ? entry : `${entry}.`);
  const category = stem.slice(0, 4);
  return category >= entry.slice(0, 4) && category <= entry.slice(dash + 1, dash + 5);
};
const inGroup = (stem: string, group: Icd11SensitiveGroup) =>
  (group.codes.some(entry => covers(entry, stem)) || (group.exactly ?? []).includes(stem))
  && !(group.except ?? []).some(entry => covers(entry, stem));
/**
 * Whether a diagnosis is sensitive by its code. Both checks run for every code system containing "ICD", whichever
 * revision it names, since the label is free text and often wrong (the staff forms suggest "ICD-10"). The ICD-10
 * check runs exactly as before, on the code as stored, so nothing hidden before is shown now. The ICD-11 table runs
 * on each stem in ICD-11 form. That form has a letter second; every WHO ICD-10, ICD-10-CM and ICD-9 code has a
 * digit second, so no ICD-10 result changes (only an ICD-10-PCS procedure code of section 6A, not a diagnosis,
 * would read as chapter 06 and be hidden, the safe direction). A code in neither form is not sensitive by code;
 * the display text is still checked.
 */
export function isSensitiveDiagnosisCode(code: unknown, codeSystem: unknown): boolean {
  if (!icdRevision(codeSystem)) return false;
  return SENSITIVE_ICD10.test(text(code))
    || icd11Stems(code).some(stem => SENSITIVE_ICD11_GROUPS.some(group => inGroup(stem, group)));
}

function sensitive(record: Evidence): boolean {
  const f = record.fields;
  switch (record.kind) {
    case 'lab_result': case 'investigation': return isSensitiveTest(f.test, f.code, f.codeSystem) || isSensitiveTest(record.title);
    // The display text is checked whatever the code system (ICD-10, ICD-11, SNOMED CT, local); ICD-10 and ICD-11 codes as well.
    case 'diagnosis': return SENSITIVE_CONDITION.test(text(f.condition)) || SENSITIVE_CONDITION.test(record.title)
      || isSensitiveDiagnosisCode(f.code, f.codeSystem);
    case 'prescription': return SENSITIVE_MEDICINE.test(text(f.medication)) || SENSITIVE_MEDICINE.test(record.title);
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
