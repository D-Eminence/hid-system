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

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(60)
  durationMinutes?: number;
}
