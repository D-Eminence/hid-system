import { Transform, Type } from 'class-transformer';
import { IsDefined, IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested,
} from 'class-validator';
import { COLLECTED_PHONE_E164, FacilityProfileDto, toCollectedPhone } from './facility-profile.dto';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const products = ['ehr', 'migrate', 'laboratory', 'pharmacy'] as const;

/** The applicant's role at the facility (0122). */
export const SIGNUP_SUBMITTER_ROLES = ['owner', 'medical_director', 'administrator',
  'other_authorised_representative'] as const;

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

  /** 0122 (owner: "all fields required"): the applicant's role at the facility. */
  @IsIn(SIGNUP_SUBMITTER_ROLES)
  administratorRole!: typeof SIGNUP_SUBMITTER_ROLES[number];

  /** 0122: the applicant's own phone, E.164 or a Nigerian local number; stored encrypted (D4). */
  @Transform(toCollectedPhone) @IsString() @Matches(COLLECTED_PHONE_E164)
  administratorPhone!: string;

  /** 0122: the facility's profile; the CAC legal name stays as QoreID reads it (D1). */
  @IsDefined() @ValidateNested() @Type(() => FacilityProfileDto)
  facilityProfile!: FacilityProfileDto;

  @IsIn(['provider-enrollment'])
  turnstileAction!: 'provider-enrollment';

  @IsOptional() @IsString() @MaxLength(2048)
  turnstileToken?: string;
}

export class VerifyProviderEnrollmentDto {
  @IsUUID('4')
  challengeId!: string;

  @Matches(/^[0-9]{6}$/)
  code!: string;
}

export class ActivateProviderEnrollmentDto {
  @IsString() @MinLength(12) @MaxLength(256)
  password!: string;
}
