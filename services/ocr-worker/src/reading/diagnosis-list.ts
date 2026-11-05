import { fuzzyListMatch, NOT_FOR_LISTS, type ListEntry } from './list-match';

/**
 * Diagnosis names a hard page's best-guess diagnosis may be grounded to (owner decision of 2026-11-05, about
 * 21:00 UTC, relayed by the coordinator: "add all those list now"; licences agreed about 20:25 UTC). Two lists:
 *
 * (a) ICD11_TITLES: titles of the ICD-11 for Mortality and Morbidity Statistics (MMS), reproduced verbatim.
 *     ICD-11, World Health Organization, licensed under CC BY-ND 3.0 IGO
 *     (https://creativecommons.org/licenses/by-nd/3.0/igo/). The titles are not modified: not shortened, respelled,
 *     re-cased or translated. Each title, and its code where it has one (a block, a grouping without a code, has
 *     null), was checked on 2026-11-05 against WHO's own release file for the ICD-11 MMS 2026-01 release,
 *     SimpleTabulation-ICD-11-MMS-en (https://icdcdn.who.int/static/releasefiles/2026-01/SimpleTabulation-ICD-11-MMS-en.zip,
 *     linked from the ICD-11 browser at https://icd.who.int/browse/2026-01/mms/en): only titles found there exactly
 *     are listed. A curated choice of common diagnoses on Nigerian outpatient and inpatient paper notes, not
 *     exhaustive, and not a coding of the record: the list codes nothing.
 * (b) DIAGNOSIS_SYNONYMS: our own words, not WHO's: abbreviations and local names written on Nigerian notes
 *     (HTN, DM, PUD, URTI, "MP+", typhoid, SCD, BPH, CCF, CKD, PID, UTI, AGE, ...), each mapped to one title of list
 *     (a). No ICD-10 content. Where an abbreviation does not say which of several titles is meant, it maps to the
 *     broader title that is true of all of them (HTN to "Hypertensive diseases", DM to "Diabetes mellitus", SCD to
 *     "Sickle cell disorders or other haemoglobinopathies"), never to a narrower one that adds what is not written
 *     (essential, type 2, without crisis).
 *
 * Matching is the strict matching of list-match.ts. A match changes nothing the paper says: the as-read name stays
 * in front and the title is added after it, "HTN? (Hypertensive diseases)"; a name already a title as written is
 * left as read. Applied only on hard pages (hard-page.ts), like the drug list; an unlisted diagnosis is left as read.
 */

