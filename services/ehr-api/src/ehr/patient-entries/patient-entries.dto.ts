import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const PATIENT_ENTRY_KINDS = ['visit', 'test', 'medicine', 'diagnosis', 'vaccination', 'other'] as const;
export type PatientEntryKind = typeof PATIENT_ENTRY_KINDS[number];

/** What each field takes, in the words the patient sees. */
export const PATIENT_ENTRY_MESSAGES = {
  kind: 'Choose visit, test, medicine, diagnosis, vaccination or other.',
  title: 'Use 2 to 160 characters, on one line.',
  facilityName: 'Use at most 160 characters, on one line.',
  occurredOn: 'Use a real date from 1 January 1900 to today.',
  notes: 'Use at most 2000 characters of plain text.',
  files: 'Photos can\'t be added yet. Save the record without them.',
} as const;

/**
 * POST ehr/me/patient-entries (0116). The shapes are checked here; the exact
 * limits after trimming (PatientEntriesService, normalizePatientEntry), as
 * the health profile does. attachments and fileIds are declared so that a
 * non-empty list answers 422 PATIENT_ENTRY_FILES_NOT_READY, not the
 * ValidationPipe's 400, until photos and files are served.
 */
export class CreatePatientEntryDto {
  @IsIn(PATIENT_ENTRY_KINDS, { message: PATIENT_ENTRY_MESSAGES.kind })
  kind!: PatientEntryKind;

  @IsString({ message: PATIENT_ENTRY_MESSAGES.title }) @MaxLength(1000, { message: PATIENT_ENTRY_MESSAGES.title })
  title!: string;

  @IsOptional()
  @IsString({ message: PATIENT_ENTRY_MESSAGES.facilityName })
  @MaxLength(1000, { message: PATIENT_ENTRY_MESSAGES.facilityName })
  facilityName?: string | null;

  @IsString({ message: PATIENT_ENTRY_MESSAGES.occurredOn })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: PATIENT_ENTRY_MESSAGES.occurredOn })
  occurredOn!: string;

  @IsOptional()
  @IsString({ message: PATIENT_ENTRY_MESSAGES.notes })
  @MaxLength(8000, { message: PATIENT_ENTRY_MESSAGES.notes })
  notes?: string | null;

  @IsOptional() @IsArray({ message: PATIENT_ENTRY_MESSAGES.files })
  attachments?: unknown[];

  @IsOptional() @IsArray({ message: PATIENT_ENTRY_MESSAGES.files })
  fileIds?: unknown[];
}
