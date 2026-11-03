import { createHash } from 'node:crypto';
import { PATIENT_SELF_LAB_QUERY, SENSITIVE_TEST_SQL_PATTERN, STAFF_LAB_QUERY } from './patient-results.service';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// The text of PATIENT_LAB_QUERY at 34d69557, which the staff chat keeps unchanged.
const STAFF_LAB_QUERY_SHA256 = 'b58a3981dd83affda7f7a685bc86fba05adb0a3374ff9f85cc2835c6be2b2039';

describe('Lab result queries for the patient and the staff chat (A6)', () => {
  it('keeps the staff query exactly as it was, with the correction reason', () => {
    expect(sha(STAFF_LAB_QUERY)).toBe(STAFF_LAB_QUERY_SHA256);
    expect(STAFF_LAB_QUERY).toContain("'correctionReason',v.correction_reason");
    expect(STAFF_LAB_QUERY).not.toContain(SENSITIVE_TEST_SQL_PATTERN);
  });

  it('uses the same sensitive test list as ehr-api (patient-evidence.query.spec.ts pins the same hash)', () => {
    expect(sha(SENSITIVE_TEST_SQL_PATTERN)).toBe('e843599f33c5dc156e662348acdc517d3f5138ea7f99f07b28f5c414ddccbad7');
  });

  it('never gives the patient the correction reason', () => {
    expect(PATIENT_SELF_LAB_QUERY).not.toMatch(/correction_reason|correctionReason/);
  });

  it('finds the latest release and shows values only when it is for the current version', () => {
    expect(PATIENT_SELF_LAB_QUERY).toContain('order by x.result_version desc limit 1) rel on true');
    const [normal, placeholder] = PATIENT_SELF_LAB_QUERY.split(' else jsonb_build_object(');
    expect(normal).toContain("case when rel.result_version=r.current_version then jsonb_build_object('test'");
    expect(normal).toContain("'numericValue',v.numeric_value::text");
    // The placeholder carries the test, never a value, flag, range or release.
    const fields = placeholder!.slice(0, placeholder!.indexOf(' end fields'));
    expect(fields).toContain("'correctionPending',true,'status','The lab is correcting this result.'");
    for (const forbidden of ['numericValue', 'textValue', 'numeric_value', 'text_value', 'unit', 'referenceRange', 'recordedFlag', 'releasedAt', 'revisionKind']) {
      expect(fields).not.toContain(forbidden);
    }
    expect(PATIENT_SELF_LAB_QUERY).toContain("r.current_version::text||':pending:'||rel.id::text");
  });

  it('leaves out a result whose current or last released version was entered in error', () => {
    expect(PATIENT_SELF_LAB_QUERY).toContain('i.result_version=r.current_version and i.patient_id=r.patient_id');
    expect(PATIENT_SELF_LAB_QUERY).toContain('i.result_version=rel.result_version and i.patient_id=r.patient_id');
    expect(PATIENT_SELF_LAB_QUERY).toContain('ver.result_version=rel.result_version');
  });

  it('leaves out sensitive tests by name, and keeps ordinary ones', () => {
    expect(PATIENT_SELF_LAB_QUERY).toContain(`coalesce(t.name,'') !~* '${SENSITIVE_TEST_SQL_PATTERN}'`);
    expect(SENSITIVE_TEST_SQL_PATTERN).not.toContain("'");
    // The ARE pattern is also valid JavaScript with the same meaning for these names.
    const re = new RegExp(SENSITIVE_TEST_SQL_PATTERN, 'i');
    for (const name of ['HIV 1/2 rapid test', 'RVS', 'Retroviral screening', 'HBsAg', 'Anti-HCV', 'VDRL', 'Beta hCG',
      'Urine pregnancy test', 'UPT', 'PSA', 'CA 125', 'CA 19-9', 'Pap smear', 'Haemoglobin genotype', 'CD4 count', 'Viral load', 'PHQ-9',
      'VL', 'HIV VL', 'Hb electrophoresis', 'Haemoglobin electrophoresis', 'Hemoglobin electrophoresis']) {
      expect(re.test(name)).toBe(true);
    }
    for (const name of ['Full blood count', 'Malaria parasite (MRDT)', 'Haemoglobin', 'Fasting blood sugar', 'Urinalysis',
      'Widal', 'Lipid profile', 'Thyroid uptake', 'Electrolytes, urea and creatinine', 'Packed cell volume']) {
      expect(re.test(name)).toBe(false);
    }
  });
});
