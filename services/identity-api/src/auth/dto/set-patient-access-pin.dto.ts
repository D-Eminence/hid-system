import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

const compactPin = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : value;

export class SetPatientAccessPinDto {
  @Transform(compactPin)
  @IsString()
  @Matches(/^\d{4,8}$/)
  pin!: string;
}
