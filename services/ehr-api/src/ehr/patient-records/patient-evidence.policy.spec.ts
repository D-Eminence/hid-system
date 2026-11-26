import { INITIALISMS_TAKING_LETTERS, LAB_CORRECTING, PATIENT_FIELDS, LOINC_SYSTEM_SQL_PATTERN, SENSITIVE_ICD11_GROUPS, SENSITIVE_LOINC_CODES,
  SENSITIVE_TEST_INITIALISMS, SENSITIVE_TEST_SQL_PATTERN, VITAL_FIELDS, ageYears, dottedInitialism, icdRevision, initialismForm,
  isSensitiveDiagnosisCode, isSensitiveTest, patientEvidence, redactIdentifiers, type PatientProfileInput } from './patient-evidence.policy';
import { evidence, type Evidence, type SourceKind } from './patient-evidence.types';

// Fictional patient and records only.
const profile: PatientProfileInput = { firstName: 'Adaeze', lastName: 'Okafor', fullName: 'Adaeze Okafor',
  dateOfBirth: '1994-03-12', gender: 'female' };
const today = new Date('2026-10-05T09:00:00.000Z');
const encounterId = '60000000-0000-4000-8000-000000000001';
let n = 0;
const record = (kind: SourceKind, fields: Record<string, unknown>, extra: Partial<Evidence> & { originHint?: string } = {}) => {
  n += 1;
  return evidence({ kind, id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`, version: '1', title: `Synthetic ${kind}`,
    recordedAt: '2026-10-01T10:00:00.000Z', effectiveAt: null, provenance: 'Synthetic provenance', quality: 'recorded',
    ...extra, fields });
};
const completed = { _encounterId: encounterId, _encounterStatus: 'completed' };
const clean = (records: Evidence[]) => patientEvidence(records, profile, today);
const one = (input: Evidence) => { const out = clean([input]); expect(out).toHaveLength(1); return out[0]!; };

describe('Patient chat policy: diagnoses (A1)', () => {
  const diagnosis = (verificationStatus: string, condition = 'Essential hypertension', code = 'I10') =>
    record('diagnosis', { _encounterId: encounterId, codeSystem: 'ICD-10', code, condition, clinicalStatus: 'active',
      verificationStatus, onsetAt: null, abatementAt: null, notes: 'Synthetic clinician working note' }, { title: condition });

  it('keeps only confirmed diagnoses, without the clinician notes', () => {
    const out = clean(['refuted', 'differential', 'provisional', 'unconfirmed', 'entered_in_error', 'confirmed'].map(s => diagnosis(s)));
    expect(out).toHaveLength(1);
    expect(out[0]!.fields).toEqual({ codeSystem: 'ICD-10', code: 'I10', condition: 'Essential hypertension', clinicalStatus: 'active',
      verificationStatus: 'confirmed', onsetAt: null, abatementAt: null });
    expect(out[0]!.content).not.toContain('Synthetic clinician working note');
    expect(out[0]!.encounterId).toBe(encounterId);
  });

  it('leaves out sensitive conditions by name or ICD-10 code until they can be discussed', () => {
    expect(clean([diagnosis('confirmed', 'HIV disease', 'B20'), diagnosis('confirmed', 'Synthetic code-only condition', 'B24'),
      diagnosis('confirmed', 'Chronic hepatitis B', 'B18.1'), diagnosis('confirmed', 'Depressive episode', 'F32.9'),
      diagnosis('confirmed', 'Malignant neoplasm of breast', 'C50.9')])).toEqual([]);
    expect(clean([diagnosis('confirmed', 'Malaria (uncomplicated)', 'B54'), diagnosis('confirmed', 'Iron deficiency anaemia', 'D50.9'),
      diagnosis('confirmed', 'Allergy to penicillin (rash)', 'Z88.0')])).toHaveLength(3);
  });
});

describe('Patient chat policy: test requests and prescriptions (A2, A3)', () => {
  const request = (status: string, test = 'Full blood count', more: Record<string, unknown> = completed) =>
    record('investigation', { ...more, test, codeSystem: 'LOCAL', code: 'FBC', status, priority: 'urgent',
      information: 'Synthetic clinical reason for the request' }, { title: test, quality: status });
  const prescription = (status: string, medication = 'Amlodipine 5 mg tablets', more: Record<string, unknown> = completed) =>
    record('prescription', { ...more, medication, doseQuantity: 1, doseUnit: 'tablet(s)', route: 'Oral', frequency: 'Once a day',
      instructions: 'Synthetic free-text instruction', startsOn: '2026-10-01', endsOn: null, status }, { title: medication, quality: status });

  it('keeps active, on-hold and completed requests without the reason or priority', () => {
    const out = clean(['draft', 'cancelled', 'entered_in_error', 'active', 'on_hold', 'completed'].map(s => request(s)));
    expect(out.map(r => r.fields.status)).toEqual(['active', 'on_hold', 'completed']);
    for (const r of out) {
      expect(Object.keys(r.fields).sort()).toEqual(['code', 'codeSystem', 'status', 'test']);
      expect(r.content).not.toMatch(/Synthetic clinical reason|urgent/);
    }
  });

  it('keeps active, on-hold and completed prescriptions without the free-text instructions', () => {
    const out = clean(['draft', 'cancelled', 'entered_in_error', 'active', 'on_hold', 'completed'].map(s => prescription(s)));
    expect(out.map(r => r.fields.status)).toEqual(['active', 'on_hold', 'completed']);
    for (const r of out) {
      expect(r.fields).not.toHaveProperty('instructions');
      expect(r.content).not.toContain('Synthetic free-text instruction');
    }
  });

  it('leaves out sensitive tests and antiretroviral medicines', () => {
    expect(clean([request('active', 'HIV 1/2 rapid test'), request('active', 'Retroviral screening (RVS)'), request('active', 'HBsAg'),
      prescription('active', 'Tenofovir/lamivudine/dolutegravir (TLD) tablets')])).toEqual([]);
    expect(isSensitiveTest('Malaria parasite (MRDT)')).toBe(false);
    expect(isSensitiveTest('Synthetic test', 'HIV-AB')).toBe(true);
  });

  // A4: withdrawn and unfinished visits.
  it.each(['in_progress', 'cancelled', 'entered_in_error', 'planned', 'on_hold', undefined])(
    'leaves out notes, prescriptions and requests from a visit that is %s', status => {
      const visit = { _encounterId: encounterId, ...(status ? { _encounterStatus: status } : {}) };
      expect(clean([request('active', 'Full blood count', visit), prescription('active', 'Amlodipine 5 mg tablets', visit),
        record('note', { ...visit, noteType: 'consultation', text: 'Synthetic note', signedAt: '2026-10-01T10:00:00Z' })])).toEqual([]);
    });
});

describe('Patient chat policy: notes, documents and origin (A5)', () => {
  it('keeps a note from a completed visit with only its type, text and signing time, and keeps its origin', () => {
    const note = record('note', { ...completed, noteType: 'consultation', text: 'Synthetic note text',
      signedAt: '2026-10-01T10:00:00Z', revisionRecordedAt: '2026-10-01T10:00:00Z' }, { originHint: 'scanned_paper' });
    expect(note.origin).toBe('scanned_paper');
    const out = one(note);
    expect(Object.keys(out.fields).sort()).toEqual(['noteType', 'signedAt', 'text']);
    expect(out.origin).toBe('scanned_paper');
    expect(out.content).not.toContain('_encounterStatus');
  });

  it('never uses a file name as a title', () => {
    const doc = one(record('document', { text: 'Synthetic scan text' }, { title: 'okafor_adaeze_hiv_letter.pdf' }));
    const att = one(record('attachment', { text: 'Synthetic scan text' }, { title: 'IMG_2026_adaeze.jpg' }));
    expect(doc.title).toBe('Clinical document');
    expect(att.title).toBe('Imported document');
    expect(doc.content + att.content).not.toMatch(/\.pdf|\.jpg|okafor|adaeze/i);
    expect(doc.origin).toBe('scanned_paper');
  });

  it('keeps an import\'s recorded origin and strips internal keys', () => {
    const provider = record('import', { category: 'lab', record: 'Synthetic history', _internal: 'x' }, { originHint: 'provider-authored' });
    const patient = record('import', { category: 'lab', record: 'Synthetic history' }, { originHint: 'patient-provided' });
    expect(one(provider).origin).toBe('health_worker');
    expect(one(provider).fields).not.toHaveProperty('_internal');
    expect(one(patient).origin).toBe('patient');
  });
});

describe('Patient chat policy: Lab results (A6)', () => {
  const lab = (fields: Record<string, unknown>, title = 'Haemoglobin') => record('lab_result', { test: title, codeSystem: 'LOCAL', code: 'HB',
    specimen: 'blood', resultType: 'numeric', numericValue: '12.5', textValue: null, unit: 'g/dL', referenceRange: '12-16',
    recordedFlag: 'normal', revisionKind: 'original', collectedAt: '2026-10-01T09:00:00Z', releasedAt: '2026-10-01T12:00:00Z',
    verification: 'exact-version manually verified and released', ...fields }, { title });

  it('drops the correction reason even when an older Lab service still sends it', () => {
    const out = one(lab({ correctionReason: 'Synthetic correction reason', revisionKind: 'correction' }));
    expect(out.fields).not.toHaveProperty('correctionReason');
    expect(out.fields.numericValue).toBe('12.5');
    expect(out.fields).not.toHaveProperty('correctionPending');
    expect(out.fields).not.toHaveProperty('status');
  });

  it('shows a result being corrected as a placeholder with no value', () => {
    const out = one(lab({ correctionPending: true, status: 'anything', numericValue: '99.9', textValue: 'Synthetic old value' }));
    expect(out.fields).toEqual({ test: 'Haemoglobin', codeSystem: 'LOCAL', code: 'HB', specimen: 'blood',
      collectedAt: '2026-10-01T09:00:00Z', correctionPending: true, status: LAB_CORRECTING });
    expect(out.content).not.toMatch(/99\.9|Synthetic old value|g\/dL/);
  });

  it('leaves out sensitive tests', () => {
    expect(clean([lab({}, 'HIV 1/2 antibody'), lab({}, 'Beta hCG'), lab({}, 'Haemoglobin genotype'), lab({}, 'VDRL')])).toEqual([]);
  });
});

describe('Patient chat policy: profile, age and sex (A7)', () => {
  const profileRecord = () => record('profile', { firstName: 'Adaeze', lastName: 'Okafor', fullName: 'Adaeze Okafor',
    dateOfBirth: '1994-03-12', gender: 'female', country: 'NG', state: 'Lagos' }, { title: 'Patient profile' });

  it('gives the chat only age and sex', () => {
    const out = one(profileRecord());
    expect(out.fields).toEqual({ ageYears: 32, sex: 'female' });
    expect(out.title).toBe('Age and sex');
    expect(out.origin).toBe('health_id_profile');
    expect(out.content).not.toMatch(/Adaeze|Okafor|1994|Lagos|NG/);
  });

  it('counts the birthday in Lagos time, including 29 February', () => {
    expect(ageYears('1994-10-05', today)).toBe(32);
    expect(ageYears('1994-10-06', today)).toBe(31);
    // 23:30 UTC on 4 October is already 5 October in Lagos.
    expect(ageYears('1994-10-05', new Date('2026-10-04T23:30:00Z'))).toBe(32);
    expect(ageYears('2004-02-29', new Date('2026-02-28T12:00:00Z'))).toBe(21);
    expect(ageYears('2004-02-29', new Date('2026-03-01T12:00:00Z'))).toBe(22);
    expect(ageYears('2004-02-29', new Date('2028-02-29T12:00:00Z'))).toBe(24);
    expect(ageYears(null, today)).toBeNull();
    expect(ageYears('not a date', today)).toBeNull();
  });

  it('accepts only a known sex value', () => {
    expect(patientEvidence([profileRecord()], { ...profile, gender: 'Female; DOB 1994' }, today)[0]!.fields.sex).toBeNull();
    expect(patientEvidence([profileRecord()], { ...profile, gender: 'male' }, today)[0]!.fields.sex).toBe('male');
  });

  it('leaves the name and date of birth in no record content', () => {
    const records = clean([profileRecord(),
      record('note', { ...completed, noteType: 'summary', text: 'Adaeze Okafor, born 1994-03-12 (12/03/1994), seen today.', signedAt: null },
        { title: 'Review for Adaeze Okafor' }),
      record('import', { record: { summary: 'Patient ADAEZE reported on 12 March 1994 birthday' }, notes: ['Okafor family history'] },
        { title: 'Adaeze history' })]);
    for (const r of records) expect(r.content).not.toMatch(/Adaeze|Okafor|ADAEZE|1994-03-12|12\/03\/1994|12 March 1994/i);
  });
});

describe('Identifier redaction in free text (A8)', () => {
  const r = (text: string) => redactIdentifiers(text, profile);

  it('removes Health IDs, phone numbers, ID numbers, hospital numbers and emails', () => {
    expect(r('Health ID HID-AB2CD3EF and hid-ab2cd3ef.')).toBe('Health ID [Health ID removed] and [Health ID removed].');
    expect(r('Call +2348031234567 or 08031234567.')).toBe('Call [phone removed] or [phone removed].');
    expect(r('Phone 0803 123 4567, 0803-123-4567, +234 803 123 4567.')).toBe('Phone [phone removed], [phone removed], [phone removed].');
    expect(r('NIN 12345678901.')).toBe('NIN [ID number removed].');
    expect(r('Write to synthetic.person@example.test today')).toBe('Write to [email removed] today');
    expect(r('Hospital no: LUTH/2026/0042 and MRN 778812')).toBe('Hospital no: [record number removed] and MRN [record number removed]');
  });

  it('keeps clinical values and visit dates', () => {
    const text = 'Hb 12.5 g/dL on 2026-10-05; BP 120/80; pulse 88; FBS 5.4 mmol/L; 1 tablet twice a day for 14 days.';
    expect(r(text)).toBe(text);
  });

  it('replaces the patient\'s name and removes a relative\'s full name', () => {
    expect(r('Emergency contact: Chinedu Okafor (sibling).')).toBe('Emergency contact: [name removed] (sibling).');
    expect(r('Adaeze Okafor attended. Adaeze reports less fatigue. Mrs Okafor agreed.'))
      .toBe('the patient attended. the patient reports less fatigue. [name removed] agreed.');
    expect(r('Date of birth 12/03/1994, also 1994-03-12 and March 12, 1994.'))
      .toBe('Date of birth [date of birth removed], also [date of birth removed] and [date of birth removed].');
  });

  it('does not rewrite a given name that is also an everyday word', () => {
    const named = { ...profile, firstName: 'Blessing', fullName: 'Blessing Okafor' };
    expect(redactIdentifiers('Counselled; no blessing or hope needed. Blessing returns in 2 weeks.', named))
      .toBe('Counselled; no blessing or hope needed. the patient returns in 2 weeks.');
  });

  it('does not rewrite codes, test names or dates outside free text', () => {
    const lab = one(record('lab_result', { test: 'Okafor-Adaeze panel', code: 'HID-AB2CD3EF', collectedAt: '1994-03-12T00:00:00Z',
      numericValue: '12345678901' }, { title: 'Okafor-Adaeze panel' }));
    expect(lab.fields).toMatchObject({ test: 'Okafor-Adaeze panel', code: 'HID-AB2CD3EF', collectedAt: '1994-03-12T00:00:00Z' });
  });
});

describe('Patient chat policy: vitals (A9) and hashes', () => {
  it('keeps only the allowlisted vital measures', () => {
    const out = one(record('vital', { _encounterId: encounterId, recorded_at: '2026-10-01T10:00:00Z', systolic_mmhg: 120, diastolic_mmhg: 80,
      pulse_bpm: 72, source: 'manual', created_by: 'synthetic-account', future_column: 'x', row_version: 3 }));
    expect(Object.keys(out.fields).every(k => (VITAL_FIELDS as readonly string[]).includes(k))).toBe(true);
    expect(out.fields).toEqual({ recorded_at: '2026-10-01T10:00:00Z', systolic_mmhg: 120, diastolic_mmhg: 80, pulse_bpm: 72, source: 'manual' });
    expect(PATIENT_FIELDS.vital).toBe(VITAL_FIELDS);
  });

  it('gives the same hashes for two snapshots of the same data, and a hash over the cleaned content only', () => {
    n = 1000;
    const make = () => [record('note', { ...completed, noteType: 'consultation', text: 'Seen Adaeze. Call 08031234567.', signedAt: null }),
      record('diagnosis', { codeSystem: 'ICD-10', code: 'I10', condition: 'Essential hypertension', verificationStatus: 'confirmed', notes: 'x' })];
    const first = clean(make()); n = 1000; const second = clean(make());
    expect(first.map(r => r.hash)).toEqual(second.map(r => r.hash));
    expect(first.map(r => r.id)).toEqual(second.map(r => r.id));
    const original = make()[0]!;
    expect(first[0]!.hash).not.toBe(original.hash);
    expect(first[0]!.content).toContain('the patient');
  });
});

describe('Sensitive shorthand as Nigerian clinicians write it (S4)', () => {
  const rx = (medication: string) => record('prescription', { ...completed, medication, status: 'active' }, { title: medication });
  const dx = (condition: string) => record('diagnosis', { _encounterId: encounterId, codeSystem: 'LOCAL', code: 'X1', condition,
    verificationStatus: 'confirmed' }, { title: condition });

  it('leaves out antiretroviral regimens written as component abbreviations or brand names', () => {
    for (const medication of ['TDF/3TC/DTG', 'AZT/3TC/NVP', 'TDF/3TC/EFV', 'ABC/3TC', 'LPV/r', 'ATV/r 300/100 mg', 'TLD 1 tab daily',
      'Truvada', 'ART refill']) expect(clean([rx(medication)])).toEqual([]);
    for (const medication of ['Amlodipine 5 mg', 'Artemether/lumefantrine (ACT)', 'Paracetamol 1 g', 'Ferrous sulphate'])
      expect(clean([rx(medication)])).toHaveLength(1);
  });

  it('leaves out RVD, RVI, PLWHA and "Ca <site>" cancer shorthand, and keeps ordinary conditions', () => {
    for (const condition of ['RVD', 'RVI', 'PLWHA', 'PLHIV on HAART', 'Ca breast', 'Ca prostate', 'Ca. of the cervix', 'Breast ca',
      'CA cx']) expect(clean([dx(condition)])).toEqual([]);
    for (const condition of ['Malaria', 'Hypocalcaemia', 'Low Ca level', 'Carpal tunnel syndrome', 'Cataract', 'Peptic ulcer disease'])
      expect(clean([dx(condition)])).toHaveLength(1);
  });

  it('treats Hb electrophoresis (the genotype test) and VL (viral load) as sensitive tests', () => {
    for (const name of ['Hb electrophoresis', 'Haemoglobin electrophoresis', 'VL', 'HIV VL']) expect(isSensitiveTest(name)).toBe(true);
    for (const name of ['Haemoglobin', 'Serum protein electrophoresis', 'Full blood count']) expect(isSensitiveTest(name)).toBe(false);
  });
});

describe('Identifier redaction: other ways the date of birth, phone, Health ID and NIN are written (A8)', () => {
  const adaeze: PatientProfileInput = { firstName: 'Adaeze', lastName: 'Okafor', fullName: 'Adaeze Okafor', dateOfBirth: '1990-03-12' };
  const r = (text: string, p = adaeze) => redactIdentifiers(text, p);

  it('removes the date of birth written with hyphens, dots, slashes or without leading zeros', () => {
    for (const dob of ['12-Mar-1990', '12 Mar 1990', '12.Mar.1990', '12/March/1990', '12th of March, 1990', 'Mar-12-1990',
      '1990-3-12', '1990/03/12', '12-3-1990']) expect(r(`DOB ${dob} noted`)).toBe('DOB [date of birth removed] noted');
    expect(r('Seen on 12-Mar-2026 and 1990-3-13.')).toBe('Seen on 12-Mar-2026 and 1990-3-13.');
  });

  it('removes phone numbers with brackets, dots or "(0)"', () => {
    for (const phone of ['(0803) 123 4567', '+234 (0) 803 123 4567', '0803.123.4567', '(+234) 803-123-4567', '0803 123 4567'])
      expect(r(`Tel: ${phone}.`)).toBe('Tel: [phone removed].');
  });

  it('removes a Health ID written without its hyphen, but not the verb "hid"', () => {
    expect(r('Health ID HID AB2CD3EF; also hid ab2cd3ef and HIDAB2CD3EF.'))
      .toBe('Health ID [Health ID removed]; also [Health ID removed] and [Health ID removed].');
    expect(r('Patient hid tablets under the pillow.')).toBe('Patient hid tablets under the pillow.');
  });

  it('removes a NIN written in groups', () => {
    expect(r('NIN: 1234 5678 901.')).toBe('NIN: [ID number removed].');
    expect(r('NIN 123-4567-8901 and 1234-5678-901.')).toBe('NIN [ID number removed] and [ID number removed].');
  });

  it('cleans the scanned header and keeps clinical values', () => {
    expect(r('DOB: 12-Mar-1990  Tel: (0803) 123 4567\nHb 9.2 g/dL, BP 120/80, pulse 88, PCV 30%.'))
      .toBe('DOB: [date of birth removed]  Tel: [phone removed]\nHb 9.2 g/dL, BP 120/80, pulse 88, PCV 30%.');
  });
});

describe('Names that are also ordinary words are not rewritten (A8)', () => {
  it('keeps "Sunday" as a day for patient Ngozi Sunday, and still removes her name', () => {
    const ngozi: PatientProfileInput = { firstName: 'Ngozi', lastName: 'Sunday', fullName: 'Ngozi Sunday' };
    expect(redactIdentifiers('Review next Sunday with repeat FBC. Patient may come on sunday morning.', ngozi))
      .toBe('Review next Sunday with repeat FBC. Patient may come on sunday morning.');
    expect(redactIdentifiers('Ngozi Sunday attended with Mr Emeka Sunday. Mrs Sunday agreed. NGOZI returns.', ngozi))
      .toBe('the patient attended with Mr [name removed]. [name removed] agreed. the patient returns.');
  });

  it('keeps "will" for patient Musa Will, and keeps lower-case words that match a surname', () => {
    const musa: PatientProfileInput = { firstName: 'Musa', lastName: 'Will', fullName: 'Musa Will' };
    expect(redactIdentifiers('The pain will improve; we will review. Will review in 2 weeks.', musa))
      .toBe('The pain will improve; we will review. Will review in 2 weeks.');
    const bello: PatientProfileInput = { firstName: 'Ada', lastName: 'bello', fullName: 'Ada bello' };
    expect(redactIdentifiers('Seen by Bello. A bello is not a word here; BELLO signed.', bello))
      .toBe('Seen by [name removed]. A bello is not a word here; [name removed] signed.');
  });

  it('still removes an ordinary surname in any capitalised form', () => {
    expect(redactIdentifiers('Okafor family history; OKAFOR, A. signed; okafor lower-case stays.', profile))
      .toBe('[name removed] family history; [name removed], A. signed; okafor lower-case stays.');
  });
});

describe('Review fixes: sensitive tests written out in full or coded in LOINC (S4)', () => {
  const lab = (test: string, codeSystem = 'LOCAL', code = 'X1') => record('lab_result', { test, codeSystem, code, specimen: 'Blood',
    resultType: 'text', textValue: 'Synthetic value', releasedAt: '2026-10-01T10:00:00.000Z', verification: 'released' }, { title: test });
  const request = (test: string, codeSystem = 'LOCAL', code = 'X1') =>
    record('investigation', { ...completed, test, codeSystem, code, status: 'completed' }, { title: test });
  const LONG_NAMES = ['Prostate specific Ag [Mass/volume] in Serum or Plasma', 'Alpha-1-Fetoprotein [Mass/volume] in Serum or Plasma',
    'Carcinoembryonic Ag [Mass/volume] in Serum or Plasma', 'Cancer Ag 125 [Units/volume] in Serum or Plasma',
    'Choriogonadotropin [Units/volume] in Serum or Plasma', 'Human chorionic gonadotropin', 'Human immunodeficiency virus 1+2 antibody',
    'Hep B surface antigen', 'HBs Ag', 'Hep C antibody'];

  it('treats the spelled-out names as sensitive, in the policy and in the SQL pattern', () => {
    const sql = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
    for (const name of LONG_NAMES) {
      expect([name, isSensitiveTest(name)]).toEqual([name, true]);
      expect([name, sql.test(name)]).toEqual([name, true]);
    }
    expect(clean([...LONG_NAMES.map(name => lab(name)), ...LONG_NAMES.map(name => request(name))])).toEqual([]);
  });

  it('treats the listed LOINC codes as sensitive whatever the display text, only under LOINC', () => {
    for (const code of ['75622-1', '56888-1', '7917-8', '68961-2', '5196-1', '5195-3', '16128-1', '13955-0', '2106-3', '21198-7',
      '2119-6', '2857-1', '35741-8', '1834-1', '19176-1', '2039-6', '10334-1', '24467-3', '20447-9']) {
      expect([code, isSensitiveTest('Synthetic screen', code, 'http://loinc.org')]).toEqual([code, true]);
      expect(clean([lab('Synthetic screen', 'http://loinc.org', code), request('Synthetic screen', 'http://loinc.org', code)])).toEqual([]);
    }
    expect(SENSITIVE_LOINC_CODES).toContain('2857-1');
    // The same code in another system, and an ordinary LOINC test, stay.
    expect(isSensitiveTest('Synthetic screen', '2857-1', 'LOCAL')).toBe(false);
    expect(clean([lab('Hemoglobin [Mass/volume] in Blood', 'http://loinc.org', '718-7')])).toHaveLength(1);
  });

  it('keeps ordinary tests whose names are near the new words', () => {
    for (const name of ['Full blood count', 'Heparin level', 'Haemoglobin', 'Hepatic function panel', 'Specific gravity of urine',
      'Prostate examination note', 'Fasting blood sugar', 'Thyroid uptake']) expect([name, isSensitiveTest(name)]).toEqual([name, false]);
  });
});

describe('Review fixes: sensitive diagnoses in SNOMED or local codes (S4)', () => {
  const diagnosis = (codeSystem: string, code: string, condition: string) => record('diagnosis', { _encounterId: encounterId, codeSystem,
    code, condition, clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null, abatementAt: null }, { title: condition });

  it('leaves out an HIV, gestational or antenatal diagnosis by its display text whatever the code system', () => {
    expect(clean([diagnosis('http://snomed.info/sct', '86406008', 'Human immunodeficiency virus infection'),
      diagnosis('LOCAL', 'HIV1', 'Human immunodeficiency virus infection'),
      diagnosis('http://snomed.info/sct', '11687002', 'Gestational diabetes mellitus'),
      diagnosis('LOCAL', 'ANC', 'Antenatal care, first visit')])).toEqual([]);
    // ICD-10 codes are still checked.
    expect(clean([diagnosis('ICD-10', 'B20', 'Synthetic code-only condition')])).toEqual([]);
    expect(clean([diagnosis('http://snomed.info/sct', '38341003', 'Hypertensive disorder'),
      diagnosis('LOCAL', 'MAL', 'Malaria (uncomplicated)')])).toHaveLength(2);
  });
});

describe('Review fixes: the date of birth with a two-digit year or spaces (A8)', () => {
  const adaeze: PatientProfileInput = { firstName: 'Adaeze', lastName: 'Okafor', fullName: 'Adaeze Okafor', dateOfBirth: '1990-03-12' };
  const r = (text: string) => redactIdentifiers(text, adaeze);

  it('removes "12/03/90", "12 03 1990", "12-3-90" and similar', () => {
    for (const dob of ['12/03/90', '12 03 1990', '12-3-90', '12 / 03 / 1990', '12.03.90', '12 - 3 - 90', '1990 03 12'])
      expect([dob, r(`DOB ${dob} noted`)]).toEqual([dob, 'DOB [date of birth removed] noted']);
  });

  it('keeps blood pressure, other numbers and visit dates', () => {
    const text = 'BP 120/80 on 12/03/26 and 12 03 2026; seen 13/03/90; Hb 12.3 g/dL; 12-3-1991; ratio 12/3.';
    expect(r(text)).toBe(text);
  });
});

describe('Second review: more spellings, codes and diagnoses (S4)', () => {
  const lab = (test: string, codeSystem = 'LOCAL', code = 'X1') => record('lab_result', { test, codeSystem, code, specimen: 'Blood',
    resultType: 'text', textValue: 'Synthetic value', releasedAt: '2026-10-01T10:00:00.000Z', verification: 'released' }, { title: test });
  const diagnosis = (condition: string, codeSystem = 'http://snomed.info/sct') => record('diagnosis', { _encounterId: encounterId,
    codeSystem, code: '1', condition, clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null, abatementAt: null },
  { title: condition });
  const SPELLINGS = ['HepBsAg', 'Hep Bs Ag', 'Hep-Bc', 'Hep. B surface antigen', 'Hep. C antibody', 'Hep B', 'Hep.B', 'HBsAg',
    'H.I.V screen', 'H. I. V. test', 'Human immuno-deficiency virus', 'CD 4 count', 'CD-4 count', 'CA.125', 'CA.19.9'];

  it('treats hepatitis, HIV, CD4 and CA-125 written with dots, spaces or hyphens as sensitive, in the policy and the SQL pattern', () => {
    const sql = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
    for (const name of SPELLINGS) {
      expect([name, isSensitiveTest(name)]).toEqual([name, true]);
      expect([name, sql.test(name)]).toEqual([name, true]);
    }
    expect(clean(SPELLINGS.map(name => lab(name)))).toEqual([]);
    for (const name of ['Hepcidin', 'Heparin anti-Xa', 'Hepatic function panel', 'Hep A IgM', 'CD8 count', 'Absolute neutrophil count (ANC)'])
      expect([name, isSensitiveTest(name), sql.test(name)]).toEqual([name, false, false]);
  });

  it('treats the further LOINC codes as sensitive, and LOINC by its OID', () => {
    for (const code of ['7918-6', '29893-5', '31201-7', '5221-7', '10351-5', '25836-8', '2118-8', '19080-2'])
      expect([code, isSensitiveTest('Lab test', code, 'http://loinc.org')]).toEqual([code, true]);
    for (const system of ['urn:oid:2.16.840.1.113883.6.1', '2.16.840.1.113883.6.1', ' LOINC '])
      expect([system, isSensitiveTest('Lab test', '2857-1', system)]).toEqual([system, true]);
    // Another OID that only starts the same way is not LOINC.
    for (const system of ['urn:oid:2.16.840.1.113883.6.10', 'urn:oid:2.16.840.1.113883.6.96', '12.16.840.1.113883.6.1'])
      expect([system, isSensitiveTest('Lab test', '2857-1', system)]).toEqual([system, false]);
    const sql = new RegExp(LOINC_SYSTEM_SQL_PATTERN, 'i');
    expect(['urn:oid:2.16.840.1.113883.6.1', 'http://loinc.org'].every(s => sql.test(s))).toBe(true);
    expect(sql.test('urn:oid:2.16.840.1.113883.6.96')).toBe(false);
  });

  it('leaves out a diagnosis whose display text names a group SENSITIVE_ICD10 hides by code, whatever the code system', () => {
    const SENSITIVE = ['Hep. B infection', 'H.I.V. infection', 'Human immuno-deficiency virus infection', 'Ante-natal care',
      'Ante natal visit', 'ANC booking', 'Primigravida', 'Miscarriage', 'Threatened abortion', 'Incomplete abortion', 'Pre-eclampsia',
      'Eclampsia', 'Hyperemesis gravidarum', 'Placenta praevia', 'Hydatidiform mole', 'Hepatoma', 'Melanoma', 'Multiple myeloma',
      'Glioblastoma', 'Seminoma', 'Mesothelioma', 'Hodgkin disease', 'Adenocarcinoma of colon', 'Osteosarcoma', 'Alcohol use disorder',
      'Opioid dependence', 'PTSD', 'Obsessive compulsive disorder', 'Mental disorder', 'Genital warts'];
    for (const condition of SENSITIVE) {
      expect([condition, clean([diagnosis(condition)])]).toEqual([condition, []]);
      expect([condition, clean([diagnosis(condition, 'LOCAL')])]).toEqual([condition, []]);
    }
  });

  it('keeps ordinary diagnoses whose names are near the new words', () => {
    for (const condition of ['Malaria', 'Typhoid fever', 'Hypertension', 'Diabetes mellitus', 'Asthma', 'Haematoma', 'Glaucoma',
      'Trachoma', 'Paraplegia', 'Peptic ulcer disease', 'Sickle cell anaemia', 'Ectopic beats'])
      expect([condition, clean([diagnosis(condition)]).length]).toEqual([condition, 1]);
  });
});

describe('Second review: the date of birth, without catching clinical numbers (A8)', () => {
  const r = (text: string, dateOfBirth = '1990-03-12') => redactIdentifiers(text, { firstName: 'Adaeze', lastName: 'Okafor', dateOfBirth });

  it('keeps a dose, a rate or a blood pressure whose digits line up with the date of birth', () => {
    expect(r('dose 12.3.90 mg?')).toBe('dose 12.3.90 mg?');
    expect(r('RR 12 03 1990?')).toBe('RR 12 03 1990?');
    expect(r('BP 1/12/12?', '2012-12-01')).toBe('BP 1/12/12?');
  });

  it('removes the forms written after "born", "DOB" or "date of birth", and full dates anywhere', () => {
    for (const text of ['born 3/12/1990', 'born 12031990', 'born 19900312', 'born 1990-03-12T00:00', 'DOB: 12/3/90', 'born on 3 12 1990',
      'Date of birth is 12 03 1990', 'dob 120390'])
      expect([text, r(text)]).toEqual([text, text.replace(/(born on |born |DOB: |Date of birth is |dob ).*/, '$1[date of birth removed]')]);
    expect(r('seen 1990-03-12T08:30:00Z, and 12/03/1990 noted')).toBe('seen [date of birth removed], and [date of birth removed] noted');
    expect(r('BP 120/80 on 12/03/2024')).toBe('BP 120/80 on 12/03/2024');
  });
});

/*
 * ICD-11 sensitive diagnosis codes (S4). The ranges are a draft for the clinical lead (owner decision Q124 A
 * sign-off; Ola's decision 5 on #258). Fictional patients; the codes are WHO's ICD-11 MMS 2026-01 codes, or
 * codes in ICD-11 form placed just outside a range.
 */
describe('Sensitive diagnoses by ICD-11 code (S4, draft ranges for the clinical lead)', () => {
  const diagnosis = (codeSystem: string, code: string, condition = 'Synthetic code-only condition') => record('diagnosis', {
    _encounterId: encounterId, codeSystem, code, condition, clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null,
    abatementAt: null }, { title: condition });
  const icd11 = (code: unknown) => isSensitiveDiagnosisCode(code, 'ICD-11');

  // Per group: codes inside (the first and last code of each range, a subcode) and codes just outside each edge.
  const EDGES: ReadonlyArray<readonly [group: string, inside: readonly string[], outside: readonly string[]]> = [
    ['HIV disease', ['1C60', '1C60.0', '1C61.3Z', '1C62.0', '1C62.30', '1C62.Z', 'KA62.6', 'KA62.60'],
      ['1C5Z', '1C63', '1C6Y', 'KA62', 'KA62.5', 'KA62.7', 'KA60']],
    ['Laboratory evidence of HIV', ['MA14.0', 'MA14.00'], ['MA14', 'MA14.1', 'MA14.10', 'MA13.Z', 'MA15']],
    ['Viral hepatitis', ['1E50', '1E50.1', '1E51.00', '1E51.1', '1E5Z'], ['1E4Z', '1E60', '1E71']],
    ['Predominantly sexually transmitted infections', ['1A60', '1A62.2Y', '1A92', '1A9Z'], ['1A5Z', '1B00', '1A40', '1B10']],
    ['Malignant neoplasms, except of lymphoid, haematopoietic or central nervous system tissues',
      ['2B50', '2C12.02', '2C77', '2C82', '2D4Z', '2E2Z'], ['2B4Z', '2E30', '2E86.0']],
    ['Neoplasms of haematopoietic or lymphoid tissues', ['2A20', '2A20.0', '2A83.0', '2B3Z'], ['2A1Z', '2B40']],
    ['Neoplasms of the central nervous system', ['2A00', '2A00.5', '2A00.21', '2A02', '2A02.2', '2A0Z'],
      ['1H0Z', '2A10', '2A02.3', '2A02.30', '2A02.4']],
    ['In situ neoplasms', ['2E60', '2E65', '2E6Y', '2E6Z'], ['2E5Z', '2E70', '2E86.0']],
    ['Mental, behavioural or neurodevelopmental disorders (chapter 06)', ['6A00', '6A20', '6B00', '6C40', '6D80', '6E8Z'],
      ['5Z9Z', '5C80', '6E90', '7A20']],
    ['Mental or behavioural conditions outside chapter 06', ['HA00', 'HA0Z', 'HA20', 'HA2Z', 'HA60', 'HA61', 'HA6Z', '8A05', '8A05.00',
      '8A05.Z', '8A07.0', '8A07.0Z', '8A62.2', 'LD90.4', 'QE84', 'QA15.1', '7A00', '7A01', '7A0Z', '7B00.1', '7B01', '7B01.2', '7B2Z'],
    ['GZ9Z', 'HA10', 'HA1Z', 'HA30', 'HA5Z', 'HA70', '8A04', '8A06', '8A07', '8A07.1', '8A62.1', 'LD90.3', 'QE83', 'QE85', 'QA15',
      'QA15.0', '7A20', '7A40', '7A83', '7B00', '7B00.0', '7B01.0', '7A00.0']],
    ['Pregnancy, childbirth or the puerperium (chapter 18)', ['JA00', 'JA00.0', 'JA24', 'JB00', 'JB63.7', 'JB6Z'], ['HZ9Z', 'JB70', 'KA60']],
    ['Pregnancy care contacts', ['QA40', 'QA41', 'QA42.0', 'QA43', 'QA43.30', 'QA43.Z', 'QA45', 'QA45.Z'],
      ['QA3Z', 'QA44', 'QA46', 'QA47', 'QA48', 'QA4Z']],
  ];

  it('is a readable table of WHO codes and ranges, one row per group, each with edge tests', () => {
    const STEM = /^[1-9A-HJ-NP-Z][A-HJ-NP-Z][0-9][0-9A-HJ-NP-Z](?:\.[0-9A-HJ-NP-Z]{1,2})?$/;
    const CATEGORY = /^[1-9A-HJ-NP-Z][A-HJ-NP-Z][0-9][0-9A-HJ-NP-Z]$/;
    const groups = SENSITIVE_ICD11_GROUPS.map(g => g.group);
    expect(new Set(groups).size).toBe(groups.length);
    expect(EDGES.map(([group]) => group).sort()).toEqual([...groups].sort());
    for (const g of SENSITIVE_ICD11_GROUPS) {
      expect(g.icd10).not.toBe('');
      for (const entry of [...g.codes, ...(g.except ?? [])]) {
        const [from = '', to, ...rest] = entry.split('-');
        if (to === undefined) { expect([entry, STEM.test(entry)]).toEqual([entry, true]); continue; }
        // A range runs from a category to a category or its last code (".Z"), so comparing categories is exact.
        const last = CATEGORY.test(to) || (CATEGORY.test(to.slice(0, 4)) && to.slice(4) === '.Z');
        expect([entry, rest.length, CATEGORY.test(from), last, from <= to.slice(0, 4)]).toEqual([entry, 0, true, true, true]);
      }
      for (const code of g.exactly ?? []) expect([code, STEM.test(code)]).toEqual([code, true]);
      expect([...g.codes, ...(g.exactly ?? [])].filter(code => code.startsWith('X'))).toEqual([]);
    }
  });

  it.each(EDGES)('%s: hides the first and last code of each range and keeps the codes just outside', (_group, inside, outside) => {
    for (const code of inside) expect([code, icd11(code)]).toEqual([code, true]);
    for (const code of outside) expect([code, icd11(code)]).toEqual([code, false]);
  });

  it('keeps ordinary ICD-11 diagnoses', () => {
    for (const code of ['1A00', '1A07', '1B10', '1E71', '1F40', '1G40', '2E86.0', '3A00', '3A51.1', '5A11', '8A00.0', '8A63.0', '8A80',
      'BA00', 'CA23', 'CA40', 'DA42', 'GB51', 'GB61', 'KA60', 'MD92', 'ME84.2']) expect([code, icd11(code)]).toEqual([code, false]);
  });

  it('checks every stem of a cluster and ignores extension codes', () => {
    for (const code of ['1C62.0&XN487', '1A62.2Y&XA6KU8', '1A60.3/8C03.1', '5A11/1C62.1', 'BA00/2C77', '2C12.02&XH4XG8', '6A70&XS25'])
      expect([code, icd11(code)]).toEqual([code, true]);
    // An extension code never stands alone, even one in the four-character stem form (XK8G).
    for (const code of ['XN487', 'XK8G', 'GB51&XK8G&XN6P4', 'BA41.0&XA7RE3&XA7NQ7', 'BA00/5A11'])
      expect([code, icd11(code)]).toEqual([code, false]);
  });

  it('trims and case-folds, and finds nothing by code in a code of neither form', () => {
    for (const code of [' 1c62.0 ', '1c62.0 & xn487', 'ba00 / 6a70', '\t2e65\n', 'qa41']) expect([code, icd11(code)]).toEqual([code, true]);
    for (const code of ['1C6', 'HIV disease', '1000704511', 'http://id.who.int/icd/release/11/mms/1000704511', '', 42, null, undefined])
      expect([code, icd11(code)]).toEqual([code, false]);
  });

  it('reads a code without its dot, with a note after it, or in a list, as the ICD-10 prefix rule does', () => {
    for (const code of ['1C620', '2A204', '1C62.', '1C62.000', '1C62-0', 'HA60 gender incongruence', 'QE84, 7A00', '1C62.0;6A70',
      '1C62,0', 'BA00 6A70', '7B012']) expect([code, icd11(code)]).toEqual([code, true]);
    // Without its dot, a code that counts alone still counts alone: 7A000 is 7A00.0, not 7A00.
    for (const code of ['7A000', 'BA00, 5A11', 'BA00 essential hypertension']) expect([code, icd11(code)]).toEqual([code, false]);
  });

  it('finds nothing by code when a character is outside the ICD-11 alphabet, even where its category would sort inside a range', () => {
    // A fourth character I or O would sort inside 6A00-6E8Z, JA00-JB6Z and 2B50-2E2Z.
    for (const code of ['6B0I', 'JA0O', '2C1O', '6B0I.0', '1I62.0', '1O62.0', '0C62.0', 'IC62.0'])
      expect([code, icd11(code)]).toEqual([code, false]);
  });

  it('tells ICD-10 from ICD-11 by the code system name or URI, and ICD alone from neither', () => {
    const SYSTEMS = {
      icd10: ['ICD-10', 'icd10', 'ICD 10', 'ICD_10', ' ICD-10 ', 'ICD-10-CM', 'ICD10CM', 'http://hl7.org/fhir/sid/icd-10',
        'http://hl7.org/fhir/sid/icd-10-cm', 'http://id.who.int/icd/release/10/2019'],
      icd11: ['ICD-11', 'icd11', 'ICD 11', 'ICD-11 MMS', 'ICD11MMS', 'ICD-11-MMS 2026-01', 'http://id.who.int/icd/release/11/mms',
        'http://id.who.int/icd/release/11/2026-01/mms', 'http://id.who.int/icd/entity'],
      icd: ['ICD', 'icd', 'WHO ICD', 'ICD-9-CM', 'ICD-O-3', 'ICD-10/ICD-11', 'ICD-10/11', 'ICD 10/11', 'ICD 10 / 11', 'ICD-110'],
      none: ['http://snomed.info/sct', 'SNOMED CT', 'LOCAL', 'http://loinc.org', '', undefined, null, 11],
    } as const;
    for (const [revision, systems] of Object.entries(SYSTEMS)) {
      for (const system of systems) expect([system, icdRevision(system)]).toEqual([system, revision === 'none' ? null : revision]);
    }
    // ICD-10 and ICD-11 codes alike: under every ICD system, whichever revision it names (a free-text label can be wrong,
    // and the two code forms never overlap), never under another.
    for (const code of ['1C62.0', 'B20']) {
      for (const system of [...SYSTEMS.icd10, ...SYSTEMS.icd11, ...SYSTEMS.icd])
        expect([code, system, isSensitiveDiagnosisCode(code, system)]).toEqual([code, system, true]);
      for (const system of SYSTEMS.none) expect([code, system, isSensitiveDiagnosisCode(code, system)]).toEqual([code, system, false]);
    }
    // Every ICD system goes by the code's form: ICD-10 codes against the ICD-10 list, ICD-11 codes against the ICD-11 table.
    for (const system of ['ICD', 'ICD-10', 'ICD-11', 'ICD-10/11']) {
      expect([system, ['F32.9', '6A70', 'O14.9', 'JA24', 'I10', 'BA00'].map(code => isSensitiveDiagnosisCode(code, system))])
        .toEqual([system, [true, true, true, true, false, false]]);
    }
  });

  it('leaves the records out of the patient chat by code alone, and keeps ordinary ones', () => {
    expect(clean([...['1C62.0', '1E51.0', '1A92', '2C77', '2E65', '6A20', 'JA24', 'QA41', 'MA14.0', 'HA60', '1C62.0&XN487']
      .map(code => diagnosis('ICD-11', code)), diagnosis('http://id.who.int/icd/release/11/mms', '6B00'), diagnosis('ICD', '1E51.1'),
    diagnosis('ICD-10', '6A20')])).toEqual([]);
    const kept = clean([diagnosis('ICD-11', 'BA00', 'Essential hypertension'),
      diagnosis('http://id.who.int/icd/release/11/mms', '1F40', 'Malaria due to Plasmodium falciparum'),
      diagnosis('ICD', '5A11', 'Type 2 diabetes mellitus'), diagnosis('ICD-10', 'BA00', 'Essential hypertension'),
      diagnosis('http://snomed.info/sct', '1C62.0')]);
    expect(kept.map(r => r.fields.code)).toEqual(['BA00', '1F40', '5A11', 'BA00', '1C62.0']);
    // The name is still checked whatever the code.
    expect(clean([diagnosis('ICD-11', 'BA00', 'HIV disease'), diagnosis('ICD-11', '1F40', 'Schizophrenia')])).toEqual([]);
  });

  it('leaves out ICD-11 codes sent under an ICD-10 label, a label naming both revisions, or written without the dot or with a note', () => {
    // None of these names matches the name check, so the code is the only protection.
    for (const [codeSystem, code, condition] of [['ICD-10', 'HA60', 'Gender incongruence of adolescence or adulthood'],
      ['ICD-10', '6C50', 'Gambling disorder'], ['ICD-10', '6A00', 'Disorders of intellectual development'],
      ['ICD-10', '6B24', 'Hoarding disorder'], ['ICD-10', '6C20', 'Bodily distress disorder'], ['ICD-10', '1C62.1', 'Stage 2'],
      ['ICD-10', 'QE84', 'Acute stress reaction'], ['ICD-10/11', 'HA60', 'Gender incongruence of adolescence or adulthood'],
      ['ICD 10/11', '2A20.4', 'Polycythaemia vera'], ['ICD-11', '2A204', 'Polycythaemia vera'],
      ['ICD-11', 'HA60 gender incongruence', 'Gender incongruence'], ['ICD-11', 'QE84, 7A00', 'Acute stress reaction']] as const) {
      expect([codeSystem, code, clean([diagnosis(codeSystem, code, condition)])]).toEqual([codeSystem, code, []]);
      expect([condition, clean([diagnosis('LOCAL', code, condition)]).length]).toEqual([condition, 1]);
    }
  });

  it('leaves out insomnia, unspecified (7A0Z, where WHO maps F51.0) and hypomania (MB2Y, where WHO maps F30.0)', () => {
    expect(clean([diagnosis('ICD-11', '7A0Z', 'Insomnia disorders, unspecified'), diagnosis('ICD-11', '7A00', 'Chronic insomnia'),
      diagnosis('ICD-11', 'MB2Y', 'Hypomania'), diagnosis('ICD-11', 'MB2Y', 'Hypomanic episode'),
      diagnosis('LOCAL', 'X1', 'Hypomania')])).toEqual([]);
    // MB2Y is a residual category, so the code alone does not hide it; the name does.
    expect(icd11('MB2Y')).toBe(false);
  });
});

describe('Sensitive diagnoses by ICD-10 code: unchanged by the ICD-11 split (S4)', () => {
  // Today's rule, copied verbatim from before the split, so every ICD-10 result is pinned.
  const BEFORE_ICD10 = /^(?:B2[0-4]|Z21|R75|B1[5-9]|A5\d|A6[0-4]|C\d\d|D0\d|F\d\d|O\d\d|Z3[2-6])/i;
  const asText = (value: unknown) => typeof value === 'string' ? value : '';
  const before = (code: unknown, codeSystem: unknown) => /icd/i.test(asText(codeSystem)) && BEFORE_ICD10.test(asText(code));

  it('gives the same answer as before for every ICD-10 code under every code system', () => {
    const systems = ['ICD-10', 'icd10', 'ICD 10', 'ICD-10-CM', 'http://hl7.org/fhir/sid/icd-10', 'http://hl7.org/fhir/sid/icd-10-cm', 'ICD',
      'icd', 'ICD-9-CM', 'ICD-O-3', 'ICD-11', 'http://id.who.int/icd/release/11/mms', 'http://snomed.info/sct', 'LOCAL', '', undefined, null];
    const codes = ['B20', 'B21.0', 'B24', 'B24.9', 'B25', 'B19.9', 'B15', 'B14', 'Z21', 'Z20', 'Z22', 'R75', 'R74', 'R76', 'A50', 'A59.0',
      'A64', 'A49', 'A65', 'C00', 'C50.9', 'C97', 'C4A.0', 'O9A.1', 'Z3A.01', 'D00', 'D09.9', 'D10', 'D50.9', 'F00', 'F32.9', 'F99', 'O00', 'O14.9', 'O99.9',
      'Z32', 'Z33', 'Z36.9', 'Z31', 'Z37', 'Z88.0', 'I10', 'E11', 'B54', 'B50.9', 'b20', 'f32.9', 'B20-B24', 'C50.9X',
      'F32 depressive episode', ' B20', 'B20 ', '\tF32', '', 'X', '042', 'V22.0', 'E950', '8500/3', 'HIV', 42, null, undefined];
    const differ: unknown[] = [];
    for (const system of systems) {
      for (const code of codes) if (isSensitiveDiagnosisCode(code, system) !== before(code, system)) differ.push([system, code]);
    }
    expect(differ).toEqual([]);
  });

  it('hides the same ICD-10 codes as before, and keeps the same ones', () => {
    for (const code of ['B20', 'B24.9', 'b20', 'Z21', 'R75', 'B15', 'B19.9', 'A50', 'A64', 'C00', 'C50.9', 'C97', 'D00', 'D09.9', 'F00',
      'F32.9', 'F99', 'O00', 'O99.9', 'Z32', 'Z36.9']) expect([code, isSensitiveDiagnosisCode(code, 'ICD-10')]).toEqual([code, true]);
    for (const code of ['B14', 'B25', 'Z20', 'Z22', 'R74', 'R76', 'A49', 'A65', 'D10', 'D50.9', 'E11', 'I10', 'Z31', 'Z37', 'Z88.0', 'B54',
      '']) expect([code, isSensitiveDiagnosisCode(code, 'ICD-10')]).toEqual([code, false]);
    // An ICD-11 code under an ICD-10 label is a mislabel; the ICD-11 table still hides it.
    for (const code of ['1C62.0', '6A20', 'JA00', 'QA41']) expect([code, isSensitiveDiagnosisCode(code, 'ICD-10')]).toEqual([code, true]);
  });
});

// 0155 (ORD-7): a facility's own lab test is ordered by its name only (its code is a UUID), so its name is all that can
// hide it. Ola's call as clinical owner (design note on #258, 26 Nov 2026): the HIV rapid-test kit names, and a dotted
// form of each initialism, made the same way in lab-api's copy.
describe('0155: HIV rapid-test kits and dotted initialisms (S4)', () => {
  const sql = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
  const lab = (test: string) => record('lab_result', { test, codeSystem: 'HID-FACILITY', code: '7d1c3a52-5f0e-4c1b-9a63-2b8e4f6a9c01',
    specimen: 'Blood', resultType: 'text', textValue: 'Synthetic value', releasedAt: '2026-10-01T10:00:00.000Z', verification: 'released' },
  { title: test });
  const request = (test: string) => record('investigation', { ...completed, test, codeSystem: 'HID-FACILITY',
    code: '7d1c3a52-5f0e-4c1b-9a63-2b8e4f6a9c01', status: 'completed' }, { title: test });
  const diagnosis = (condition: string) => record('diagnosis', { _encounterId: encounterId, codeSystem: 'LOCAL', code: 'X1', condition,
    clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null, abatementAt: null }, { title: condition });
  // Each initialism written with a dot after each letter, in capitals: "R.V.S.", "V.D.R.L.", "C.D.4.".
  const DOTTED = SENSITIVE_TEST_INITIALISMS.map(letters => `${[...letters.toUpperCase()].join('.')}.`);
  const KITS = ['Determine', 'Determine HIV-1/2 Ag/Ab Combo', 'Uni-Gold', 'Unigold', 'Uni Gold Recombigen', 'Stat-Pak', 'StatPak',
    'Stat Pak', 'OraQuick', 'Ora-Quick', 'Ora Quick ADVANCE', 'Rapid test (Determine)'];

  it('makes the dotted form by one rule: any marks, or none, between the letters', () => {
    expect(dottedInitialism('rvs')).toBe('r[^a-z0-9]*v[^a-z0-9]*s');
    expect(dottedInitialism('cd4')).toBe('c[^a-z0-9]*d[^a-z0-9]*4');
    expect(SENSITIVE_TEST_SQL_PATTERN).toContain('|h[^a-z0-9]*i[^a-z0-9]*v[a-z0-9]*|');
    expect(DOTTED).toEqual(expect.arrayContaining(['R.V.S.', 'V.D.R.L.', 'H.C.V.', 'C.D.4.', 'H.I.V.', 'B.R.C.A.']));
  });

  it.each([...DOTTED, 'R. V. S.', 'R.V.S', 'r.v.s.', 'V. D. R. L', 'C.D.4 count', 'C. D. 4', 'Retroviral screening (R.V.S.)', ...KITS])(
    '%j is hidden: by the policy, by the SQL pattern, as a result and as a request', (name) => {
      expect([name, isSensitiveTest(name), sql.test(name)]).toEqual([name, true, true]);
      expect(clean([lab(name), request(name)])).toEqual([]);
    });

  it('still shows a plain "Full blood count", and names near the new words', () => {
    for (const name of ['Full blood count', 'F.B.C.', 'Blood group determination', 'Predetermined panel', 'Gold standard culture',
      'Statin level', 'Oral glucose tolerance test', 'C.D.8 count', 'V.D.', 'Urine M/C/S']) {
      expect([name, isSensitiveTest(name), sql.test(name)]).toEqual([name, false, false]);
    }
    expect(clean([lab('Full blood count'), request('Full blood count')])).toHaveLength(2);
  });

  it.each(['R.V.S.', 'V.D.R.L. reactive', 'H.C.V. infection', 'C.D.4 count low', 'R.V.D.', 'R. V. D.', 'R.V.I.', 'P.M.T.C.T.',
    'P.L.H.I.V.', 'P.T.S.D.', 'A.N.C. booking'])('a diagnosis named %j is hidden', (condition) => {
    expect(clean([diagnosis(condition)])).toEqual([]);
  });

  it('keeps a diagnosis whose name is near the dotted forms', () => {
    expect(clean([diagnosis('Essential hypertension'), diagnosis('R.V. infarct'), diagnosis('Malaria (uncomplicated)')]))
      .toHaveLength(3);
  });

  it('reads a facility item by its name only: a UUID code whose letters look like a test name does not hide it', () => {
    // "cd41..." matched cd4 when the code was read as a name; lab-api, which checks names only, showed the same test.
    const code = '7d1c3a52-cd41-4c1b-9a63-2b8e4f6a9c01';
    expect([isSensitiveTest('Full blood count', code, 'HID-FACILITY'), isSensitiveTest('Full blood count', code, ' hid-facility ')])
      .toEqual([false, false]);
    const shown = (test: string) => record('lab_result', { test, codeSystem: 'HID-FACILITY', code, specimen: 'Blood',
      resultType: 'text', textValue: 'Synthetic value', releasedAt: '2026-10-01T10:00:00.000Z', verification: 'released' },
    { title: test });
    expect(clean([shown('Full blood count')])).toHaveLength(1);
    // Its name still hides it; a code that is not a UUID, or a UUID under another code system, is still read.
    expect([isSensitiveTest('Determine HIV 1/2', code, 'HID-FACILITY'), isSensitiveTest('Full blood count', 'HIV-AB', 'HID-FACILITY'),
      isSensitiveTest('Full blood count', code, 'LOCAL')]).toEqual([true, true, true]);
  });
});

// Ola's decision as clinical owner (#258, 26 Nov 2026): an initialism's letters may be set apart by any marks or none
// (dot, hyphen, space, en dash), then digits may follow; letters too for HIV, CD4, HBV, HCV and HSV. BRCA joins the
// initialisms. GAD counts only with its number. The kit names take any marks between their parts, and "Determine" may
// run on ("DetermineHIV"). lab-api builds the same pattern string (its spec compares the two).
describe('0155: any marks between the letters of an initialism, BRCA, numbered GAD and kit names (S4)', () => {
  const sql = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
  const lab = (test: string) => record('lab_result', { test, codeSystem: 'HID-FACILITY', code: '7d1c3a52-5f0e-4c1b-9a63-2b8e4f6a9c01',
    specimen: 'Blood', resultType: 'text', textValue: 'Synthetic value', releasedAt: '2026-10-01T10:00:00.000Z', verification: 'released' },
  { title: test });
  const request = (test: string) => record('investigation', { ...completed, test, codeSystem: 'HID-FACILITY',
    code: '7d1c3a52-5f0e-4c1b-9a63-2b8e4f6a9c01', status: 'completed' }, { title: test });
  const diagnosis = (condition: string) => record('diagnosis', { _encounterId: encounterId, codeSystem: 'LOCAL', code: 'X1', condition,
    clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null, abatementAt: null }, { title: condition });
  const HIDDEN = ['H-I-V', 'h.i.v', 'H.I.V1', 'HIV1', 'C.D4', 'CD.4', 'C-D-4', 'C D 4', 'cd4 count', 'V-D-R-L', 'V.D.R.L.', 'R.V.S', 'R-V-S',
    'H.C.V', 'H-B-V', 'B.R.C.A.', 'BRCA1', 'G.A.D.-7', 'GAD-7', 'Uni.Gold', 'Uni  Gold', 'Uni\u2013Gold', 'UniGold', 'Stat.Pak', 'Stat-Pak',
    'Ora.Quick', 'OraQuick HIV self-test', 'DetermineHIV', 'Determine HIV 1/2', 'P.H.Q.-9'];
  const SHOWN = ['Full blood count', 'Haemoglobin', 'Malaria parasite', 'Urinalysis', 'Anti-GAD antibody',
    'GAD (glutamic acid decarboxylase) antibody', 'Fasting blood sugar', 'Stat dose', 'Gold standard culture', 'Statin level',
    'Liver function test', 'Electrolytes'];

  it('builds each initialism form by one rule: marks or none between the letters, then digits, or letters for five', () => {
    expect(INITIALISMS_TAKING_LETTERS).toEqual(['hiv', 'cd4', 'hbv', 'hcv', 'hsv']);
    expect(initialismForm('rvs')).toBe('r[^a-z0-9]*v[^a-z0-9]*s[0-9]*');
    expect(initialismForm('hiv')).toBe('h[^a-z0-9]*i[^a-z0-9]*v[a-z0-9]*');
    expect(SENSITIVE_TEST_INITIALISMS).toContain('brca');
    expect(SENSITIVE_TEST_INITIALISMS).not.toContain('gad');
    for (const letters of SENSITIVE_TEST_INITIALISMS) expect(SENSITIVE_TEST_SQL_PATTERN).toContain(`|${initialismForm(letters)}`);
    for (const fragment of ['g[^a-z0-9]*a[^a-z0-9]*d[^a-z0-9]*[0-9]+', 'determine[a-z0-9]*', 'uni[^a-z0-9]*gold', 'stat[^a-z0-9]*pak',
      'ora[^a-z0-9]*quick']) expect(SENSITIVE_TEST_SQL_PATTERN).toContain(`|${fragment}|`);
    expect(SENSITIVE_TEST_SQL_PATTERN).not.toContain("'");
  });

  it.each(HIDDEN)('%j is hidden: by the policy, by the SQL pattern, as a result and as a request', (name) => {
    expect([name, isSensitiveTest(name), sql.test(name)]).toEqual([name, true, true]);
    expect(clean([lab(name), request(name)])).toEqual([]);
  });

  it.each(SHOWN)('%j is still shown, as a result and as a request', (name) => {
    expect([name, isSensitiveTest(name), sql.test(name)]).toEqual([name, false, false]);
    expect(clean([lab(name), request(name)])).toHaveLength(2);
  });

  it.each(['R.V.D.', 'R-V-D', 'P.M.T.C.T.', 'P-T-S-D', 'O.C.D.'])('a diagnosis named %j is hidden', (condition) => {
    expect(clean([diagnosis(condition)])).toEqual([]);
  });

  it('keeps a diagnosis named "Anaemia"', () => {
    expect(clean([diagnosis('Anaemia')])).toHaveLength(1);
  });
});