/** ICD-11 MMS titles (verbatim) and codes (null for a block). ICD-11, World Health Organization, CC BY-ND 3.0 IGO. */
export const ICD11_TITLES: ReadonlyArray<readonly [title: string, code: string | null]> = [
  ['Cholera', '1A00'],
  ['Typhoid fever', '1A07'],
  ['Paratyphoid fever', '1A08'],
  ['Amoebiasis', '1A36'],
  ['Gastroenteritis or colitis without specification of infectious agent', '1A40'],
  ['Syphilis', null],
  ['Gonococcal infection', null],
  ['Trichomoniasis', '1A92'],
  ['Tuberculosis', null],
  ['Tuberculosis of the respiratory system', '1B10'],
  ['Leprosy', '1B20'],
  ['Impetigo', '1B72'],
  ['Furuncle', '1B75.0'],
  ['Tetanus', '1C13'],
  ['Human immunodeficiency virus disease', null],
  ['Bacterial meningitis', '1D01.0'],
  ['Yellow fever', '1D47'],
  ['Lassa fever', '1D61.2'],
  ['Mumps', '1D80'],
  ['Influenza', null],
  ['Acute hepatitis B', '1E50.1'],
  ['Chronic hepatitis B', '1E51.0'],
  ['Chronic hepatitis C', '1E51.1'],
  ['Mpox', '1E71'],
  ['Varicella', '1E90'],
  ['Measles', '1F03'],
  ['Vulvovaginal candidosis', '1F23.10'],
  ['Dermatophytosis', '1F28'],
  ['Malaria', null],
  ['Malaria due to Plasmodium falciparum', '1F40'],
  ['Malaria without parasitological confirmation', '1F45'],
  ['Schistosomiasis', '1F86'],
  ['Onchocerciasis', '1F6A'],
  ['Lymphatic filariasis', '1F66.3'],
  ['Scabies', '1G04'],
  ['Sepsis', null],
  ['Sepsis without septic shock', '1G40'],
  ['Sepsis with septic shock', '1G41'],
  ['Leiomyoma of uterus', '2E86.0'],
  ['Iron deficiency anaemia', '3A00'],
  ['Sickle cell disorders or other haemoglobinopathies', '3A51'],
  ['Sickle cell trait', '3A51.0'],
  ['Sickle cell disease without crisis', '3A51.1'],
  ['Sickle cell disease with crisis', '3A51.2'],
  ['Hypothyroidism', '5A00'],
  ['Thyrotoxicosis', '5A02'],
  ['Diabetes mellitus', null],
  ['Type 1 diabetes mellitus', '5A10'],
  ['Type 2 diabetes mellitus', '5A11'],
  ['Obesity', '5B81'],
  ['Dehydration', '5C70.0'],
  ['Hyperlipoproteinaemia', '5C80'],
  ['Schizophrenia', '6A20'],
  ['Generalised anxiety disorder', '6B00'],
  ['Epilepsy or seizures', null],
  ['Febrile seizures', '8A63.0'],
  ['Migraine', '8A80'],
  ['Cerebral ischaemic stroke', '8B11'],
  ['Intracerebral haemorrhage', '8B00'],
  ['Stroke not known if ischaemic or haemorrhagic', '8B20'],
  ['Transient ischaemic attack', '8B10'],
  ['Parkinson disease', '8A00.0'],
  ['Conjunctivitis', '9A60'],
  ['Cataract', '9B10'],
  ['Glaucoma', '9C61'],
  ['Acute otitis media', 'AB00'],
  ['Hypertensive diseases', null],
  ['Essential hypertension', 'BA00'],
  ['Hypertensive heart disease', 'BA01'],
  ['Hypertensive crisis', 'BA03'],
  ['Ischaemic heart diseases', null],
  ['Angina pectoris', 'BA40'],
  ['Heart failure', null],
  ['Congestive heart failure', 'BD10'],
  ['Diabetic foot ulcer', 'BD54'],
  ['Deep vein thrombosis', 'BD71'],
  ['Acute nasopharyngitis', 'CA00'],
  ['Acute sinusitis', 'CA01'],
  ['Acute pharyngitis', 'CA02'],
  ['Acute tonsillitis', 'CA03'],
  ['Acute upper respiratory infection, site unspecified', 'CA07.0'],
  ['Allergic rhinitis', 'CA08.0'],
  ['Chronic obstructive pulmonary disease', 'CA22'],
  ['Asthma', 'CA23'],
  ['Pneumonia', 'CA40'],
  ['Acute bronchiolitis', 'CA41'],
  ['Acute bronchitis', 'CA42'],
  ['Gastro-oesophageal reflux disease', 'DA22'],
  ['Gastritis', 'DA42'],
  ['Gastric ulcer', 'DA60'],
  ['Peptic ulcer, site unspecified', 'DA61'],
  ['Duodenal ulcer', 'DA63'],
  ['Appendicitis', 'DB10'],
  ['Haemorrhoids', 'DB60'],
  ['Hepatic cirrhosis', 'DB93.1'],
  ['Inguinal hernia', 'DD51'],
  ['Umbilical hernia', 'DD53'],
  ['Atopic eczema', 'EA80'],
  ['Acne', 'ED80'],
  ['Keloid', 'EE60.0'],
  ['Osteoarthritis', null],
  ['Osteoarthritis of knee', 'FA01'],
  ['Rheumatoid arthritis', 'FA20'],
  ['Gout', 'FA25'],
  ['Osteomyelitis or osteitis', 'FB84'],
  ['Female pelvic inflammatory diseases', 'GA05'],
  ['Female infertility', 'GA31'],
  ['Male infertility', 'GB04'],
  ['Dysmenorrhoea', 'GA34.3'],
  ['Hyperplasia of prostate', 'GA90'],
  ['Nephrotic syndrome', 'GB41'],
  ['Acute pyelonephritis', 'GB51'],
  ['Acute kidney failure', 'GB60'],
  ['Chronic kidney disease', 'GB61'],
  ['Cystitis', 'GC00'],
  ['Urinary tract infection, site not specified', 'GC08'],
  ['Spontaneous abortion', 'JA00.0'],
  ['Threatened abortion', 'JA40.0'],
  ['Ectopic pregnancy', 'JA01'],
  ['Gestational hypertension', 'JA23'],
  ['Pre-eclampsia', 'JA24'],
  ['Eclampsia', 'JA25'],
  ['Postpartum haemorrhage', 'JA43'],
  ['Diabetes mellitus in pregnancy', 'JA63'],
  ['Preterm labour or delivery', 'JB00'],
  ['Maternal care related to premature rupture of membranes', 'JA89'],
  ['Malignant neoplasms of breast', null],
  ['Malignant neoplasms of cervix uteri', '2C77'],
  ['Malignant neoplasms of prostate', '2C82'],
  ['Hepatocellular carcinoma of liver', '2C12.02'],
  ['Dyspepsia', 'MD92'],
  ['Diarrhoea', 'ME05.1'],
  ['Low back pain', 'ME84.2'],
  ['Sepsis of fetus or newborn', 'KA60'],
];

