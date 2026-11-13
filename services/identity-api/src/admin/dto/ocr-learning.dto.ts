import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsString, IsUUID, Length, Matches, ValidateIf } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /admin/ocr/quality-summary?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC days, both inclusive; default the last 28 days;
 * at most 92, widened to whole ISO weeks).
 */
export class OcrQualitySummaryQueryDto {
  @IsOptionalButNotNull()
  @IsString()
  @Matches(DAY, { message: 'from must be a day written as YYYY-MM-DD' })
  from?: string;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(DAY, { message: 'to must be a day written as YYYY-MM-DD' })
  to?: string;
}

/** PUT /admin/ocr/learning-switches (platform super admin only; ocr.set_learning_switch, 0119). */
export class OcrLearningSwitchCommandDto {
  @IsIn(['platform', 'facility'], { message: 'scope must be platform or facility' })
  scope!: 'platform' | 'facility';

  @ValidateIf((input: OcrLearningSwitchCommandDto) => input.scope === 'facility' || input.facilityId !== undefined)
  @IsUUID('all', { message: 'facilityId must be a facility id (only with scope facility)' })
  facilityId?: string;

  @IsBoolean({ message: 'enabled must be true or false' })
  enabled!: boolean;

  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString({ message: 'reason must be text' })
  @Length(1, 240, { message: 'reason must be 1 to 240 characters' })
  @Matches(/^[^\x00-\x1f\x7f]*$/, { message: 'reason must not contain control characters' })
  reason!: string;
}
