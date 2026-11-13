// Offline stand-ins for Textract and the Claude API, built from the answer keys, so the whole kit runs in CI
// with no network. The real worker code (TextractOcrProvider, blocksToPages, PaperReadingService, grounding,
// item checks and the contract) runs unchanged on what these return.
//
// FakeTextractClient answers the provider's own SDK commands with LINE and WORD blocks made from the key's
// page text. FakePageModelClient answers each page with the key's items for that page.

const PRINTED_CONFIDENCE = 99.2;
const HANDWRITTEN_CONFIDENCE = 93.5;

/**
 * Whether each line is handwriting: the per-line "handwritten": true where any line of the document carries it;
 * where none does (a hand-labelled set without the flag), every line of a document whose difficulty starts with
 * "handwritten".
 */
export function handwritingOf(key) {
  const flagged = key.text.some((page) => page.lines.some((line) => line.handwritten === true));
  const wholeDocument = String(key.difficulty ?? '').startsWith('handwritten');
  return (line) => (flagged ? line.handwritten === true : wholeDocument);
}

function blocksForPage(page, isHandwritten) {
  const blocks = [];
  for (const line of page.lines) {
    const lineId = `fake-p${page.page}-l${line.n}`;
    const box = line.box ?? { left: 0, top: 0, width: 1, height: 0.02 };
    const words = line.text.split(/\s+/).filter((word) => word.length > 0);
    const wordIds = words.map((_, index) => `${lineId}-w${index + 1}`);
    const handwritten = isHandwritten(line);
    const confidence = handwritten ? HANDWRITTEN_CONFIDENCE : PRINTED_CONFIDENCE;
    blocks.push({ BlockType: 'LINE', Id: lineId, Page: page.page, Text: line.text, Confidence: confidence,
      Geometry: { BoundingBox: { Left: box.left, Top: box.top, Width: box.width, Height: box.height } },
      Relationships: [{ Type: 'CHILD', Ids: wordIds }] });
    words.forEach((word, index) => {
      blocks.push({ BlockType: 'WORD', Id: wordIds[index], Page: page.page, Text: word, Confidence: confidence,
        TextType: handwritten ? 'HANDWRITING' : 'PRINTED' });
    });
  }
  return blocks;
}

/** Stands in for the provider's TextractClient: only send(command) is used. */
export class FakeTextractClient {
  constructor(key, sdk) {
    this.key = key;
    this.sdk = sdk;
    this.handwritten = handwritingOf(key);
    this.calls = [];
  }

  async send(command) {
    const sdk = this.sdk;
    const meta = { $metadata: { requestId: `fake-${this.key.docId}` } };
    const name = command.constructor.name;
    this.calls.push(name);
    if (command instanceof sdk.DetectDocumentTextCommand || command instanceof sdk.AnalyzeDocumentCommand) {
      if (this.key.pages !== 1) throw Object.assign(new Error('fake'), { name: 'UnsupportedDocumentException' });
      return { ...meta, DocumentMetadata: { Pages: 1 }, Blocks: blocksForPage(this.key.text[0], this.handwritten) };
    }
    if (command instanceof sdk.StartDocumentTextDetectionCommand || command instanceof sdk.StartDocumentAnalysisCommand) {
      return { ...meta, JobId: `fake-job-${this.key.docId}` };
    }
    if (command instanceof sdk.GetDocumentTextDetectionCommand || command instanceof sdk.GetDocumentAnalysisCommand) {
      // One page per result page, so the provider's NextToken paging is exercised too.
      const index = command.input.NextToken ? Number(command.input.NextToken.split('-').pop()) : 0;
      const page = this.key.text[index];
      const next = index + 1 < this.key.text.length ? `fake-next-${index + 1}` : undefined;
      return { ...meta, JobStatus: 'SUCCEEDED', DocumentMetadata: { Pages: this.key.pages },
        Blocks: blocksForPage(page, this.handwritten), ...(next ? { NextToken: next } : {}) };
    }
    throw Object.assign(new Error('fake'), { name: 'UnsupportedOperation' });
  }
}

const blank = (value) => (value === null || value === undefined ? '' : String(value));

/** One key item as the model would answer it (the model output schema in src/reading/prompt.ts). */
export function modelItemFromKey(item) {
  const f = item.fields;
  const rx = item.prescription ?? {};
  return {
    kind: item.kind,
    asWritten: item.asWritten,
    plain: item.asWritten,
    lineIds: item.lines.map((n) => `p${item.page}-l${n}`),
    unsure: false,
    dateAsWritten: blank(item.dateAsWritten),
    status: item.kind === 'medicine' || item.kind === 'diagnosis' ? f.status : 'none',
    name: item.kind === 'medicine' || item.kind === 'diagnosis' ? blank(f.name) : '',
    strength: blank(f.strength), form: blank(f.form), route: blank(f.route), frequency: blank(f.frequency),
    duration: blank(f.duration),
    substance: blank(f.substance), reaction: blank(f.reaction),
    severity: item.kind === 'allergy' && f.severity ? f.severity : 'none',
    noKnownAllergies: item.kind === 'allergy' ? Boolean(f.noKnownAllergies) : false,
    test: blank(f.test), value: item.kind === 'lab_result' || item.kind === 'vital' ? blank(f.value) : '',
    unit: blank(f.unit), referenceRange: blank(f.referenceRange), flag: blank(f.flag),
    measure: item.kind === 'vital' ? f.measure : 'none',
    noteText: item.kind === 'note' ? blank(f.text) : '',
    prescriberAsWritten: blank(rx.prescriberAsWritten), prescriptionDate: blank(rx.dateAsWritten),
  };
}

/** Stands in for ClaudePageClient: the same readPage contract, deterministic token usage. */
export class FakePageModelClient {
  constructor(key) {
    this.key = key;
    this.seenPrompt = false;
  }

  async readPage(request) {
    const items = this.key.items.filter((item) => item.page === request.page).map(modelItemFromKey);
    const id = this.key.identity;
    const identity = id && id.page === request.page
      ? { name: blank(id.nameAsWritten), dateOfBirth: blank(id.dateOfBirthAsWritten),
        folderNumber: blank(id.folderNumberAsWritten), sex: blank(id.sexAsWritten),
        lineIds: id.lines.map((n) => `p${request.page}-l${n}`) }
      : { name: '', dateOfBirth: '', folderNumber: '', sex: '', lineIds: [] };
    const answer = { pageUnsure: false, identity, items };
    const pageChars = request.lines.reduce((sum, line) => sum + line.text.length + 40, 0);
    const usage = { inputTokens: Math.ceil(pageChars / 4), outputTokens: 150 + items.length * 120,
      cacheReadInputTokens: this.seenPrompt ? 2_000 : 0, cacheCreationInputTokens: this.seenPrompt ? 0 : 2_000 };
    this.seenPrompt = true;
    return { kind: 'answer', answer, usage, servedInferenceGeo: 'global', attempts: 1 };
  }
}
