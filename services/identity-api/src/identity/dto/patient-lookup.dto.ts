import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

export class PatientLookupDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString()
  @MaxLength(36)
  @Matches(/^HID-[A-HJ-NP-Z2-9]{6,32}$/)
  hid!: string;

  @IsIn(['direct-care', 'emergency', 'healthcare-operations'])
  purpose!: PurposeOfUse;
}
