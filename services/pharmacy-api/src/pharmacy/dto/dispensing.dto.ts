import { Transform } from 'class-transformer';
import { IsInt, IsNumber, IsString, Length, Max, Min, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class CreateDispensingDto {
  @IsInt() @Min(1) expectedWorkItemVersion!: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) quantityDispensed!: number;
  @Transform(trim) @IsString() @Length(1, 80) quantityUnit!: string;
  @Transform(trim) @IsString() @Length(8, 500) reason!: string;
}

/**
 * ORD-12 (refills, 0154), the body while PRESCRIPTION_REFILLS_ENABLED is on
 * (CreateDispensingBodyPipe): today's fields and `fillNumber`, the fill this
 * dispensing records: 1 for the first fill, 2 and above for refills, at most
 * 12 (0154's CHECK). Left out, it is the first fill, so today's clients keep
 * working. An explicit null is refused, as any other value outside 1-12.
 * Off, the body is CreateDispensingDto and `fillNumber` is refused like any
 * field the route does not take.
 */
export class CreateRefillDispensingDto extends CreateDispensingDto {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined) @IsInt() @Min(1) @Max(12) fillNumber?: number;
}

export class ReverseDispensingDto {
  @IsInt() @Min(1) expectedDispensingVersion!: number;
  @Transform(trim) @IsString() @Length(8, 500) reason!: string;
}
