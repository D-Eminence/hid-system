import { paperReadingPayloadSchema } from './contract';

const box = { left: 0.1, top: 0.1, width: 0.5, height: 0.02 };
const valid = {
  contract: 'hid-paper-reading-v2',
  pages: [{ page: 1, flagged: false, flagReasons: [], lines: [
    { id: 'p1-l1', text: 'Dx: Hypertension', box, confidence: 0.99, handwritten: false }] }],
  identity: { nameAsWritten: null, dateOfBirthAsWritten: null, folderNumberAsWritten: null, sexAsWritten: null,
    lineIds: [], box: null },
  items: [{ id: 'it-0123456789abcdef', kind: 'diagnosis', asWritten: 'Hypertension', plain: 'High blood pressure',
    dateAsWritten: null, page: 1, lineIds: ['p1-l1'], box, confidence: 'clear', checkReasons: [], checkReason: null,
    fields: { name: 'Hypertension', status: 'confirmed' }, prescription: null, readBy: 'first_pass' }],
  reading: { status: 'read', firstPassModel: 'claude-sonnet-5-5', rereadModel: null, rereadPages: [],
    droppedUngrounded: 0, itemCount: 1, promptVersion: 'p', schemaVersion: 's' },
};

describe('paper reading contract schema', () => {
  it('accepts the agreed shape', () => {
    expect(paperReadingPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts suffixed unique item ids and an allergy severity', () => {
    const allergy = { ...valid.items[0], id: 'it-0123456789abcdef-2', kind: 'allergy', asWritten: 'Hypertension',
      fields: { substance: 'Penicillin', reaction: null, severity: 'severe', noKnownAllergies: false } };
    for (const id of ['it-0123456789abcdef-2', 'it-0123456789abcdef-9', 'it-0123456789abcdef-10',
      'it-0123456789abcdef-123']) {
      expect(paperReadingPayloadSchema.safeParse({ ...valid, items: [valid.items[0], { ...allergy, id }],
        reading: { ...valid.reading, itemCount: 2 } }).success).toBe(true);
    }
    for (const severity of ['mild', 'moderate', 'unknown', null]) {
      expect(paperReadingPayloadSchema.safeParse({ ...valid, items: [{ ...allergy,
        fields: { ...allergy.fields, severity } }] }).success).toBe(true);
    }
  });

  it.each<[string, unknown]>([
    ['a repeated item id', { ...valid, items: [valid.items[0], valid.items[0]],
      reading: { ...valid.reading, itemCount: 2 } }],
    ...['it-0123456789abcdef-1', 'it-0123456789abcdef-0', 'it-0123456789abcdef-02', 'it-0123456789ABCDEF',
      'it-0123456789abcdef-', 'it-0123456789abcde'].map((id) => [`the item id ${id}`,
      { ...valid, items: [{ ...valid.items[0], id }] }] as [string, unknown]),
    ['an allergy without severity', { ...valid, items: [{ ...valid.items[0], kind: 'allergy',
      fields: { substance: 'Penicillin', reaction: null, noKnownAllergies: false } }] }],
    ['an unknown allergy severity', { ...valid, items: [{ ...valid.items[0], kind: 'allergy',
      fields: { substance: 'Penicillin', reaction: null, severity: 'life-threatening', noKnownAllergies: false } }] }],
    ['an unknown top-level key', { ...valid, rawModelOutput: '{}' }],
    ['an item citing a line on another page', { ...valid, items: [{ ...valid.items[0], lineIds: ['p2-l1'] }] }],
    ['fields that do not fit the kind', { ...valid, items: [{ ...valid.items[0], fields: { name: 'x', status: 'current' } }] }],
    ['a clear item with reasons', { ...valid, items: [{ ...valid.items[0], checkReasons: ['handwritten'] }] }],
    ['a wrong item count', { ...valid, reading: { ...valid.reading, itemCount: 2 } }],
    ['items on a document that was not read', { ...valid, reading: { ...valid.reading, status: 'ai_off' } }],
    ['a flagged page without reasons', { ...valid, pages: [{ ...valid.pages[0], flagged: true }] }],
    ['a prescription on a diagnosis', { ...valid, items: [{ ...valid.items[0],
      prescription: { prescriberAsWritten: null, dateAsWritten: null } }] }],
    ['a box outside the page', { ...valid, items: [{ ...valid.items[0], box: { ...box, left: 1.2 } }] }],
  ])('rejects %s', (_name, payload) => {
    expect(paperReadingPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
