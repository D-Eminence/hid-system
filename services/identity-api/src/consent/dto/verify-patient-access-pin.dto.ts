import { Transform, type TransformFnParams } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const normalizedHid = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const compactPin = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : value;

/**
 * This DTO deliberately contains no patient demographics, requested scope, or
 * staff-supplied display name. The governed database command derives those
 * values from the authenticated context and fixes the resulting scope.
 */
export class VerifyPatientAccessPinDto {
  @Transform(normalizedHid)
  @IsString()
  @Matches(/^HID-[A-HJ-NP-Z2-9]{6,32}$/)
  hid!: string;

  @Transform(compactPin)
  @IsString()
  @Matches(/^\d{4,8}$/)
  pin!: string;

  /**
   * The duration asked, 5 to 1440 minutes (the database command checks the
   * same range). Left out, the service asks for 1440. Whatever is asked, the
   * database command (0121) always gives exactly 1440 minutes (24 hours) of
   * read and write access, the owner's decision of 10 Nov 2026.
   */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes?: number;
}
