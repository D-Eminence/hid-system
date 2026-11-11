import { IsOptional, Matches } from 'class-validator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/v1/ocr/quality/summary?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC days, both inclusive, at most 92 days). */
export class OcrQualitySummaryQueryDto {
  @IsOptional()
  @Matches(DAY)
  from?: string;

  @IsOptional()
  @Matches(DAY)
  to?: string;
}