/**
 * Our own abbreviations and local names (list (b)), each mapped to an ICD-11 title of ICD11_TITLES. Lower case;
 * matched after normalisation (listKey).
 */
export const DIAGNOSIS_SYNONYMS: Readonly<Record<string, string>> = {
  // Hypertension and the heart
  'htn': 'Hypertensive diseases',
  'hypertension': 'Hypertensive diseases',
  'hhd': 'Hypertensive heart disease',
  'ccf': 'Congestive heart failure',
  'chf': 'Congestive heart failure',
  'congestive cardiac failure': 'Congestive heart failure',
  'hf': 'Heart failure',
  'ihd': 'Ischaemic heart diseases',
  'angina': 'Angina pectoris',
  'dvt': 'Deep vein thrombosis',
  'cva': 'Stroke not known if ischaemic or haemorrhagic',
  'stroke': 'Stroke not known if ischaemic or haemorrhagic',
  'tia': 'Transient ischaemic attack',
  // Diabetes, thyroid, metabolism
  'dm': 'Diabetes mellitus',
  'diabetes': 'Diabetes mellitus',
  't2dm': 'Type 2 diabetes mellitus',
  'dm2': 'Type 2 diabetes mellitus',
  'type 2 dm': 'Type 2 diabetes mellitus',
  'type ii dm': 'Type 2 diabetes mellitus',
  't1dm': 'Type 1 diabetes mellitus',
  'dm1': 'Type 1 diabetes mellitus',
  'type 1 dm': 'Type 1 diabetes mellitus',
  'type i dm': 'Type 1 diabetes mellitus',
  'dfu': 'Diabetic foot ulcer',
  'diabetic foot': 'Diabetic foot ulcer',
  'gdm': 'Diabetes mellitus in pregnancy',
  'hyperthyroidism': 'Thyrotoxicosis',
  'hyperlipidaemia': 'Hyperlipoproteinaemia',
  'hyperlipidemia': 'Hyperlipoproteinaemia',
  // Infections
  'mp+': 'Malaria',
  'mp +ve': 'Malaria',
  'falciparum malaria': 'Malaria due to Plasmodium falciparum',
  'typhoid': 'Typhoid fever',
  'enteric fever': 'Typhoid fever',
  'urti': 'Acute upper respiratory infection, site unspecified',
  'uti': 'Urinary tract infection, site not specified',
  'age': 'Gastroenteritis or colitis without specification of infectious agent',
  'acute gastroenteritis': 'Gastroenteritis or colitis without specification of infectious agent',
  'gastroenteritis': 'Gastroenteritis or colitis without specification of infectious agent',
  'tb': 'Tuberculosis',
  'ptb': 'Tuberculosis of the respiratory system',
  'pulmonary tb': 'Tuberculosis of the respiratory system',
  'pulmonary tuberculosis': 'Tuberculosis of the respiratory system',
  'rvd': 'Human immunodeficiency virus disease',
  'retroviral disease': 'Human immunodeficiency virus disease',
  'hiv': 'Human immunodeficiency virus disease',
  'hiv disease': 'Human immunodeficiency virus disease',
  'chronic hep b': 'Chronic hepatitis B',
  'chronic hep c': 'Chronic hepatitis C',
  'pid': 'Female pelvic inflammatory diseases',
  'pelvic inflammatory disease': 'Female pelvic inflammatory diseases',
  'gonorrhoea': 'Gonococcal infection',
  'gonorrhea': 'Gonococcal infection',
  'vvc': 'Vulvovaginal candidosis',
  'vaginal candidiasis': 'Vulvovaginal candidosis',
  'ringworm': 'Dermatophytosis',
  'tinea': 'Dermatophytosis',
  'chickenpox': 'Varicella',
  'monkeypox': 'Mpox',
  'flu': 'Influenza',
  'common cold': 'Acute nasopharyngitis',
  'coryza': 'Acute nasopharyngitis',
  'aom': 'Acute otitis media',
  'bilharzia': 'Schistosomiasis',
  'bilharziasis': 'Schistosomiasis',
  'river blindness': 'Onchocerciasis',
  'elephantiasis': 'Lymphatic filariasis',
  'lassa': 'Lassa fever',
  'nns': 'Sepsis of fetus or newborn',
  'neonatal sepsis': 'Sepsis of fetus or newborn',
  // Blood
  'scd': 'Sickle cell disorders or other haemoglobinopathies',
  'sickle cell disease': 'Sickle cell disorders or other haemoglobinopathies',
  'sca': 'Sickle cell disorders or other haemoglobinopathies',
  'sickle cell anaemia': 'Sickle cell disorders or other haemoglobinopathies',
  'hbss': 'Sickle cell disorders or other haemoglobinopathies',
  'scd in crisis': 'Sickle cell disease with crisis',
  'sickle cell crisis': 'Sickle cell disease with crisis',
  'ida': 'Iron deficiency anaemia',
  // Gut and liver
  'pud': 'Peptic ulcer, site unspecified',
  'peptic ulcer disease': 'Peptic ulcer, site unspecified',
  'gerd': 'Gastro-oesophageal reflux disease',
  'gord': 'Gastro-oesophageal reflux disease',
  'piles': 'Haemorrhoids',
  'liver cirrhosis': 'Hepatic cirrhosis',
  'cirrhosis': 'Hepatic cirrhosis',
  'hcc': 'Hepatocellular carcinoma of liver',
  'diarrhea': 'Diarrhoea',
  // Kidney and urinary
  'ckd': 'Chronic kidney disease',
  'aki': 'Acute kidney failure',
  'acute kidney injury': 'Acute kidney failure',
  'bph': 'Hyperplasia of prostate',
  'benign prostatic hyperplasia': 'Hyperplasia of prostate',
  // Lungs
  'copd': 'Chronic obstructive pulmonary disease',
  'bronchial asthma': 'Asthma',
  // Pregnancy
  'pih': 'Gestational hypertension',
  'pet': 'Pre-eclampsia',
  'pre-eclamptic toxaemia': 'Pre-eclampsia',
  'pph': 'Postpartum haemorrhage',
  'prom': 'Maternal care related to premature rupture of membranes',
  'preterm labour': 'Preterm labour or delivery',
  'ectopic gestation': 'Ectopic pregnancy',
  'miscarriage': 'Spontaneous abortion',
  'threatened miscarriage': 'Threatened abortion',
  'fibroids': 'Leiomyoma of uterus',
  'uterine fibroids': 'Leiomyoma of uterus',
  'fibroid uterus': 'Leiomyoma of uterus',
  'dysmenorrhea': 'Dysmenorrhoea',
  // Bones, joints, nerves, mind, cancer
  'oa': 'Osteoarthritis',
  'oa knee': 'Osteoarthritis of knee',
  'knee oa': 'Osteoarthritis of knee',
  'ra': 'Rheumatoid arthritis',
  'gouty arthritis': 'Gout',
  'osteomyelitis': 'Osteomyelitis or osteitis',
  'lbp': 'Low back pain',
  'epilepsy': 'Epilepsy or seizures',
  'seizure disorder': 'Epilepsy or seizures',
  'febrile convulsion': 'Febrile seizures',
  'febrile convulsions': 'Febrile seizures',
  'gad': 'Generalised anxiety disorder',
  "parkinson's disease": 'Parkinson disease',
  'ca cervix': 'Malignant neoplasms of cervix uteri',
  'cervical cancer': 'Malignant neoplasms of cervix uteri',
  'ca prostate': 'Malignant neoplasms of prostate',
  'prostate cancer': 'Malignant neoplasms of prostate',
  'ca breast': 'Malignant neoplasms of breast',
  'breast cancer': 'Malignant neoplasms of breast',
};

