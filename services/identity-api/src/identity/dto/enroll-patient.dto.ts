import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';
import { ApproveRegistrationCaseDto } from './approve-registration-case.dto';

export class EnrollPatientDto extends ApproveRegistrationCaseDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
