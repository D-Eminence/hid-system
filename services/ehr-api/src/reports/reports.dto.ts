import { IsIn, IsISO8601, IsString, Matches } from 'class-validator';

/**
 * REP-1 (0203, 0204): the facility's operations report, request shapes. Only the two Lagos days of the range (and,
 * for a download, its format): no facility id, patient id, Health ID or NIN is ever taken. The global validation pipe
 * refuses any other field or query parameter (400 VALIDATION_FAILED).
 */

/** A calendar day, YYYY-MM-DD (a Lagos day). */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MESSAGE = 'must be a day written YYYY-MM-DD';

export const REPORT_EXPORT_FORMATS = ['csv', 'pdf'] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

/** Route 1, GET ehr/reports/operations?from=YYYY-MM-DD&to=YYYY-MM-DD. */
export class ReportRangeQueryDto {
  @IsString()
  @Matches(DAY, { message: `from ${DAY_MESSAGE}` })
  @IsISO8601({ strict: true }, { message: `from ${DAY_MESSAGE}` })
  from!: string;

  @IsString()
  @Matches(DAY, { message: `to ${DAY_MESSAGE}` })
  @IsISO8601({ strict: true }, { message: `to ${DAY_MESSAGE}` })
  to!: string;
}

/** Route 2, POST ehr/reports/operations/exports: the range and the format the browser builds. */
export class ReportExportDto extends ReportRangeQueryDto {
  @IsIn(REPORT_EXPORT_FORMATS)
  format!: ReportExportFormat;
}
