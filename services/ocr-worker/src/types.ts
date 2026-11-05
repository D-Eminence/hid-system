export interface ClaimedOcrJob {
  jobId: string;
  facilityId: string;
  documentId: string;
  patientId: string | null;
  storageBucket: string;
  storageKey: string;
  objectVersionId: string;
  sourceSha256Hex: string;
  sizeBytes: number;
  mediaType: string;
  provider: string;
  attemptNo: number;
  maxAttempts: number;
  claimToken: string;
  claimExpiresAt: Date;
  correlationId: string;
}

export interface VerifiedDocument {
  bytes: Uint8Array;
  bucket: string;
  key: string;
  versionId: string;
  mediaType: string;
  sha256Hex: string;
}

export interface LineBox { left: number; top: number; width: number; height: number }

/** One Textract LINE, kept as working data. Confidence is 0-1 (the least legible word). */
export interface ReadLine {
  id: string;
  page: number;
  text: string;
  box: LineBox | null;
  confidence: number;
  handwritten: boolean;
}
export interface ReadPage { page: number; lines: readonly ReadLine[] }

/** Text reading v2: every page of the document with its lines in reading order. */
export interface TextReading {
  providerModel: string;
  providerRequestReference: string | null;
  /** Pages the provider read (and charged for); also the page-allowance count. */
  pageCount: number;
  pages: readonly ReadPage[];
  provenance: Readonly<Record<string, unknown>>;
}

export interface WorkerOcrProvider {
  readonly name: string;
  checkReadiness(signal: AbortSignal): Promise<void>;
  extract(document: VerifiedDocument, signal: AbortSignal): Promise<TextReading>;
}

/** What ocr.complete_worker_job stores. Provenance never carries document text. */
export interface CompletedExtraction {
  providerModel: string;
  providerRequestReference: string | null;
  rawText: string;
  structuredPayload: Readonly<Record<string, unknown>>;
  confidence: number;
  provenance: Readonly<Record<string, unknown>>;
}

/** A facility's page allowance for the current Africa/Lagos calendar month (migration 0107). */
export interface PageAllowance {
  pagesUsed: number;
  pagesLimit: number;
  /** ISO date (YYYY-MM-DD) the allowance resets, at 00:00 Africa/Lagos. */
  resetsOn: string;
  paused: boolean;
}

/** One model's Claude API use for one attempt of one job (counts only; ocr.record_worker_ai_usage, 0107). */
export interface AiUsageRecord {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface WorkerRepository {
  checkReadiness(): Promise<void>;
  /** ocr.claim_worker_job_fair: no facility gets more than maxInFlightPerFacility jobs processing at once. */
  claim(provider: string, leaseSeconds: number, maxInFlightPerFacility: number,
    correlationId: string): Promise<ClaimedOcrJob | null>;
  metrics(): Promise<Readonly<{ queueDepth: number; oldestQueueAgeSeconds: number }>>;
  renew(job: ClaimedOcrJob, leaseSeconds: number): Promise<void>;
  complete(job: ClaimedOcrJob, extraction: CompletedExtraction): Promise<string>;
  fail(job: ClaimedOcrJob, failure: SafeWorkerFailure): Promise<void>;
  pageAllowance(job: ClaimedOcrJob): Promise<PageAllowance>;
  recordPages(job: ClaimedOcrJob, pageCount: number): Promise<PageAllowance>;
  /** Requeues the job until the allowance resets without using an attempt; returns when it resumes. */
  pauseForAllowance(job: ClaimedOcrJob): Promise<Date | null>;
  /** Stores one model's totals for the job's current attempt; a replay replaces them. */
  recordAiUsage(job: ClaimedOcrJob, usage: AiUsageRecord): Promise<void>;
  close(): Promise<void>;
}

export interface DocumentReader { readExact(job: ClaimedOcrJob, signal: AbortSignal): Promise<VerifiedDocument> }

export class SafeWorkerFailure extends Error {
  constructor(
    readonly code: string,
    readonly safeSummary: string,
    readonly retryable: boolean,
    readonly retryDelaySeconds: number,
  ) { super(safeSummary); }
}

/** Terminal: the document has more pages than one paper record may have. Carries the billed page count. */
export class DocumentTooManyPagesFailure extends SafeWorkerFailure {
  constructor(readonly pageCount: number, maxPages: number) {
    super('DOCUMENT_TOO_MANY_PAGES', `Document has more than ${maxPages} pages`, false, 0);
  }
}
