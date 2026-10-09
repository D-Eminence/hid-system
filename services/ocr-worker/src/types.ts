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

export interface ProviderPage { page: number; text: string; confidence: number }
export interface ProviderExtraction {
  providerModel: string;
  providerRequestReference: string | null;
  pages: readonly ProviderPage[];
  provenance: Readonly<Record<string, unknown>>;
}

export interface WorkerOcrProvider {
  readonly name: string;
  checkReadiness(signal: AbortSignal): Promise<void>;
  extract(document: VerifiedDocument, signal: AbortSignal): Promise<ProviderExtraction>;
}

export interface WorkerRepository {
  checkReadiness(): Promise<void>;
  claim(provider: string, leaseSeconds: number, correlationId: string): Promise<ClaimedOcrJob | null>;
  metrics(): Promise<Readonly<{ queueDepth: number; oldestQueueAgeSeconds: number }>>;
  renew(job: ClaimedOcrJob, leaseSeconds: number): Promise<void>;
  complete(job: ClaimedOcrJob, extraction: ProviderExtraction): Promise<string>;
  fail(job: ClaimedOcrJob, failure: SafeWorkerFailure): Promise<void>;
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
