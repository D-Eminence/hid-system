import type { OcrJobStatus } from './ocr.types';

export interface OcrSourceState {
  documentStatus: string;
  scanStatus: string;
  objectVersionId: string | null;
  objectSha256Hex: string | null;
}

const transitions: Readonly<Record<OcrJobStatus, readonly OcrJobStatus[]>> = {
  queued: ['processing', 'cancelled'],
  processing: ['extracted', 'failed'],
  extracted: ['awaiting_validation'],
  awaiting_validation: ['validated', 'rejected', 'failed'],
  validated: [],
  rejected: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

export function canTransitionOcrJob(from: OcrJobStatus, to: OcrJobStatus): boolean {
  return transitions[from].includes(to);
}

export function assertOcrJobTransition(from: OcrJobStatus, to: OcrJobStatus): void {
  if (!canTransitionOcrJob(from, to)) {
    throw new Error(`Invalid OCR job transition: ${from} -> ${to}`);
  }
}

export function assertOcrSourceEligible(source: OcrSourceState): void {
  if (
    source.documentStatus !== 'available'
    || source.scanStatus !== 'clean'
    || !source.objectVersionId
    || !/^[a-f0-9]{64}$/.test(source.objectSha256Hex ?? '')
  ) {
    throw new Error('OCR requires an available, clean, immutable object binding');
  }
}

