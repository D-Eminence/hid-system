import { SENSITIVE_LOINC_CODES, SENSITIVE_TEST_SQL_PATTERN, isSensitiveTest, patientEvidence, type PatientProfileInput } from './patient-evidence.policy';
import { PATIENT_EVIDENCE_QUERY, STAFF_EVIDENCE_QUERY } from './patient-evidence.query';
import { evidence, type Evidence, type SourceKind } from './patient-evidence.types';

// Ola's clinical answer on Q28 (confirmed): the further sensitive diagnoses, medicines and tests. Fictional records only.
const profile: PatientProfileInput = { firstName: 'Chiamaka', lastName: 'Eze', fullName: 'Chiamaka Eze', dateOfBirth: '1991-07-04', gender: 'female' };
const today = new Date('2026-11-04T09:00:00.000Z');
const encounterId = '60000000-0000-4000-8000-000000000028';
const completed = { _encounterId: encounterId, _encounterStatus: 'completed' };
let n = 0;
const record = (kind: SourceKind, fields: Record<string, unknown>, title: string) => {
  n += 1;
  return evidence({ kind, id: `28282828-2828-4828-8828-${String(n).padStart(12, '0')}`, version: '1', title,
    recordedAt: '2026-10-01T10:00:00.000Z', effectiveAt: null, provenance: 'Synthetic provenance', quality: 'recorded', fields });
};
const clean = (records: Evidence[]) => patientEvidence(records, profile, today);
const kept = (input: Evidence) => clean([input]).length === 1;
const diagnosis = (condition: string, code = 'R69', codeSystem = 'ICD-10') => record('diagnosis', { _encounterId: encounterId, codeSystem, code,
  condition, clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null, abatementAt: null }, condition);
const prescription = (medication: string, more: Record<string, unknown> = {}) => record('prescription', { ...completed, medication,
  doseQuantity: 1, doseUnit: 'tablet(s)', route: 'Oral', frequency: 'Once a day', startsOn: '2026-10-01', endsOn: null, status: 'active', ...more }, medication);
const request = (test: string, code = 'X1', codeSystem = 'LOCAL') =>
  record('investigation', { ...completed, test, codeSystem, code, status: 'active' }, test);
const lab = (test: string, more: Record<string, unknown> = {}, codeSystem = 'LOCAL', code = 'X1') => record('lab_result', { test, codeSystem, code,
  specimen: 'Blood', resultType: 'text', textValue: 'Synthetic value', recordedFlag: 'normal', releasedAt: '2026-10-01T10:00:00.000Z',
  verification: 'released', ...more }, test);
const sql = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');

describe('Q28 sensitive diagnoses (ICD-10 ranges and display text)', () => {
  it('leaves out the new ICD-10 ranges by code alone, with or without the dot', () => {
    const codes = ['D37.0', 'D39.1', 'D40.0', 'D44.9', 'D46.9', 'D47.1', 'D48.5', 'X60', 'X64.9', 'X70', 'X78.0', 'X84', 'X84.9', 'Z91.5', 'Z915',
      'T74.1', 'T74.2', 'Y05', 'Y06.1', 'Y07.9', 'Z20.2', 'Z202', 'Z20.6', 'Z11.4', 'Z71.7', 'Z22.5', 'Z30.0', 'Z30.9', 'Z37.0', 'Z37.1', 'Z39.0', 'Z39.2'];
    for (const code of codes) expect([code, kept(diagnosis('Synthetic code-only condition', code))]).toEqual([code, false]);
  });

  it('keeps neighbouring ICD-10 codes outside the ranges', () => {
    const codes = ['D36.9', 'D49', 'D50.9', 'D57.1', 'X59', 'X85', 'T73.0', 'T75.4', 'Y04', 'Y08', 'Z20.1', 'Z20.3', 'Z20.5', 'Z11.3', 'Z11.5',
      'Z71.6', 'Z71.8', 'Z22.4', 'Z22.6', 'Z91.4', 'Z91.6', 'Z31.0', 'Z38.0', 'Z40.0', 'Z88.0', 'I10', 'E11.9', 'J45.9', 'B54', 'A01.0'];
    for (const code of codes) expect([code, kept(diagnosis('Synthetic code-only condition', code))]).toEqual([code, true]);
  });

  it('leaves out the new groups by display text, whatever the code system', () => {
    const SENSITIVE = ['Myelodysplastic syndrome', 'Myelodysplasia', 'Neoplasm of uncertain behaviour of bladder', 'Polycythaemia vera',
      'Polycythemia vera', 'Myeloproliferative disorder', 'Essential thrombocythaemia', 'Self-harm', 'Self harm', 'Deliberate self-poisoning',
      'Deliberate self injury', 'Suicide attempt', 'Suicidal ideation', 'Overdose with intent', 'Intentional overdose', 'Sexual abuse',
      'Child sexual abuse', 'Child abuse', 'Physical abuse by partner', 'Emotional abuse', 'Elder abuse', 'Maltreatment syndrome',
      'Domestic violence', 'Intimate partner violence', 'Gender-based violence', 'Rape', 'Alleged rape', 'Sexual assault', 'Defilement',
      'Child neglect', 'Contraceptive counselling', 'Contraception management', 'Family planning', 'Postnatal care', 'Post-natal check',
      'Postpartum care', 'Delivery outcome', 'Outcome of delivery', 'Single live birth', 'Stillbirth', 'Carrier of hepatitis B',
      'Carrier of viral hepatitis', 'Exposure to HIV', 'HIV counselling', 'Screening for HIV', 'Contact with sexually transmitted infection'];
    for (const condition of SENSITIVE) {
      expect([condition, kept(diagnosis(condition))]).toEqual([condition, false]);
      expect([condition, kept(diagnosis(condition, 'SYN-1', 'http://snomed.info/sct'))]).toEqual([condition, false]);
    }
  });

  it('keeps ordinary diagnoses, including near words', () => {
    for (const condition of ['Hypertension', 'Essential hypertension', 'Malaria', 'Malaria (uncomplicated)', 'Typhoid fever', 'Diabetes mellitus type 2',
      'Type 2 diabetes mellitus', 'Asthma', 'Anaemia', 'Iron deficiency anaemia', 'Polycythaemia', 'Secondary polycythaemia', 'Drug allergy',
      'Grape allergy', 'Rib cage contusion', 'Delivery of care plan review', 'Liver abscess', 'Sickle cell anaemia', 'Upper respiratory tract infection'])
      expect([condition, kept(diagnosis(condition, 'I10'))]).toEqual([condition, true]);
  });
});

