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
   * How long the PIN access lasts, 5 to 1440 minutes. Left out, it is 1440
   * (24 hours), the owner's decision of 10 Nov 2026; the database command
   * (0121) gives read and write access and refuses more than 1440.
   */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes?: number;
}