/**
 * A name as a list key: lower case, accents off, the reading's "?" marks and a paper query "[?]" taken off, "+"
 * kept (so "MP+" is not "MP -ve"), a hyphen kept only in "-ve", every other mark a space. compactKey also takes the spaces out, for an exact match that ignores spacing and slashes.
 */
export function listKey(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\[\?\]/g, ' ')
    .replace(/\?/g, ' ').replace(/-(?=ve\b)/g, '\u0001').replace(/'/g, '').replace(/[^a-z0-9+\u0001 ]/g, ' ')
    .replace(/\u0001/g, '-').replace(/\s*\+\s*/g, '+ ').replace(/\s+/g, ' ').trim();
}
export const compactKey = (text: string) => listKey(text).replace(/ /g, '');

/** A name grounded to a list: what it stands for, and what the field shows. */
export interface ListMatch {
  /** The listed name it stands for (for a diagnosis, the ICD-11 title as written by WHO). */
  title: string;
  /** What the field shows: the name as read, unchanged where it is the listed name, else "As read? (title)". */
  display: string;
  /** Whether the name as read was a listed name or synonym (after normalisation), not respelled by the fuzzy match. */
  exact: boolean;
}

/** Entries of a list: each name and synonym under its key, standing for its title. */
export function listEntries(titles: readonly string[], synonyms: Readonly<Record<string, string>>):
  ListEntry<string>[] {
  return [...titles.map((title) => ({ key: listKey(title), target: title, value: title })),
    ...Object.entries(synonyms).map(([name, title]) => ({ key: listKey(name), target: title, value: title }))];
}

