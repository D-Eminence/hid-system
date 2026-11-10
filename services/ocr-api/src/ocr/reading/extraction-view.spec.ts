import { parseStructuredPayload, projectExtraction, publicProvenance, readingView } from './extraction-view';
import { extractionRow, v2Payload, v2Provenance } from './test-fixtures';

describe('extraction view for the check screen', () => {
  it('reads a v2 payload: page text from joined lines, lines, flags, identity, items and reading', () => {
    const view = projectExtraction(extractionRow(v2Payload()));

    expect(view.paperReading.contract).toBe('hid-paper-reading-v2');
    expect(view.paperReading.pages.map((page) => page.text)).toEqual([
      'Name: Test Patient Adaeze Example  Folder: TEST-0001\nDx: Hypertension\nAmlodipine 5mg od',
      'BP 130/85',
    ]);
    expect(view.paperReading.pages[1]).toMatchObject({ page: 2, flagged: true, flagReasons: ['handwriting'] });
    expect(view.paperReading.pages[0]!.lines[0]).toEqual({ id: 'p1-l1',
      text: 'Name: Test Patient Adaeze Example  Folder: TEST-0001',
      box: { left: 0.1, top: 0.1, width: 0.5, height: 0.02 }, confidence: 0.99, handwritten: false });
    expect(view.paperReading.identity).toMatchObject({ nameAsWritten: 'Test Patient Adaeze Example',
      folderNumberAsWritten: 'TEST-0001', lineIds: ['p1-l1'] });
    expect(view.paperReading.reading).toMatchObject({ status: 'read', itemCount: 3 });
    expect(view.paperReading.items).toEqual(v2Payload().items);
    expect(view.structuredPayload).toEqual(v2Payload());
    expect(view.confidence).toBe(0.93);
  });

  it('reads a v2 payload with or without the image re-read fields, and rejects an unknown skip reason', () => {
    const withImage = { ...v2Payload(), reading: { ...v2Payload().reading, imageRereadPages: [1],
      imageRereadSkipped: [{ page: 2, reason: 'image_not_available_pdf' }] } };
    expect(parseStructuredPayload(withImage).contract).toBe('hid-paper-reading-v2');
    expect(readingView(parseStructuredPayload(withImage)).reading).toMatchObject({ imageRereadPages: [1],
      imageRereadSkipped: [{ page: 2, reason: 'image_not_available_pdf' }] });
    expect(parseStructuredPayload(v2Payload()).contract).toBe('hid-paper-reading-v2');
    expect(parseStructuredPayload({ ...withImage, reading: { ...withImage.reading,
      imageRereadSkipped: [{ page: 2, reason: 'guessed' }] } }).contract).toBeNull();
  });

  it('reads the masked-number and orientation skip reasons and the failed image re-read pages, which stay optional', () => {
    const later = { ...v2Payload(), reading: { ...v2Payload().reading, imageRereadPages: [], imageRereadFailedPages: [1],
      imageRereadSkipped: [{ page: 1, reason: 'image_has_masked_number' },
        { page: 2, reason: 'image_orientation_unsupported' }, { page: 3, reason: 'image_tier_unknown' },
        { page: 4, reason: 'image_refused' }] } };
    expect(readingView(parseStructuredPayload(later)).reading).toMatchObject({ imageRereadFailedPages: [1],
      imageRereadSkipped: later.reading.imageRereadSkipped });
    expect(parseStructuredPayload({ ...later, reading: { ...later.reading, imageRereadFailedPages: [0] } }).contract)
      .toBeNull();
  });

  it('gives every item exactly the contract fields the check screen uses', () => {
    const [, medicine] = projectExtraction(extractionRow(v2Payload())).paperReading.items;
    expect(Object.keys(medicine!).sort()).toEqual(['asWritten', 'box', 'checkReason', 'checkReasons', 'confidence',
      'dateAsWritten', 'fields', 'id', 'kind', 'lineIds', 'page', 'plain', 'prescription', 'readBy']);
    expect(medicine).toMatchObject({ kind: 'medicine', confidence: 'check_carefully', readBy: 'reread',
      prescription: { prescriberAsWritten: 'Dr Test Prescriber', dateAsWritten: null } });
  });

  it('keeps old v1 extractions readable as page text only', () => {
    const legacy = { pages: [{ page: 1, text: 'Dx: Hypertension\nAmlodipine 5mg od', confidence: 0.91 },
      { page: 2, text: 'BP 130/85', confidence: 0.8, extra: 'ignored' }] };
    const view = projectExtraction(extractionRow(legacy,
      { processingContract: 'hid-textract-v1', adapter: 'amazon-textract', sourceVersionBound: true }));

    expect(view.paperReading).toEqual({ contract: 'hid-textract-v1', identity: null, items: [], reading: null,
      pages: [
        { page: 1, text: 'Dx: Hypertension\nAmlodipine 5mg od', flagged: false, flagReasons: [], lines: [] },
        { page: 2, text: 'BP 130/85', flagged: false, flagReasons: [], lines: [] },
      ] });
    expect(view.structuredPayload).toEqual({ pages: [
      { page: 1, text: 'Dx: Hypertension\nAmlodipine 5mg od', confidence: 0.91 },
      { page: 2, text: 'BP 130/85', confidence: 0.8 }] });
    expect(view.provenance).toEqual({ processingContract: 'hid-textract-v1', adapter: 'amazon-textract',
      sourceVersionBound: true });
  });

  it.each<[string, unknown]>([
    ['raw model output beside the contract', { ...v2Payload(), rawModelOutput: '{"items":[]}' }],
    ['an unknown key on an item', { ...v2Payload(), items: v2Payload().items.map((item) => ({ ...item, thinking: 'x' })) }],
    ['a later contract', { ...v2Payload(), contract: 'hid-paper-reading-v3' }],
    ['an item citing a line on another page', { ...v2Payload(), items: [{ ...v2Payload().items[0]!, lineIds: ['p2-l1'] }],
      reading: { ...v2Payload().reading, itemCount: 1 } }],
    ['no pages at all', { something: 'else' }],
    ['a non-object', 'text'],
    ['null', null],
  ])('shows nothing from %s', (_name, payload) => {
    const view = projectExtraction(extractionRow(payload));
    expect(view.paperReading).toEqual({ contract: null, pages: [], identity: null, items: [], reading: null });
    expect(view.structuredPayload).toEqual({});
    expect(JSON.stringify(view)).not.toMatch(/rawModelOutput|thinking|Hypertension/);
  });

  it('passes on only versions, models, status and counts from provenance', () => {
    expect(publicProvenance(v2Provenance())).toEqual({ processingContract: 'hid-textract-v2',
      adapter: 'amazon-textract', operation: 'analyze', pageCount: 2, lineCount: 4, sourceVersionBound: true,
      reading: { contract: 'hid-paper-reading-v2', status: 'read', promptVersion: 'hid-paper-reading-prompt-9',
        schemaVersion: 's', firstPassModel: 'claude-sonnet-5-5', rereadModel: 'claude-opus-5-5', itemCount: 3,
        flaggedPages: 1, droppedUngrounded: 1 } });
    expect(publicProvenance({ processingContract: { nested: 'x' }, reading: 'x' })).toEqual({});
    expect(publicProvenance(null)).toEqual({});
  });

  it('reads an ai_off v2 payload as pages with no items', () => {
    const payload = { ...v2Payload(), items: [],
      identity: { nameAsWritten: null, dateOfBirthAsWritten: null, folderNumberAsWritten: null, sexAsWritten: null,
        lineIds: [], box: null },
      reading: { ...v2Payload().reading, status: 'ai_off', firstPassModel: null, rereadModel: null, rereadPages: [],
        droppedUngrounded: 0, itemCount: 0 } };
    const view = readingView(parseStructuredPayload(payload));
    expect(view.reading?.status).toBe('ai_off');
    expect(view.items).toEqual([]);
    expect(view.pages).toHaveLength(2);
  });

  it('answers a null or unparseable confidence as null', () => {
    expect(projectExtraction({ ...extractionRow(v2Payload()), confidence: null }).confidence).toBeNull();
    expect(projectExtraction({ ...extractionRow(v2Payload()), confidence: 'x' }).confidence).toBeNull();
    expect(projectExtraction({ ...extractionRow(v2Payload()), confidence: 0.5 }).confidence).toBe(0.5);
  });
});