describe('Q28 sensitive medicines (patient chat)', () => {
  it('leaves out hepatitis B and C antivirals, and still tenofovir', () => {
    for (const medication of ['Entecavir 0.5 mg tablets', 'Sofosbuvir 400 mg', 'Daclatasvir 60 mg', 'Sofosbuvir/velpatasvir (Epclusa)',
      'Ledipasvir/sofosbuvir', 'Glecaprevir/pibrentasvir', 'Ribavirin 200 mg capsules', 'Peginterferon alfa-2a injection', 'Pegylated interferon',
      'Interferon alfa-2b', 'Tenofovir disoproxil 300 mg', 'Tenofovir alafenamide 25 mg'])
      expect([medication, kept(prescription(medication))]).toEqual([medication, false]);
  });

  it('leaves out cancer chemotherapy and hormonal cancer treatment by name', () => {
    for (const medication of ['Tamoxifen 20 mg', 'Letrozole 2.5 mg', 'Anastrozole 1 mg', 'Exemestane 25 mg', 'Goserelin 3.6 mg implant',
      'Leuprorelin 3.75 mg', 'Leuprolide acetate', 'Bicalutamide 50 mg', 'Abiraterone acetate 250 mg', 'Enzalutamide 40 mg',
      'Cyclophosphamide 500 mg/m2', 'Doxorubicin 50 mg', 'Cisplatin', 'Carboplatin', 'Paclitaxel', 'Docetaxel', 'Fluorouracil',
      '5-FU infusion', '5 FU', 'Capecitabine 500 mg', 'Vincristine 1 mg', 'Imatinib 400 mg'])
      expect([medication, kept(prescription(medication))]).toEqual([medication, false]);
  });

  it('does not leave out methotrexate by name alone (it is also used for rheumatoid arthritis and ectopic pregnancy)', () => {
    expect(kept(prescription('Methotrexate 7.5 mg weekly'))).toBe(true);
    expect(kept(prescription('Methotrexate 7.5 mg weekly', { _medicationCodeSystem: 'ATC', _medicationCode: 'L04AX03' }))).toBe(true);
  });

  it('leaves out any medicine coded ATC L01 or L02 (methotrexate as an antineoplastic included), and only under ATC', () => {
    for (const [system, code] of [['ATC', 'L01BA01'], ['http://www.whocc.no/atc', 'L01XE01'], ['WHO ATC', 'L02BA01'], ['atc', 'l02bb04'],
      ['urn:oid:2.16.840.1.113883.6.73', 'L01'], ['ATC', 'N07BC02'], ['ATC', 'N07BB04'], ['ATC', 'G03AD01'], ['ATC', 'G03XB01'], ['ATC', 'J05AP08']])
      expect([system, code, kept(prescription('Methotrexate 2.5 mg', { _medicationCodeSystem: system, _medicationCode: code }))]).toEqual([system, code, false]);
    for (const [system, code] of [['ATC', 'L04AX03'], ['ATC', 'L03AA02'], ['ATC', 'C08CA01'], ['LOCAL', 'L01BA01'], ['RxNorm', 'L01'],
      ['urn:oid:2.16.840.1.113883.6.88', 'L01BA01'], ['ATC', 'G03AA07']])
      expect([system, code, kept(prescription('Amlodipine 5 mg', { _medicationCodeSystem: system, _medicationCode: code }))]).toEqual([system, code, true]);
  });

  it('never passes the internal medicine code fields on to the chat', () => {
    const out = clean([prescription('Amlodipine 5 mg', { _medicationCodeSystem: 'ATC', _medicationCode: 'C08CA01' })]);
    expect(out).toHaveLength(1);
    expect(Object.keys(out[0]!.fields)).not.toContain('_medicationCode');
    expect(out[0]!.content).not.toContain('C08CA01');
  });

  it('leaves out opioid and alcohol dependence treatment, misoprostol and mifepristone', () => {
    for (const medication of ['Methadone oral solution 1 mg/ml', 'Buprenorphine 8 mg sublingual', 'Buprenorphine/naloxone', 'Naltrexone 50 mg',
      'Disulfiram 200 mg', 'Misoprostol 200 mcg', 'Mifepristone 200 mg', 'Mifepristone + misoprostol pack'])
      expect([medication, kept(prescription(medication))]).toEqual([medication, false]);
  });

  it('leaves out emergency contraception: levonorgestrel 1.5 mg or "emergency", Postinor and ulipristal', () => {
    for (const medication of ['Levonorgestrel 1.5 mg tablet', 'Levonorgestrel 1.5mg', 'Levonorgestrel 1,5 mg', 'Levonorgestrel 1500 mcg',
      'Levonorgestrel 1500 micrograms', 'Levonorgestrel 0.75 mg (emergency contraception)', 'Emergency contraceptive (levonorgestrel)',
      'Postinor-2', 'Ulipristal acetate 30 mg', 'ellaOne'])
      expect([medication, kept(prescription(medication))]).toEqual([medication, false]);
    // The dose recorded in its own fields, not in the name.
    expect(kept(prescription('Levonorgestrel tablet', { doseQuantity: 1.5, doseUnit: 'mg' }))).toBe(false);
    expect(kept(prescription('Levonorgestrel tablet', { doseQuantity: 1500, doseUnit: 'mcg' }))).toBe(false);
    expect(kept(prescription('Levonorgestrel tablet', { doseQuantity: '1.5000', doseUnit: 'mg' }))).toBe(false);
  });

  it('keeps ordinary contraception and ordinary medicines', () => {
    for (const medication of ['Levonorgestrel 30 mcg/ethinylestradiol 150 mcg (Microgynon)', 'Levonorgestrel implant (Jadelle)',
      'Amlodipine 5 mg', 'Metformin 500 mg', 'Artemether/lumefantrine 80/480 mg', 'Ciprofloxacin 500 mg', 'Salbutamol inhaler',
      'Ferrous sulphate 200 mg', 'Folic acid 5 mg', 'Paracetamol 1 g', 'Ibuprofen 400 mg', 'Prednisolone 5 mg', 'Hydroxychloroquine 200 mg'])
      expect([medication, kept(prescription(medication))]).toEqual([medication, true]);
    expect(kept(prescription('Levonorgestrel tablet', { doseQuantity: 30, doseUnit: 'mcg' }))).toBe(true);
  });

  it('keeps an ordinary medicine from the same visit as a sensitive diagnosis: prescriptions link to diagnoses only by encounter', () => {
    // ehr.prescriptions has no diagnosis or indication column; the only link is the shared encounter, which Ola's rule does not use.
    const out = clean([diagnosis('HIV disease', 'B20'), prescription('Paracetamol 1 g')]);
    expect(out.map(r => r.kind)).toEqual(['prescription']);
  });
});

