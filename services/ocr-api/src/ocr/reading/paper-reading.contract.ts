import { z } from 'zod';

/**
 * The shared contract for ocr.extractions.structured_payload written by the
 * OCR worker for processing contract 'hid-textract-v2'. Session C (the OCR HTTP service)
 * reads exactly this shape; copy this file rather than re-deriving it.
 *
 * No raw model output and no text of dropped items is ever stored in it.
 */
export const PAPER_READING_CONTRACT = 'hid-paper-reading-v2';
export const PAPER_READING_SCHEMA_VERSION = 'hid-paper-reading-schema-2';

export const FLAG_REASONS = ['low_confidence', 'handwriting', 'many_dropped', 'ai_unsure',
  'possible_missed_item', 'ai_declined'] as const;
export const ITEM_KINDS = ['medicine', 'diagnosis', 'allergy', 'note', 'lab_result', 'vital'] as const;
export const MEDICINE_STATUSES = ['current', 'new', 'stopped', 'past', 'unknown'] as const;
export const DIAGNOSIS_STATUSES = ['confirmed', 'suspected', 'ruled_out', 'history', 'family_history'] as const;
export const VITAL_MEASURES = ['blood_pressure', 'pulse', 'temperature', 'respiratory_rate',
  'oxygen_saturation', 'weight', 'height', 'blood_glucose'] as const;
/**
 * How bad an allergy is, only where the paper says so: 'mild', 'moderate' or 'severe' (anaphylaxis is
 * 'severe'), 'unknown' where the paper says it is not known, null where the paper does not say.
 */
export const ALLERGY_SEVERITIES = ['mild', 'moderate', 'severe', 'unknown'] as const;
export const READING_STATUSES = ['read', 'ai_off', 'ai_declined', 'ai_failed', 'no_text'] as const;
/**
 * Why a flagged page was re-read from its text only, without the picture of the page:
 * 'image_reread_off' (OCR_AI_IMAGE_REREAD=off), 'image_has_masked_number' (the page's text had a NIN-like or phone
 * number hidden, which the picture would show; OCR_AI_IMAGE_MASKED_PAGES=text_only),
 * 'image_not_available_pdf' / 'image_not_available_tiff' (v1 sends PNG and JPEG only),
 * 'image_not_available_type' (another detected type), 'image_not_given' (the caller passed no document bytes),
 * 'not_single_page' (not page 1 of a one-page image), 'image_too_large' (over the Claude API image limits),
 * 'image_size_unknown' (the picture's size could not be read from its header), 'image_orientation_unsupported'
 * (a JPEG whose EXIF orientation is not 1, or unreadable, so the picture as seen would not match the line boxes),
 * 'image_tier_unknown' (the re-read model is not on the worker's list of models with a known image tier, so the
 * size the model would see the picture at is not known), 'image_rejected' (the API refused the request with the
 * picture as an invalid request), 'image_refused' (the model declined the request with the picture, which may be
 * about the picture); after those two the page was re-read from its text instead. 'not_hard_to_read' is no longer written (the page's flags now decide; owner decision
 * 2026-11-05) and stays so payloads written before still read.
 */
export const IMAGE_REREAD_SKIP_REASONS = ['image_reread_off', 'not_hard_to_read', 'image_not_available_pdf',
  'image_not_available_tiff', 'image_not_available_type', 'image_not_given', 'not_single_page', 'image_too_large',
  'image_size_unknown', 'image_rejected', 'image_has_masked_number', 'image_orientation_unsupported',
  'image_tier_unknown', 'image_refused'] as const;

const fraction = z.number().min(0).max(1);
export const boxSchema = z.strictObject({ left: fraction, top: fraction, width: fraction, height: fraction });
const lineId = z.string().regex(/^p[1-9]\d*-l[1-9]\d*$/);
const nullableText = z.string().nullable();

export const lineSchema = z.strictObject({
  id: lineId,
  text: z.string(),
  box: boxSchema.nullable(),
  confidence: fraction,
  handwritten: z.boolean(),
});

export const pageSchema = z.strictObject({
  page: z.number().int().min(1),
  flagged: z.boolean(),
  flagReasons: z.array(z.enum(FLAG_REASONS)),
  lines: z.array(lineSchema),
});

export const identitySchema = z.strictObject({
  nameAsWritten: nullableText,
  dateOfBirthAsWritten: nullableText,
  folderNumberAsWritten: nullableText,
  sexAsWritten: nullableText,
  lineIds: z.array(lineId),
  box: boxSchema.nullable(),
});

/**
 * 'it-' and 16 hex characters from the source, kind, cited lines and asWritten. Two different items with the
 * same base id get '-2', '-3', ... in reading order (page, then first cited line). Unique within a payload.
 */
