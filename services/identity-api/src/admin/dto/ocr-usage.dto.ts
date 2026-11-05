import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/** GET /admin/facilities/:facilityId/ocr-usage?month=YYYY-MM (absent: this Africa/Lagos month). */
export class OcrUsageQueryDto {
  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^(20[0-9]{2})-(0[1-9]|1[0-2])$/, { message: 'month must be a month written as YYYY-MM' })
  month?: string;
}

/** PUT /admin/facilities/:facilityId/ocr-page-limit (platform super admin only; ocr.set_facility_page_limit). */
export class OcrPageLimitCommandDto {
  @IsInt({ message: 'pagesLimit must be a whole number of pages' })
  @Min(1, { message: 'pagesLimit must be at least 1 page' })
  @Max(100_000, { message: 'pagesLimit must be at most 100000 pages' })
  pagesLimit!: number;

  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString({ message: 'reason must be text' })
  @Length(1, 240, { message: 'reason must be 1 to 240 characters' })
  @Matches(/^[^\x00-\x1f\x7f]*$/, { message: 'reason must not contain control characters' })
  reason!: string;
}
