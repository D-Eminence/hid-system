import { IsInt, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

export class LinkExistingPatientDto {
  @IsUUID()
  canonicalPatientId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @MinLength(8)
  @MaxLength(1000)
  reason!: string;
}
