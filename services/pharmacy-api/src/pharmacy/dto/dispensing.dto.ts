import { Transform } from 'class-transformer';
import { IsInt, IsNumber, IsString, Length, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class CreateDispensingDto {
  @IsInt() @Min(1) expectedWorkItemVersion!: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) quantityDispensed!: number;
  @Transform(trim) @IsString() @Length(1, 80) quantityUnit!: string;
  @Transform(trim) @IsString() @Length(8, 500) reason!: string;
}

export class ReverseDispensingDto {
  @IsInt() @Min(1) expectedDispensingVersion!: number;
  @Transform(trim) @IsString() @Length(8, 500) reason!: string;
}