export const ITEM_ID = /^it-[0-9a-f]{16}(-[2-9]|-[1-9][0-9]+)?$/;
const itemBase = {
  id: z.string().regex(ITEM_ID),
  asWritten: z.string().min(1),
  plain: z.string(),
  dateAsWritten: nullableText,
  page: z.number().int().min(1),
  lineIds: z.array(lineId).min(1),
  box: boxSchema,
  confidence: z.enum(['clear', 'check_carefully']),
  checkReasons: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
  checkReason: nullableText,
  readBy: z.enum(['first_pass', 'reread']),
};

export const prescriptionSchema = z.strictObject({ prescriberAsWritten: nullableText, dateAsWritten: nullableText });

export const itemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...itemBase, kind: z.literal('medicine'),
    fields: z.strictObject({ name: nullableText, strength: nullableText, form: nullableText, route: nullableText,
      frequency: nullableText, duration: nullableText, status: z.enum(MEDICINE_STATUSES) }),
    prescription: prescriptionSchema.nullable() }),
  z.strictObject({ ...itemBase, kind: z.literal('diagnosis'),
    fields: z.strictObject({ name: nullableText, status: z.enum(DIAGNOSIS_STATUSES) }), prescription: z.null() }),
  z.strictObject({ ...itemBase, kind: z.literal('allergy'),
    fields: z.strictObject({ substance: nullableText, reaction: nullableText,
      severity: z.enum(ALLERGY_SEVERITIES).nullable(), noKnownAllergies: z.boolean() }),
    prescription: z.null() }),
  z.strictObject({ ...itemBase, kind: z.literal('lab_result'),
    fields: z.strictObject({ test: nullableText, value: nullableText, unit: nullableText,
      referenceRange: nullableText, flag: nullableText }), prescription: z.null() }),
  z.strictObject({ ...itemBase, kind: z.literal('vital'),
    fields: z.strictObject({ measure: z.enum(VITAL_MEASURES), value: nullableText, unit: nullableText }),
    prescription: z.null() }),
  z.strictObject({ ...itemBase, kind: z.literal('note'),
    fields: z.strictObject({ text: nullableText }), prescription: z.null() }),
]);

export const readingSchema = z.strictObject({
  status: z.enum(READING_STATUSES),
  firstPassModel: nullableText,
  rereadModel: nullableText,
  rereadPages: z.array(z.number().int().min(1)),
  /**
   * Items dropped because they did not hold to the page, summed over pages, from each page's final reading. For a
   * re-read page this counts the re-read's dropped items, including any whose content a kept first-pass item still
   * carries (not_in_picture_reading or not_in_second_reading).
   */
  droppedUngrounded: z.number().int().min(0),
  itemCount: z.number().int().min(0),
  promptVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  // Added with the image re-read: optional, so payloads written before it still read. The worker always writes them.
  /** Pages whose re-read was answered from the picture of the page (their items are read_from_image). */
  imageRereadPages: z.array(z.number().int().min(1)).optional(),
  /** Re-read pages that went without the picture, and why. */
  imageRereadSkipped: z.array(z.strictObject({ page: z.number().int().min(1),
    reason: z.enum(IMAGE_REREAD_SKIP_REASONS) })).optional(),
  /**
   * Pages sent with the picture whose image re-read gave no usable answer (cut off or malformed, a rejection that
   * is not the picture's, unavailable after retries, or no item kept where the first pass had items); their
   * first-pass items stay, marked reread_failed. A picture rejected as an invalid request or declined is in
   * imageRereadSkipped ('image_rejected', 'image_refused') instead, and the page was re-read from its text.
   */
  imageRereadFailedPages: z.array(z.number().int().min(1)).optional(),
});

/**
 * Counts the worker adds to the extraction's provenance (provenance.reading.counts), so live readings can be
 * measured from the database and not only from the logs (Phase 1 "measure, content-free"). Not part of the
 * structured payload. Codes and non-negative integer counts only: every key of a map is a reason code (lower case,
 * digits and "_"), never text from a page. Optional as a whole: payloads written before it, and any job where it
 * could not be computed, carry no `counts`.
 *
 * - droppedByReason / droppedByReasonFirstPass: items dropped by reason code (items.ts DROP_REASONS, tidy.ts
 *   TIDY_DROP_REASONS), from the reading each page ended with / from the first pass, as in ocr.job.completed.
 * - hardPageAgreement: how far a hard page's two best-guess readings agreed, summed over hard pages
 *   (fieldsCompared, fieldsAgreed: agree; fieldsCompared - fieldsAgreed: disagree; itemsPaired; itemsSingle:
 *   one-sided; drugSplits; alternativesDropped).
 * - zoomCalls / zoomLimited / zoomFailed: zoom crops returned, calls refused at the limit, calls failed.
 * - hardPageDeadlineHits: hard pages where the page's deadline cut a read still running.
 * - hardReadFailures: hard-page reads with no answer, by reason code ('deadline', 'max_tokens', 'api_error', ...).
 * The re-read failures are already counted in provenance.reading.rereadFailedPages (a count).
 */
