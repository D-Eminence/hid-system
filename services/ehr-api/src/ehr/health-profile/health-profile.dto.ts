import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const GENOTYPES = ['AA', 'AS', 'AC', 'SS', 'SC', 'CC'] as const;
export type BloodGroup = typeof BLOOD_GROUPS[number];
export type Genotype = typeof GENOTYPES[number];

/**
 * PUT ehr/me/health-profile (0094). A blood group or genotype is one of the
 * lists or null; each text is a string or null, which HealthProfileService
 * trims (blank is null, CRLF is a newline) and limits to 1000 characters
 * without control characters other than newlines.
 */
export class SaveHealthProfileDto {
  @IsOptional() @IsIn(BLOOD_GROUPS)
  bloodGroup?: BloodGroup | null;

  @IsOptional() @IsIn(GENOTYPES)
  genotype?: Genotype | null;

  @IsOptional() @IsString() @MaxLength(4000)
  allergies?: string | null;

  @IsOptional() @IsString() @MaxLength(4000)
  currentMedications?: string | null;

  @IsOptional() @IsString() @MaxLength(4000)
  chronicConditions?: string | null;

  @IsOptional() @IsString() @MaxLength(4000)
  medicalNotes?: string | null;

  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;
}
