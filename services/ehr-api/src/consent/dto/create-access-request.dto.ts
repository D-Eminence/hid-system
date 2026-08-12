import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
const normalizedHid = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateAccessRequestDto {
  @Transform(normalizedHid)
  @IsString()
  @Matches(/^HID-[A-HJ-NP-Z2-9]{6,32}$/)
  hid!: string;

  @IsIn(['read_records', 'write_records'])
  scope!: 'read_records' | 'write_records';

  @Transform(trim)
  @IsString()
  @Length(8, 500)
  reason!: string;

  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes!: number;
}
