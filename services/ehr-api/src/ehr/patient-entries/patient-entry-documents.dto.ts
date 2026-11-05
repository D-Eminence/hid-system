import { IsInt, IsString, MaxLength } from 'class-validator';

/** What the patient may upload to a record they added (0117, the owner's limits). */
export const PATIENT_DOCUMENT_MEDIA_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type PatientDocumentMediaType = typeof PATIENT_DOCUMENT_MEDIA_TYPES[number];
export const PATIENT_DOCUMENT_MAX_BYTES = 10_485_760;
export const PATIENT_DOCUMENT_MAX_NAME = 255;

export const PATIENT_DOCUMENT_MESSAGES = {
  fileName: 'Use a file name of 1 to 255 characters.',
  mediaType: 'Use a JPG or PNG photo, or a PDF.',
  sizeBytes: 'Each file can be up to 10 MB.',
  sha256Hex: 'Send the file\'s SHA-256 as 64 hexadecimal characters.',
} as const;

/**
 * POST ehr/me/patient-entries/:entryId/documents/upload-intents (0117). The
 * shapes are checked here, the exact limits by normalizePatientDocument (400
 * VALIDATION_FAILED naming each field). The server sets the patient, the
 * record, the storage key, the classification and the retention: any other
 * member is refused by the ValidationPipe.
 */
export class CreatePatientEntryDocumentUploadDto {
  @IsString({ message: PATIENT_DOCUMENT_MESSAGES.fileName })
  @MaxLength(1000, { message: PATIENT_DOCUMENT_MESSAGES.fileName })
  fileName!: string;

  @IsString({ message: PATIENT_DOCUMENT_MESSAGES.mediaType })
  @MaxLength(100, { message: PATIENT_DOCUMENT_MESSAGES.mediaType })
  mediaType!: string;

  @IsInt({ message: PATIENT_DOCUMENT_MESSAGES.sizeBytes })
  sizeBytes!: number;

  @IsString({ message: PATIENT_DOCUMENT_MESSAGES.sha256Hex })
  @MaxLength(100, { message: PATIENT_DOCUMENT_MESSAGES.sha256Hex })
  sha256Hex!: string;
}
