export type OcrJobStatus =
  | 'queued'
  | 'processing'
  | 'extracted'
  | 'awaiting_validation'
  | 'validated'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export interface OcrObjectReference {
  documentId: string;
  objectKey: string;
  objectVersionId: string;
  objectSha256Hex: string;
  mediaType: string;
  facilityId: string;
}

export interface OcrPageText {
  page: number;
  text: string;
  confidence: number;
}

export interface OcrExtraction {
  provider: string;
  providerModel: string;
  pages: readonly OcrPageText[];
}

export interface OcrProvider {
  extract(source: OcrObjectReference): Promise<OcrExtraction>;
}

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');

