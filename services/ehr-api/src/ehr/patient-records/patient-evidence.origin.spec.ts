import { PATIENT_EVIDENCE_QUERY, STAFF_EVIDENCE_QUERY } from './patient-evidence.query';
import { ORIGINS, SOURCE_KINDS, evidence, evidenceOrigin, originLabel, type EvidenceOrigin, type SourceKind } from './patient-evidence.types';

// Owner decision 25: the chat says where each fact came from. The origin is
// worked out here, from the record itself, never by the model.
const EXPECTED: Record<SourceKind, EvidenceOrigin> = {
  note: 'health_worker', encounter: 'health_worker', diagnosis: 'health_worker', prescription: 'health_worker',
  investigation: 'health_worker', vital: 'health_worker', lab_result: 'health_worker',
  import: 'patient', import_version: 'patient', health_profile: 'patient',
  attachment: 'scanned_paper', document: 'scanned_paper', profile: 'health_id_profile',
};
const source = (kind: SourceKind, originHint?: string | null) => evidence({ kind, id: '22222222-2222-4222-8222-222222222222',
  version: '1', title: `Synthetic ${kind}`, recordedAt: '2026-10-01T00:00:00.000Z', effectiveAt: null,
  provenance: 'Synthetic provenance', quality: 'recorded', fields: { text: 'Synthetic content' }, originHint });

describe('Where a chat source came from', () => {
  it('gives every source kind an origin, without a hint', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...SOURCE_KINDS].sort());
    for (const kind of SOURCE_KINDS) {
      expect(evidenceOrigin(kind)).toBe(EXPECTED[kind]);
      expect(source(kind).origin).toBe(EXPECTED[kind]);
    }
  });

  it('reads a scanned paper note and a provider-authored import from the row, and never upgrades anything else', () => {
    expect(evidenceOrigin('note', 'scanned_paper')).toBe('scanned_paper');
    expect(evidenceOrigin('note', 'patient-provided')).toBe('health_worker');
    for (const kind of ['import', 'import_version'] as const) {
      expect(evidenceOrigin(kind, 'provider-authored')).toBe('health_worker');
      expect(evidenceOrigin(kind, 'patient-provided')).toBe('patient');
      // An unknown or missing origin is never presented as a health worker's.
      expect(evidenceOrigin(kind, 'something-else')).toBe('patient');
      expect(evidenceOrigin(kind, null)).toBe('patient');
    }
    // A hint cannot turn a patient's or a scanned record into a health worker's.
    expect(evidenceOrigin('health_profile', 'provider-authored')).toBe('patient');
    expect(evidenceOrigin('document', 'provider-authored')).toBe('scanned_paper');
    expect(evidenceOrigin('attachment', 'provider-authored')).toBe('scanned_paper');
    expect(evidenceOrigin('prescription', 'scanned_paper')).toBe('health_worker');
  });

  it('labels each origin in plain words for the patient and for staff', () => {
    expect(ORIGINS.map((origin) => originLabel(origin))).toEqual(['You added this', 'Recorded by a health worker',
      'From a scanned paper record', 'Your Health ID profile']);
    expect(ORIGINS.map((origin) => originLabel(origin, 'patient'))).toEqual(ORIGINS.map((origin) => originLabel(origin)));
    expect(ORIGINS.map((origin) => originLabel(origin, 'staff'))).toEqual(['Added by the patient', 'Recorded by a health worker',
      'From a scanned paper record', "The patient's Health ID profile"]);
    for (const audience of ['patient', 'staff'] as const) {
      for (const origin of ORIGINS) expect(originLabel(origin, audience)).not.toMatch(/_|\behr\b|\bocr\b|null|undefined/i);
    }
  });

  it('keeps the origin out of the source content and hash, so saved bindings and vectors stay current', () => {
    const plain = source('note');
    const scanned = source('note', 'scanned_paper');
    expect(scanned.origin).toBe('scanned_paper');
    expect(scanned.hash).toBe(plain.hash);
    expect(scanned.content).toBe(plain.content);
    expect(scanned.content).not.toMatch(/scanned_paper|origin/);
    expect(scanned).not.toHaveProperty('originHint');
    expect(scanned.fields).toEqual({ text: 'Synthetic content' });
  });
});

describe.each([['patient', PATIENT_EVIDENCE_QUERY], ['staff', STAFF_EVIDENCE_QUERY]])('The %s evidence query reads each row\'s origin', (_audience, query) => {
  const branches = query.split('union all');

  it('adds origin_hint to every branch and to the answer, leaving the hashed columns as they were', () => {
    expect(branches).toHaveLength(9);
    expect(query).toContain('select kind,id,version,title,recorded_at,effective_at,provenance,quality,fields,origin_hint,patient_id from sources');
    expect(branches[0]).toContain("then 'scanned_paper' end origin_hint");
    // Imports carry their recorded origin (CHECK in 0061); no other branch claims one.
    expect(branches.find((b) => b.includes("'import',r.id"))).toMatch(/\),r\.origin\n from ehr\.imported_medical_records r/);
    expect(branches.find((b) => b.includes("'import_version',v.id"))).toMatch(/\),v\.origin\n from ehr\.imported_medical_record_versions v/);
    for (const b of branches.slice(1).filter((b) => !b.includes("'import'") && !b.includes("'import_version'"))) {
      expect(b).toMatch(/,null\s+from /);
    }
  });

  it('knows a scanned paper note by its OCR provenance row, or by the first revision only the OCR import writes', () => {
    expect(branches[0]).toContain("exists(select 1 from ehr.ocr_import_provenance o where o.clinical_resource_type='clinical_note' and o.clinical_resource_id=n.id");
    expect(branches[0]).toContain("r.revision_no=1 and r.change_reason='OCR import from human-validated source evidence'");
  });

});

describe('The staff evidence query keeps its own filters', () => {
  it('gives staff chat the same origin, with its own filters still applied', () => {
    expect(STAFF_EVIDENCE_QUERY).toContain('origin_hint,patient_id from sources');
    expect(STAFF_EVIDENCE_QUERY).toContain('where patient_id=$1 and kind=any($4::text[]) and (kind');
    expect(STAFF_EVIDENCE_QUERY).toContain("e.id=d.encounter_id and e.patient_id=d.patient_id and e.facility_id=d.facility_id and e.status='completed'");
    expect(STAFF_EVIDENCE_QUERY).toContain('from ehr.vitals v join ehr.encounters e');
  });
});
