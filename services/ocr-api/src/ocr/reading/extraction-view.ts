import { z } from 'zod';
import {
  PAPER_READING_CONTRACT, paperReadingPayloadSchema,
  type PaperIdentity, type PaperItem, type PaperLine, type PaperReading, type PaperReadingPayload, type FlagReason,
} from './paper-reading.contract';
import { LEGACY_PROCESSING_CONTRACT } from './reading-versions';

/** One row of ocr.extractions as listExtractions selects it. */
export interface ExtractionRow {
  id: string;
  version: number;
  attempt: number;
  provider: string;
  providerModel: string | null;
  /** NULL once the OCR worker deleted the source and its reading after 24 hours (migration 0112). */
  rawText: string | null;
  structuredPayload: unknown;
  confidence: number | string | null;
  provenance: unknown;
  createdAt: Date | string;
}

/** One page for the check screen: the page text (lines joined) and, for v2, its lines and flags. */
export interface ReadingPageView {
  page: number;
  text: string;
  flagged: boolean;
  flagReasons: FlagReason[];
  lines: PaperLine[];
}

/**
 * What the staff check screen reads, the same for every contract:
 * - 'hid-paper-reading-v2': pages with lines and flags, identity, items and reading.
 * - 'hid-textract-v1' (old extractions): page text only; no lines, identity, items or reading.
 * - null: a payload this API does not recognise or that breaks the contract. Nothing from it is shown.
 */
export interface PaperReadingView {
  contract: typeof PAPER_READING_CONTRACT | typeof LEGACY_PROCESSING_CONTRACT | null;
  pages: ReadingPageView[];
  identity: PaperIdentity | null;
  items: PaperItem[];
  reading: PaperReading | null;
}

/**
 * The first contract's payload. Only page, text and confidence were ever written, so only they are read;
 * anything else in an old row is ignored rather than passed on.
 */
const legacyPayloadSchema = z.object({
  pages: z.array(z.object({
    page: z.number().int().min(1),
    text: z.string(),
    confidence: z.number().min(0).max(1),
  })),
});
type LegacyPayload = z.infer<typeof legacyPayloadSchema>;

type ParsedPayload =
  | { contract: typeof PAPER_READING_CONTRACT; payload: PaperReadingPayload }
  | { contract: typeof LEGACY_PROCESSING_CONTRACT; payload: LegacyPayload }
  | { contract: null };

export function parseStructuredPayload(value: unknown): ParsedPayload {
  if (value && typeof value === 'object' && 'contract' in value) {
    // A payload that names a contract is read only as that contract, strictly: an unknown key or a
    // broken rule (an item citing a line that is not on its page, say) shows nothing rather than a part.
    const current = paperReadingPayloadSchema.safeParse(value);
    return current.success ? { contract: PAPER_READING_CONTRACT, payload: current.data } : { contract: null };
  }
  const legacy = legacyPayloadSchema.safeParse(value);
  return legacy.success ? { contract: LEGACY_PROCESSING_CONTRACT, payload: legacy.data } : { contract: null };
}

export function readingView(parsed: ParsedPayload): PaperReadingView {
  if (parsed.contract === PAPER_READING_CONTRACT) {
    const { pages, identity, items, reading } = parsed.payload;
    return {
      contract: PAPER_READING_CONTRACT,
      pages: pages.map((page) => ({ page: page.page, text: page.lines.map((line) => line.text).join('\n'),
        flagged: page.flagged, flagReasons: page.flagReasons, lines: page.lines })),
      identity, items, reading,
    };
  }
  if (parsed.contract === LEGACY_PROCESSING_CONTRACT) {
    return {
      contract: LEGACY_PROCESSING_CONTRACT,
      pages: parsed.payload.pages.map((page) => ({ page: page.page, text: page.text,
        flagged: false, flagReasons: [], lines: [] })),
      identity: null, items: [], reading: null,
    };
  }
  return { contract: null, pages: [], identity: null, items: [], reading: null };
}

/** The payload as the contract defines it (a parsed copy, never the stored object), or {} when unreadable. */
function contractPayload(parsed: ParsedPayload): Record<string, unknown> {
  if (parsed.contract === PAPER_READING_CONTRACT) return parsed.payload;
  if (parsed.contract === LEGACY_PROCESSING_CONTRACT) {
    return { pages: parsed.payload.pages.map(({ page, text, confidence }) => ({ page, text, confidence })) };
  }
  return {};
}

const PROVENANCE_KEYS = ['processingContract', 'adapter', 'operation', 'pageCount', 'lineCount',
  'sourceVersionBound'] as const;
const READING_PROVENANCE_KEYS = ['contract', 'status', 'promptVersion', 'schemaVersion', 'firstPassModel',
  'rereadModel', 'itemCount', 'flaggedPages', 'droppedUngrounded'] as const;

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (scalar(value)) result[key] = value;
  }
  return result;
}

/**
 * Provenance for the check screen: versions, models, status and counts only. Token usage, request counts,
 * inference geography, failure codes and anything a later worker adds stay in the database.
 */
export function publicProvenance(provenance: unknown): Record<string, unknown> {
  const result = pick(provenance, PROVENANCE_KEYS);
  const reading = provenance && typeof provenance === 'object' && !Array.isArray(provenance)
    ? (provenance as Record<string, unknown>).reading : undefined;
  if (reading && typeof reading === 'object' && !Array.isArray(reading)) {
    result.reading = pick(reading, READING_PROVENANCE_KEYS);
  }
  return result;
}

function confidenceNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The extraction exactly as GET /api/v1/ocr/jobs/:jobId/extractions answers it. contentDeleted is true when the
 * job's source document is 'source_deleted' (the OCR worker deleted the page and blanked the reading 24 hours after
 * the job finished, migration 0112): rawText is then '' and the reading empty, whatever the row still holds.
 */
export function projectExtraction(row: ExtractionRow, contentDeleted = false) {
  const parsed = contentDeleted ? { contract: null } as const : parseStructuredPayload(row.structuredPayload);
  return {
    id: row.id,
    version: row.version,
    attempt: row.attempt,
    provider: row.provider,
    providerModel: row.providerModel,
    contentDeleted,
    rawText: contentDeleted ? '' : row.rawText ?? '',
    structuredPayload: contractPayload(parsed),
    confidence: confidenceNumber(row.confidence),
    provenance: publicProvenance(row.provenance),
    createdAt: row.createdAt,
    paperReading: readingView(parsed),
  };
}

export type ExtractionView = ReturnType<typeof projectExtraction>;
