import { IsIn, IsOptional, Matches } from 'class-validator';
import type { OcrJobStatus } from '../ocr.types';

/**
 * The statuses an OCR job can have: ocr.jobs jobs_status_check as 0016
 * replaced it (0013's list plus 'rejected'), the same as OcrJobStatus.
 */
export const OCR_JOB_STATUSES = [
  'queued', 'processing', 'extracted', 'awaiting_validation', 'validated', 'rejected', 'failed', 'cancelled',
] as const satisfies readonly OcrJobStatus[];
export type { OcrJobStatus };

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
