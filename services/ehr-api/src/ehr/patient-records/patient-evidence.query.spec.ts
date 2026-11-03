import { createHash } from 'node:crypto';
import { PATIENT_EVIDENCE_QUERY, STAFF_EVIDENCE_QUERY, evidenceQuery } from './patient-evidence.query';
import { attachmentTextQuery } from './patient-attachment-text.service';
import { SENSITIVE_TEST_SQL_PATTERN } from './patient-evidence.policy';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// The staff chat's two queries as they were at 34d69557 (staff-evidence.service.ts:15-18, :26-29).
const STAFF_EVIDENCE_SHA256 = 'fd73cd5d42d12fb4f1faa20cc4f22851aed5eda132c87d614cfb1a02c48b250f';
const STAFF_DOCUMENTS_SHA256 = 'fc695715139604a243b48813cac51bc7f33d91b1b03d0a029c659ebd8c743dab';
const branch = (query: string, kind: string) => query.split('union all').find(b => b.includes(`'${kind}',`) || b.includes(`'${kind}' kind`))!;

describe('Staff chat queries stay exactly as they were (golden)', () => {
  it('keeps the staff evidence query, plus patient_id in the final select', () => {
    expect(STAFF_EVIDENCE_QUERY).toBe(evidenceQuery('staff'));
    const withoutPatientId = STAFF_EVIDENCE_QUERY.replace(',origin_hint,patient_id from sources', ',origin_hint from sources');
    expect(withoutPatientId).not.toBe(STAFF_EVIDENCE_QUERY);
    expect(sha(withoutPatientId)).toBe(STAFF_EVIDENCE_SHA256);
  });

  it('keeps the staff document query byte for byte', () => {
    expect(sha(attachmentTextQuery('staff'))).toBe(STAFF_DOCUMENTS_SHA256);
    expect(attachmentTextQuery('staff')).not.toContain('classification');
  });

  it('keeps everything staff needs: refuted diagnoses with notes, request reasons, instructions and cancelled items', () => {
    expect(STAFF_EVIDENCE_QUERY).toContain("'notes',d.notes");
    expect(STAFF_EVIDENCE_QUERY).toContain("'information',l.clinical_information");
    expect(STAFF_EVIDENCE_QUERY).toContain("'instructions',p.instructions");
    expect(STAFF_EVIDENCE_QUERY).toContain("from ehr.prescriptions p where p.status not in ('draft','entered_in_error')");
    expect(STAFF_EVIDENCE_QUERY).not.toContain(SENSITIVE_TEST_SQL_PATTERN);
    expect(STAFF_EVIDENCE_QUERY).not.toContain('_encounterStatus');
  });

  it('uses the same sensitive test list as lab-api (patient-results.query.spec.ts pins the same hash)', () => {
    expect(sha(SENSITIVE_TEST_SQL_PATTERN)).toBe('e843599f33c5dc156e662348acdc517d3f5138ea7f99f07b28f5c414ddccbad7');
  });

  it('refuses an unknown audience', () => {
    expect(() => evidenceQuery('other' as never)).toThrow('Unknown evidence audience');
    expect(() => attachmentTextQuery('other' as never)).toThrow('Unknown evidence audience');
  });
});

describe('The patient evidence query', () => {
  const completed = (alias: string) =>
    `join ehr.encounters e on e.id=${alias}.encounter_id and e.patient_id=${alias}.patient_id and e.facility_id=${alias}.facility_id and e.status='completed'`;

  it('reads notes, prescriptions and requests only from a completed visit (A4)', () => {
    expect(branch(PATIENT_EVIDENCE_QUERY, 'note')).toContain(completed('n'));
    expect(branch(PATIENT_EVIDENCE_QUERY, 'prescription')).toContain(completed('p'));
    expect(branch(PATIENT_EVIDENCE_QUERY, 'investigation')).toContain(completed('l'));
    for (const kind of ['note', 'prescription', 'investigation']) {
      expect(branch(PATIENT_EVIDENCE_QUERY, kind)).toContain("'_encounterStatus',e.status");
    }
  });

  it('reads confirmed diagnoses without notes (A1)', () => {
    const d = branch(PATIENT_EVIDENCE_QUERY, 'diagnosis');
    expect(d).toContain("where d.verification_status='confirmed'");
    expect(d).not.toContain('d.notes');
  });

  it('reads current prescriptions without instructions (A3), and current non-sensitive requests without reason or priority (A2)', () => {
    const p = branch(PATIENT_EVIDENCE_QUERY, 'prescription');
    expect(p).toContain("where p.status in ('active','on_hold','completed')");
    expect(p).not.toContain('instructions');
    const l = branch(PATIENT_EVIDENCE_QUERY, 'investigation');
    expect(l).toContain("where l.status in ('active','on_hold','completed')");
    expect(l).toContain(`coalesce(l.test_display,'') !~* '${SENSITIVE_TEST_SQL_PATTERN}'`);
    expect(l).not.toMatch(/clinical_information|priority/);
  });

  it('reads vitals as an explicit list of measures (A9)', () => {
    const v = branch(PATIENT_EVIDENCE_QUERY, 'vital');
    expect(v).not.toContain('to_jsonb(v)');
    expect(v).toContain("jsonb_build_object('recorded_at',v.recorded_at,'height_cm',v.height_cm");
    expect(v).toContain("'source',v.source)||coalesce(c.replacement_values,'{}'::jsonb)");
  });

  it('keeps the OCR origin clause and selects the patient id of every row', () => {
    expect(PATIENT_EVIDENCE_QUERY).toContain("r.revision_no=1 and r.change_reason='OCR import from human-validated source evidence'");
    expect(PATIENT_EVIDENCE_QUERY).toContain('origin_hint,patient_id from sources');
    expect(PATIENT_EVIDENCE_QUERY).toContain('where patient_id=$1 and (kind,id::text)>($2::text,$3::text)');
    expect(PATIENT_EVIDENCE_QUERY).not.toContain('$4');
  });

  it('reads only documents classified phi, from the patient\'s own extraction tables (A5)', () => {
    const q = attachmentTextQuery('patient');
    expect(q).toContain("where d.patient_id=$1 and d.status='available' and d.classification='phi'");
    expect(q).toContain('ehr.patient_document_extractions');
    expect(q).not.toContain('ehr.staff_');
  });
});
