import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';
import { TimelineQueryDto } from '../shared/clinical.dto';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

/**
 * EHR-C8b: a visit's vitals list leaves out readings entered in error unless
 * `includeEnteredInError=true` (history, struck through on screen).
 */
export class VitalsListQueryDto extends TimelineQueryDto {
  @IsOptionalButNotNull()
  @IsIn(['true', 'false'])
  includeEnteredInError?: 'true' | 'false';
}

/**
 * EHR-C8b: PATCH .../vitals/:vitalId, exactly these fields. `status` is only
 * `entered_in_error`. The reason is required: a missing one answers 400
 * CHANGE_REASON_REQUIRED (the service), one under 3 or over 500 characters
 * (only spaces included, trimmed to nothing) 400 VALIDATION_FAILED.
 */
export class MarkVitalEnteredInErrorDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsIn(['entered_in_error'])
  status!: 'entered_in_error';

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  changeReason?: string;
}
