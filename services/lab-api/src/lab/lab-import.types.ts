import type { ImportedLabObservationDto } from './dto/create-lab-import.dto';

export interface OcrLabImportCommand {
  patientId: string;
  sourceDocumentId: string;
  ocrJobId: string;
  extractionId: string;
  validationId: string;
  validationVersion: number;
  publicationId: string;
  reviewedBy: string;
  externalLabName?: string;
  externalReference?: string;
  collectedAt?: string;
  reportedAt?: string;
  observations: ImportedLabObservationDto[];
}
