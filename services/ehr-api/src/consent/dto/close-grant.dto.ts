import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class CloseGrantDto {
  @Transform(({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(8, 500)
  reason!: string;
}
