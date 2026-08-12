import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateRegistrationCaseDto {
  @IsUUID('4')
  localCommandId!: string;

  @Matches(/^tmp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  temporaryPatientId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsIn(['female', 'male', 'other', 'unknown'])
  sex!: 'female' | 'male' | 'other' | 'unknown';

  @IsInt()
  @Min(0)
  @Max(130)
  ageYears!: number;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  operationalNotes?: string;
}