describe('Q28 the patient evidence query passes the medicine code to the policy only as internal fields', () => {
  const branch = (query: string) => query.split('union all').find(b => b.includes("'prescription',"))!;
  it('reads medication_code_system and medication_code into _-prefixed keys for the patient, and leaves the staff query as it was', () => {
    expect(branch(PATIENT_EVIDENCE_QUERY)).toContain("'_medicationCodeSystem',p.medication_code_system,'_medicationCode',p.medication_code");
    expect(STAFF_EVIDENCE_QUERY).not.toContain('_medicationCode');
    expect(STAFF_EVIDENCE_QUERY).not.toContain('medication_code');
  });
});

describe('Q28 sensitive tests held until "Discussed with the patient"', () => {
  const SENSITIVE = ['HPV DNA', 'HPV DNA (high risk)', 'High-risk HPV', 'Human papillomavirus DNA', 'Human papilloma virus test',
    'Mycoplasma genitalium NAAT', 'M. genitalium PCR', 'MGen PCR', 'HBV DNA viral load', 'Hepatitis B DNA', 'Hep B DNA quantitative', 'HCV RNA',
    'HCV RNA viral load', 'Hepatitis C RNA', 'Urine drug screen', 'Drug screen', 'Drugs of abuse screen', 'Toxicology screen', 'Tox screen',
    'UDS', 'Benzodiazepine screen', 'Benzodiazepines, urine', 'Opiate screen', 'Opiates', 'Opioid screen', 'Cannabinoid screen', 'Cannabinoids (THC)',
    'Amphetamine screen', 'Amphetamines', 'Methamphetamine', 'Cocaine screen', 'Cocaine metabolite (benzoylecgonine)', 'Blood alcohol',
    'Serum alcohol', 'Breath alcohol', 'Alcohol level', 'Ethanol', 'Ethanol, serum', 'NIPT', 'Non-invasive prenatal testing', 'Cell-free DNA',
    'Cell free fetal DNA', 'cfDNA screen', 'Trisomy screen', 'Trisomy 21 risk', 'Prenatal screening', 'Bone marrow aspirate',
    'Bone marrow trephine', 'Bone marrow biopsy', 'Trephine biopsy', 'Flow cytometry', 'Flowcytometry', 'Immunophenotyping', 'AUDIT',
    'AUDIT-C', 'AUDIT score', 'CAGE', 'CAGE questionnaire', 'MMSE', 'Mini-Mental State Examination', 'Mini mental state', 'Hb genotype',
    'Haemoglobin genotype'];

  it('treats each one as a sensitive test, in the policy and the SQL pattern', () => {
    for (const name of SENSITIVE) {
      expect([name, isSensitiveTest(name)]).toEqual([name, true]);
      expect([name, sql.test(name)]).toEqual([name, true]);
    }
  });

  it('holds the result back until discussed, and leaves the test request out', () => {
    for (const name of SENSITIVE) {
      expect([name, clean([lab(name), lab(name, { _discussed: false }), request(name)])]).toEqual([name, []]);
      expect([name, clean([lab(name, { _discussed: true })]).length]).toEqual([name, 1]);
    }
  });

  it('keeps ordinary tests, and TB tests stay off the list', () => {
    for (const name of ['Full blood count', 'Haemoglobin', 'Malaria parasite (MRDT)', 'Widal', 'Fasting blood sugar', 'Urinalysis',
      'Liver function tests', 'Urine microscopy', 'Joint aspirate culture', 'Audiometry', 'Lactate', 'Blood culture', 'Electrolytes',
      'Sputum AFB', 'GeneXpert MTB/RIF', 'TB LAM', 'Mantoux test', 'Tuberculin skin test', 'Interferon gamma release assay', 'Chest X-ray',
      'Prothrombin time', 'Cell count (CSF)', 'Thyroid function', 'Packed cell volume', 'Erythrocyte sedimentation rate', 'Stool microscopy'])
      expect([name, isSensitiveTest(name), sql.test(name), clean([lab(name)]).length]).toEqual([name, false, false, 1]);
  });

  it('matches the listed LOINC codes only under LOINC', () => {
    const codes = ['21440-3', '30167-1', '11259-9', '11011-4', '5640-8', '5643-2', '72107-6', '75624-7', '75626-2'];
    for (const code of codes) {
      expect(SENSITIVE_LOINC_CODES).toContain(code);
      expect([code, isSensitiveTest('Synthetic screen', code, 'http://loinc.org')]).toEqual([code, true]);
      expect([code, isSensitiveTest('Synthetic screen', code, 'LOCAL')]).toEqual([code, false]);
      expect([code, clean([lab('Synthetic screen', {}, 'http://loinc.org', code)])]).toEqual([code, []]);
    }
  });

  it('still holds back any result the lab flags critical (D-B), whatever the test', () => {
    for (const name of ['Potassium', 'Haemoglobin', 'Glucose', 'Sodium'])
      expect([name, clean([lab(name, { recordedFlag: 'critical_candidate' })]), clean([lab(name, { recordedFlag: 'critical_candidate', _discussed: true })]).length])
        .toEqual([name, [], 1]);
  });
});
