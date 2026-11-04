import { SENSITIVE_TEST_SQL_PATTERN, isSensitiveTest, patientEvidence, type PatientProfileInput } from './patient-evidence.policy';
import { evidence, type Evidence, type SourceKind } from './patient-evidence.types';

// Owner decision Q31: TB results stay visible in the patient chat and OFF the sensitive list. Fictional records only.
const profile: PatientProfileInput = { firstName: 'Tunde', lastName: 'Bello', fullName: 'Tunde Bello', dateOfBirth: '1988-03-12', gender: 'male' };
const today = new Date('2026-11-04T09:00:00.000Z');
const encounterId = '60000000-0000-4000-8000-000000000031';
const completed = { _encounterId: encounterId, _encounterStatus: 'completed' };
let n = 0;
const record = (kind: SourceKind, fields: Record<string, unknown>, title: string) => {
  n += 1;
  return evidence({ kind, id: `31313131-3131-4131-8131-${String(n).padStart(12, '0')}`, version: '1', title,
    recordedAt: '2026-10-01T10:00:00.000Z', effectiveAt: null, provenance: 'Synthetic provenance', quality: 'recorded', fields });
};
const kept = (input: Evidence) => patientEvidence([input], profile, today).length === 1;
const sql = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');

const TB_TESTS = ['GeneXpert MTB/RIF', 'GeneXpert', 'Xpert MTB/RIF Ultra', 'MTB/RIF', 'Sputum GeneXpert', 'AFB smear', 'Sputum AFB',
  'Sputum for AFB x3', 'Acid-fast bacilli smear', 'Ziehl-Neelsen stain', 'ZN stain', 'Mantoux test', 'Mantoux', 'TST',
  'Tuberculin skin test', 'IGRA', 'Interferon gamma release assay', 'QuantiFERON-TB Gold Plus', 'QuantiFERON', 'T-SPOT.TB',
  'Sputum culture for TB', 'TB culture', 'Mycobacterial culture', 'Sputum culture (MTB)', 'TB LAM', 'Urine LF-LAM', 'Line probe assay (TB)'];
const TB_DIAGNOSES: [string, string][] = [['A15.0', 'Tuberculosis of lung'], ['A15', 'Pulmonary tuberculosis, bacteriologically confirmed'],
  ['A16.2', 'Pulmonary tuberculosis without mention of bacteriological confirmation'], ['A17.0', 'Tuberculous meningitis'],
  ['A18.2', 'Tuberculous peripheral lymphadenopathy'], ['A18.0', 'Tuberculosis of spine (Pott disease)'], ['A19.9', 'Miliary tuberculosis'],
  ['A19', 'Disseminated TB'], ['A15.9', 'Respiratory TB']];
const TB_MEDICINES: [string, string][] = [['Rifampicin 150 mg', 'J04AB02'], ['Rifampin', 'J04AB02'], ['Isoniazid 300 mg', 'J04AC01'],
  ['INH', 'J04AC01'], ['Ethambutol 400 mg', 'J04AK02'], ['Pyrazinamide 400 mg', 'J04AK01'],
  ['Rifampicin/Isoniazid/Pyrazinamide/Ethambutol (RHZE) FDC', 'J04AM06'], ['RHZE', 'J04AM06'], ['RH 150/75', 'J04AM02']];

describe('Owner Q31: TB stays visible in the patient chat, off the sensitive list', () => {
  it('keeps TB results visible (owner Q31): GeneXpert MTB/RIF, AFB smear, Mantoux/TST, IGRA/QuantiFERON, TB culture', () => {
    for (const test of TB_TESTS) {
      const lab = record('lab_result', { test, codeSystem: 'LOCAL', code: 'TB1', specimen: 'Sputum', resultType: 'text',
        textValue: 'Synthetic value', recordedFlag: 'abnormal', releasedAt: '2026-10-01T10:00:00.000Z', verification: 'released' }, test);
      const request = record('investigation', { ...completed, test, codeSystem: 'LOCAL', code: 'TB1', status: 'completed' }, test);
      // Not on the list in either form (the services' JS test and the SQL pattern the patient queries use);
      // shown without a "Discussed with the patient" mark, and its request is shown too.
      expect([test, isSensitiveTest(test), isSensitiveTest(test, 'TB1', 'LOCAL'), sql.test(test), kept(lab), kept(request)])
        .toEqual([test, false, false, false, true, true]);
    }
  });

  it('keeps TB results visible (owner Q31): a TB diagnosis (ICD-10 A15-A19) by code and by display text', () => {
    for (const [code, condition] of TB_DIAGNOSES) {
      const diagnosis = record('diagnosis', { _encounterId: encounterId, codeSystem: 'ICD-10', code, condition, clinicalStatus: 'active',
        verificationStatus: 'confirmed', onsetAt: null, abatementAt: null }, condition);
      expect([code, condition, kept(diagnosis)]).toEqual([code, condition, true]);
    }
  });

  it('keeps TB results visible (owner Q31): anti-TB medicines (rifampicin, isoniazid, ethambutol, pyrazinamide), by name and ATC J04', () => {
    for (const [medication, atc] of TB_MEDICINES) {
      for (const more of [{}, { _medicationCodeSystem: 'ATC', _medicationCode: atc }]) {
        const prescription = record('prescription', { ...completed, medication, doseQuantity: 1, doseUnit: 'tablet(s)', route: 'Oral',
          frequency: 'Once a day', startsOn: '2026-10-01', endsOn: null, status: 'active', ...more }, medication);
        expect([medication, more, kept(prescription)]).toEqual([medication, more, true]);
      }
    }
  });

  it('still holds a critical TB result until discussed (D-B is about critical, not about TB)', () => {
    const lab = (more: Record<string, unknown>) => record('lab_result', { test: 'GeneXpert MTB/RIF', codeSystem: 'LOCAL', code: 'TB1',
      specimen: 'Sputum', resultType: 'text', textValue: 'Synthetic value', recordedFlag: 'critical_candidate',
      releasedAt: '2026-10-01T10:00:00.000Z', verification: 'released', ...more }, 'GeneXpert MTB/RIF');
    expect(kept(lab({}))).toBe(false);
    expect(kept(lab({ _discussed: true }))).toBe(true);
  });
});
