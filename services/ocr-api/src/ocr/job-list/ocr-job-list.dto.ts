import { IsIn, IsOptional, Matches } from 'class-validator';

/** The statuses an OCR job can have (0013 ocr.jobs.status). */
export const OCR_JOB_STATUSES = [
  'queued', 'processing', 'extracted', 'awaiting_validation', 'validated', 'failed', 'cancelled',
] as const;
export type OcrJobStatus = typeof OCR_JOB_STATUSES[number];

export const OCR_JOB_LIST_DEFAULT_LIMIT = 25;
export const OCR_JOB_LIST_MAX_LIMIT = 50;

/**
 * GET /api/v1/ocr/job-list (SX-9): this facility's OCR jobs, newest first.
 * Every value arrives as a string (no implicit conversion); unknown keys are
 * refused by the global validation pipe, so a Health ID or patient id can
 * never be put in this URL.
 */
export class OcrJobListQueryDto {
  /** One status only. */
  @IsOptional()
  @IsIn(OCR_JOB_STATUSES)
  status?: OcrJobStatus;

  /** 'true' lists only the jobs this member started at this facility. */
  @IsOptional()
  @IsIn(['true'])
  mine?: 'true';

  /** 1 to 50; 25 when absent. */
  @IsOptional()
  @Matches(/^(?:[1-9]|[1-4][0-9]|50)$/)
  limit?: string;

  /** The nextCursor of the page before; opaque to the caller. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{16,200}$/)
  cursor?: string;
}
