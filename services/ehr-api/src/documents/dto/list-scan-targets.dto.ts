import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

// Query values arrive as strings (implicit conversion is off): only plain
// decimal digits become numbers, anything else fails IsInt.
const integer = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && /^[0-9]{1,9}$/.test(value) ? Number(value) : value;

/** GET /api/v1/ehr/documents/scan-targets?olderThanSeconds=&limit= (both required). */
export class ListScanTargetsDto {
  @Transform(integer)
  @IsInt()
  @Min(0)
  @Max(31_536_000)
  olderThanSeconds!: number;

  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(100)
  limit!: number;
}
