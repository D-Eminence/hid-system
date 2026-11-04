import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown => typeof value === 'string' ? value.trim() : value;

/**
 * POST /api/v1/ehr/documents/scan-targets/resolve: the S3 object a GuardDuty
 * scan result names. Only keys under clinical/objects/ (the upload intent's
 * prefix, the only one the malware protection plan scans) are taken.
 */
export class ResolveScanTargetDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
  storageBucket!: string;

  @IsString()
  @Matches(/^clinical\/objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  storageKey!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  objectVersionId!: string;
}
