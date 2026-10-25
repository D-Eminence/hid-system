import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Support lists or unlists a facility for orders from other facilities (C23, PRIV P6). */
export class SetOrderRouteDestinationDto {
  @IsBoolean()
  listed!: boolean;

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/** Support closes a live order route (C22). */
export class CloseOrderRouteDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/** Support finds order routes by their reference or by the patient's Health ID (C21): exactly one. */
export class FindOrderRoutesDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(64)
  reference?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(64)
  healthId?: string;
}
