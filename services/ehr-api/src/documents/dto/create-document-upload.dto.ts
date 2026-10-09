import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

export class CreateDocumentUploadDto {
  @IsUUID('4')
  patientId!: string;

  @IsOptionalButNotNull()
  @IsUUID('4')
  encounterId?: string;

  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(255)
  @Matches(/^[^/\\\u0000-\u001F\u007F]+$/)
  fileName!: string;

  @IsIn(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'])
  mediaType!: string;

  @IsInt()
  @Min(1)
  @Max(52_428_800)
  sizeBytes!: number;

  @Matches(/^[0-9a-f]{64}$/)
  sha256Hex!: string;

  @IsIn(['phi', 'restricted', 'internal'])
  classification!: 'phi' | 'restricted' | 'internal';

  @IsIn(['clinical-10y', 'clinical-permanent', 'legal-hold'])
  retentionClass!: string;
}
