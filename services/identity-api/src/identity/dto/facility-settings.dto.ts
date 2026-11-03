import { Transform } from 'class-transformer';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

/** Switch One-person lab (owner decision 33.3) with a typed reason of 10 to 500 characters after trimming. */
export class SetOnePersonLabDto {
  @IsBoolean()
  enabled!: boolean;

  @Transform(trim) @IsString() @MinLength(10) @MaxLength(500)
  reason!: string;
}
