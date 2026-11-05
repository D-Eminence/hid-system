/**
 * Fictional extraction fixtures for the OCR API tests. Every name, number and record here is invented
 * ("Test Patient Adaeze Example", folder TEST-0001); none comes from a real patient. Used only by *.spec.ts.
 */
import { PROMPT_VERSION } from './reading-versions';

const box = { left: 0.1, top: 0.1, width: 0.5, height: 0.02 };
const line = (id: string, text: string, handwritten = false, confidence = 0.99) =>
  ({ id, text, box: { ...box }, confidence, handwritten });

export function v2Payload() {
  return {
    contract: 'hid-paper-reading-v2',
    pages: [
      { page: 1, flagged: false, flagReasons: [], lines: [
        line('p1-l1', 'Name: Test Patient Adaeze Example  Folder: TEST-0001'),
        line('p1-l2', 'Dx: Hypertension'),
        line('p1-l3', 'Amlodipine 5mg od'),
      ] },
      { page: 2, flagged: true, flagReasons: ['handwriting'], lines: [
        line('p2-l1', 'BP 130/85', true, 0.72),
      ] },
    ],
    identity: { nameAsWritten: 'Test Patient Adaeze Example', dateOfBirthAsWritten: null,
      folderNumberAsWritten: 'TEST-0001', sexAsWritten: null, lineIds: ['p1-l1'], box: { ...box } },
    items: [
      { id: 'it-0123456789abcdef', kind: 'diagnosis', asWritten: 'Hypertension', plain: 'High blood pressure',
        dateAsWritten: null, page: 1, lineIds: ['p1-l2'], box: { ...box }, confidence: 'clear', checkReasons: [],
        checkReason: null, fields: { name: 'Hypertension', status: 'confirmed' }, prescription: null,
        readBy: 'first_pass' },
      { id: 'it-fedcba9876543210', kind: 'medicine', asWritten: 'Amlodipine 5mg od', plain: 'Amlodipine 5 mg once a day',
        dateAsWritten: null, page: 1, lineIds: ['p1-l3'], box: { ...box }, confidence: 'check_carefully',
        checkReasons: ['frequency_not_as_written'], checkReason: 'Check how often against the paper.',
        fields: { name: 'Amlodipine', strength: '5mg', form: null, route: null, frequency: 'od', duration: null,
          status: 'current' },
        prescription: { prescriberAsWritten: 'Dr Test Prescriber', dateAsWritten: null }, readBy: 'reread' },
      { id: 'it-00112233445566aa', kind: 'vital', asWritten: 'BP 130/85', plain: 'Blood pressure 130/85',
        dateAsWritten: null, page: 2, lineIds: ['p2-l1'], box: { ...box }, confidence: 'check_carefully',
        checkReasons: ['handwritten'], checkReason: 'Handwritten; check it against the paper.',
        fields: { measure: 'blood_pressure', value: '130/85', unit: null }, prescription: null, readBy: 'first_pass' },
    ],
    reading: { status: 'read', firstPassModel: 'claude-sonnet-5-5', rereadModel: 'claude-opus-5-5', rereadPages: [1],
      droppedUngrounded: 1, itemCount: 3, promptVersion: PROMPT_VERSION,
      schemaVersion: 'hid-paper-reading-schema-2+hid-paper-reading-model-schema-2' },
  };
}

export function v2Provenance() {
  return { processingContract: 'hid-textract-v2', adapter: 'amazon-textract', operation: 'analyze',
    textractFeatures: ['LAYOUT'], features: ['layout'], sourceVersionBound: true, pageCount: 2, lineCount: 4,
    reading: { contract: 'hid-paper-reading-v2', status: 'read', firstPassModel: 'claude-sonnet-5-5',
      rereadModel: 'claude-opus-5-5', promptVersion: PROMPT_VERSION, schemaVersion: 's', inferenceGeo: 'us',
      servedInferenceGeo: 'us', requests: 3, refusals: 0, pagesSent: 2, rereadPages: [1], rereadFailedPages: [],
      droppedUngrounded: 1, droppedUngroundedFirstPass: 1, itemCount: 3, flaggedPages: 1, maskedNumbers: 0,
      failureCode: null, usage: { inputTokens: 1200, outputTokens: 300 } } };
}

export function extractionRow(structuredPayload: unknown, provenance: unknown = v2Provenance()) {
  return { id: '80000000-0000-4000-8000-000000000001', version: 1, attempt: 1, provider: 'textract',
    providerModel: 'amazon-textract-analyze-document', rawText: 'Name: Test Patient Adaeze Example',
    structuredPayload, confidence: '0.93000', provenance, createdAt: new Date('2026-11-04T10:00:00Z') };
}
