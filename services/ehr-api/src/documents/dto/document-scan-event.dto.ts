import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown => typeof value === 'string' ? value.trim() : value;

export class DocumentScanEventDto {
  @IsUUID('4')
  documentId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  objectVersionId!: string;

  @Matches(/^[0-9a-f]{64}$/)
  objectSha256Hex!: string;

  @IsIn(['scan_started', 'clean', 'rejected', 'failed'])
  eventType!: 'scan_started' | 'clean' | 'rejected' | 'failed';

  @Transform(trim)
  @ValidateIf((input: DocumentScanEventDto) => input.eventType === 'clean' || input.detectedMediaType !== undefined)
  @IsIn(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'])
  detectedMediaType?: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/\S/)
  scannerEngine!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/\S/)
  scannerVersion!: string;

  @Transform(trim)
  @ValidateIf((input: DocumentScanEventDto) =>
    input.eventType === 'rejected' || input.eventType === 'failed' || input.reasonCode !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  reasonCode?: string;

  @Transform(trim)
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/)
  idempotencyKey!: string;
}