/**
 * The listed name a proposed name stands for, or null (the shared lookup of diagnosis-list.ts and lab-list.ts).
 * Exact first, on the key and on the key without spaces; then the strict fuzzy match. A name holding
 * "[unreadable]", "[sign?]" or "(sign)", or with no letters, never matches. Where the name as read is the listed
 * name itself, the display is the name as read; otherwise "As read? (listed name)", so what was written stays in
 * front and the list's name is only added (never shown alone).
 */
export function matchListName(proposed: string, entries: readonly ListEntry<string>[]): ListMatch | null {
  const shown = proposed.trim();
  if (!shown || NOT_FOR_LISTS.test(shown)) return null;
  const key = listKey(shown);
  if (!/[a-z]/.test(key)) return null;
  const display = (title: string) => listKey(title) === key ? shown : `${shown.replace(/\?+$/, '')}? (${title})`;
  const exact = entries.find((entry) => entry.key === key)
    ?? entries.find((entry) => entry.key.replace(/ /g, '') === key.replace(/ /g, ''));
  if (exact) return { title: exact.target, display: display(exact.target), exact: true };
  const best = fuzzyListMatch([key], entries);
  return best === null ? null : { title: best.entry.target, display: display(best.entry.target), exact: false };
}

/** Every diagnosis name and synonym, normalised, with the ICD-11 title it stands for. */
export const DIAGNOSIS_ENTRIES: readonly ListEntry<string>[] = listEntries(ICD11_TITLES.map(([title]) => title),
  DIAGNOSIS_SYNONYMS);

/** The ICD-11 title a proposed diagnosis name stands for, or null (see matchListName). */
export function matchDiagnosisName(proposed: string): ListMatch | null {
  return matchListName(proposed, DIAGNOSIS_ENTRIES);
}
