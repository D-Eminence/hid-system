import { Transform, type TransformFnParams } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

/** Trimmed text; an empty or blank value is left out (undefined). */
const trimmedOrAbsent = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};
const trimmed = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
const healthId = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== 'string') return value;
  const trimmedValue = value.trim().toUpperCase();
  return trimmedValue ? trimmedValue : undefined;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;

/**
 * POST /api/v1/identity/patient-search (0132). Every key is optional here;
 * which combinations are allowed, and how far each reaches, is the strong
 * and weak key rule (patient-search-keys.ts). The Health ID goes in the body,
 * never in the URL.
 */
export class PatientSearchDto {
  @IsOptional()
  @Transform(trimmedOrAbsent)
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @Transform(trimmedOrAbsent)
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @Transform(trimmedOrAbsent)
  @IsString()
  @Matches(DATE)
  dateOfBirth?: string;

  @IsOptional()
  @Transform(healthId)
  @IsString()
  @MaxLength(36)
  @Matches(HEALTH_ID)
  healthId?: string;

  @IsOptional()
  @Transform(trimmedOrAbsent)
  @IsString()
  @Length(7, 24)
  phone?: string;
}

/**
 * POST /api/v1/identity/patient-search/emergency (0132): exactly first name,
 * last name and date of birth, and a reason typed before any result.
 */
export class EmergencyPatientSearchDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @Transform(trimmed)
  @IsString()
  @Length(1, 100)
  lastName!: string;

  @Transform(trimmed)
  @IsString()
  @Matches(DATE)
  dateOfBirth!: string;

  @Transform(trimmed)
  @IsString()
  @Length(8, 500)
  reason!: string;
}