/**
 * The only keys the counts may hold: the reader's drop reasons (items.ts DROP_REASONS and tidy.ts
 * TIDY_DROP_REASONS) and hard-read failures (reader.ts HardReadFailure). A closed list, so no other word (a
 * medicine or diagnosis) can ever be stored as a key; contract-codes.spec.ts keeps these equal to the reader's.
 */
export const READING_DROP_REASON_CODES = ['no_line_cited', 'line_not_on_page', 'empty_as_written', 'text_not_on_line',
  'no_box', 'box_too_small', 'too_many_lines', 'too_many_lines_on_row', 'too_many_rows', 'rows_not_together',
  'cited_lines_no_box', 'not_on_cited_line', 'area_too_large', 'side_overflow', 'covers_uncited_line',
  'uncited_share', 'not_anchored', 'heading', 'duplicate_of_order'] as const;
export const HARD_READ_FAILURE_CODES = ['max_tokens', 'parse_error', 'schema_error', 'refusal', 'zoom_loop',
  'incomplete', 'deadline', 'api_error', 'api_rejected'] as const;
const dropCode = z.enum(READING_DROP_REASON_CODES);
const failureCode = z.enum(HARD_READ_FAILURE_CODES);
const count = z.number().int().min(0);
export const READING_COUNTS_VERSION = 1;
export const readingCountsSchema = z.strictObject({
  version: z.literal(READING_COUNTS_VERSION),
  droppedByReason: z.partialRecord(dropCode, count),
  droppedByReasonFirstPass: z.partialRecord(dropCode, count),
  hardPageAgreement: z.strictObject({ fieldsCompared: count, fieldsAgreed: count, itemsPaired: count,
    itemsSingle: count, drugSplits: count, alternativesDropped: count }),
  zoomCalls: count,
  zoomLimited: count,
  zoomFailed: count,
  hardPageDeadlineHits: count,
  hardReadFailures: z.partialRecord(failureCode, count),
});
/** provenance.reading.listVersion (list-version.ts): 16 hex characters. */
export const listVersionSchema = z.string().regex(/^[0-9a-f]{16}$/);

export const paperReadingPayloadSchema = z.strictObject({
  contract: z.literal(PAPER_READING_CONTRACT),
  pages: z.array(pageSchema),
  identity: identitySchema,
  items: z.array(itemSchema),
  reading: readingSchema,
}).superRefine((payload, context) => {
  const linesById = new Map<string, number>();
  payload.pages.forEach((page, index) => {
    if (page.flagged !== page.flagReasons.length > 0) {
      context.addIssue({ code: 'custom', path: ['pages', index, 'flagged'], message: 'flagged must match flagReasons' });
    }
    for (const line of page.lines) {
      if (!line.id.startsWith(`p${page.page}-`)) {
        context.addIssue({ code: 'custom', path: ['pages', index], message: 'line id is not on its page' });
      }
      linesById.set(line.id, page.page);
    }
  });
  const itemIds = new Set<string>();
  payload.items.forEach((item, index) => {
    if (itemIds.has(item.id)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'id'], message: 'item ids must be unique' });
    }
    itemIds.add(item.id);
    if (item.lineIds.some((id) => linesById.get(id) !== item.page)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'lineIds'], message: 'item cites a line not on its page' });
    }
    if ((item.confidence === 'clear') !== (item.checkReasons.length === 0)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'confidence'], message: 'confidence must match checkReasons' });
    }
  });
  if (payload.identity.lineIds.some((id) => !linesById.has(id))) {
    context.addIssue({ code: 'custom', path: ['identity', 'lineIds'], message: 'identity cites an unknown line' });
  }
  if (payload.reading.itemCount !== payload.items.length) {
    context.addIssue({ code: 'custom', path: ['reading', 'itemCount'], message: 'itemCount must equal items.length' });
  }
  if (payload.reading.status !== 'read' && payload.items.length > 0) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'only a read document carries items' });
  }
});

export type Box = z.infer<typeof boxSchema>;
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];
export type FlagReason = (typeof FLAG_REASONS)[number];
export type ItemKind = (typeof ITEM_KINDS)[number];
export type PaperLine = z.infer<typeof lineSchema>;
export type PaperPage = z.infer<typeof pageSchema>;
export type PaperIdentity = z.infer<typeof identitySchema>;
export type PaperItem = z.infer<typeof itemSchema>;
export type ReadingStatus = (typeof READING_STATUSES)[number];
export type ImageRereadSkipReason = (typeof IMAGE_REREAD_SKIP_REASONS)[number];
export type PaperReading = z.infer<typeof readingSchema>;
export type ReadingCounts = z.infer<typeof readingCountsSchema>;
export type PaperReadingPayload = z.infer<typeof paperReadingPayloadSchema>;
