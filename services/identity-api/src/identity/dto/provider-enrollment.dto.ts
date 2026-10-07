import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const products = ['ehr', 'migrate', 'laboratory', 'pharmacy'] as const;

export class StartProviderEnrollmentDto {
  @IsIn(products)
  productCode!: typeof products[number];

  @IsIn(['clinic', 'hospital', 'laboratory', 'pharmacy', 'other'])
  organizationType!: 'clinic' | 'hospital' | 'laboratory' | 'pharmacy' | 'other';

  @Transform(({ value }: { value: unknown }) => typeof value === 'string'
    ? value.replace(/\s+/g, '').toUpperCase() : value)
  @Matches(/^(RC|BN|IT)[0-9]{4,20}$/)
  cacRegistrationNumber!: string;

  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200)
  administratorName!: string;

  @Transform(trim) @IsEmail() @MaxLength(254)
  administratorEmail!: string;

  @IsIn(['provider-enrollment'])
  turnstileAction!: 'provider-enrollment';

  @IsString() @MaxLength(2048)
  turnstileToken!: string;
}

export class VerifyProviderEnrollmentDto {
  @Matches(/^[0-9]{6}$/)
  code!: string;
}

export class ActivateProviderEnrollmentDto {
  @IsString() @MinLength(12) @MaxLength(256)
  password!: string;
}
