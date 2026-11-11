import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsString, Matches, Max,
  MaxLength, Min, MinLength, registerDecorator, type ValidationArguments,
} from 'class-validator';
import { normalizeLicenceNumber, LICENCE_NUMBER } from '../staff-licence';

/**
 * The facility profile 0114 collects at facility sign-up and in the setup
 * wizard (owner: "all fields required"). Every field is required; the
 * registry ID and the NHIA number are required exactly when the matching yes/no
 * is true and must be null (or left out) when it is false. The three document
 * uploads and the logo are not collected yet (they wait for the document
 * scanner). The rules are the database's (identity.facility_profiles), so a
 * request the DTO accepts is one 0114 stores.
 */

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const lowerTrim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * A phone as E.164 ("+" and 8-15 digits, normalizeContactForLookup's rule,
 * decision D3). Spaces, dots, dashes and brackets are ignored; a Nigerian
 * local number (0 and 10 digits) is read as +234.
 */
export const COLLECTED_PHONE_E164 = /^\+[1-9][0-9]{7,14}$/;
export const toCollectedPhone = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const compact = value.trim().replace(/[\s().-]/g, '');
  return /^0\d{10}$/.test(compact) ? `+234${compact.slice(1)}` : compact;
};

/** The 36 states and the FCT (ISO 3166-2:NG), as identity.nigeria_states holds them. */
export const NIGERIA_STATE_CODES = ['AB', 'AD', 'AK', 'AN', 'BA', 'BY', 'BE', 'BO', 'CR', 'DE', 'EB', 'ED', 'EK',
  'EN', 'FC', 'GO', 'IM', 'JI', 'KD', 'KN', 'KT', 'KE', 'KO', 'KW', 'LA', 'NA', 'NI', 'OG', 'ON', 'OS', 'OY', 'PL',
  'RI', 'SO', 'TA', 'YO', 'ZA'] as const;

/** identity.facility_department_codes() (decision D7: informational, creates no department). */
export const FACILITY_DEPARTMENT_CODES = ['general_outpatient', 'emergency', 'inpatient', 'laboratory', 'pharmacy',
  'maternity', 'pediatrics', 'radiology', 'dental', 'physiotherapy', 'dialysis', 'oncology', 'cardiology', 'icu',
  'theatre'] as const;

export const FACILITY_OWNERSHIPS = ['public', 'private', 'faith_based', 'ngo'] as const;
export const FACILITY_CARE_LEVELS = ['primary', 'secondary', 'tertiary'] as const;

/** The value is a 2-100 character trimmed text when `flag` is true, and null or absent when it is false. */
function NumberExactlyWhen(flag: string) {
  return (target: object, propertyName: string) => registerDecorator({
    name: 'numberExactlyWhen', target: target.constructor, propertyName,
    options: { message: `${propertyName} is required when ${flag} is true, and must be empty when it is false` },
    validator: {
      validate(value: unknown, args: ValidationArguments) {
        const enabled = (args.object as Record<string, unknown>)[flag];
        if (enabled === true) return typeof value === 'string' && value.length >= 2 && value.length <= 100;
        return value === undefined || value === null;
      },
    },
  });
}

export class FacilityProfileDto {
  /** The name people know the facility by; the CAC legal name is kept as it is (D1). */
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200)
  tradingName!: string;

  @IsIn(FACILITY_OWNERSHIPS)
  ownership!: typeof FACILITY_OWNERSHIPS[number];

  @IsIn(FACILITY_CARE_LEVELS)
  careLevel!: typeof FACILITY_CARE_LEVELS[number];

  /** The site address (D2: not shown in the public directory, which keeps the CAC address). */
  @Transform(trim) @IsString() @MinLength(5) @MaxLength(300)
  addressLine!: string;

  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100)
  city!: string;

  @IsIn(NIGERIA_STATE_CODES)
  stateCode!: typeof NIGERIA_STATE_CODES[number];

  /** Local government area, free text until the official list is loaded (D6). */
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100)
  lga!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 6 }) @Min(4) @Max(14)
  gpsLatitude!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 6 }) @Min(2.5) @Max(15)
  gpsLongitude!: number;

  @Transform(toCollectedPhone) @IsString() @Matches(COLLECTED_PHONE_E164)
  phone!: string;

  @Transform(lowerTrim) @IsEmail() @MaxLength(254)
  email!: string;

  @IsInt() @Min(0) @Max(100000)
  bedCount!: number;

  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200)
  operatingHours!: string;

  @IsBoolean()
  emergency24h!: boolean;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(15) @ArrayUnique() @IsIn(FACILITY_DEPARTMENT_CODES, { each: true })
  departments!: Array<typeof FACILITY_DEPARTMENT_CODES[number]>;

  @Transform(trim) @IsString() @MinLength(2) @MaxLength(2000)
  servicesOffered!: string;

  /** The State Ministry of Health licence number. */
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100)
  smohLicenceNumber!: string;

  @IsBoolean()
  hasRegistryId!: boolean;

  /** The facility registry ID, exactly when hasRegistryId is true. */
  @Transform(trim) @NumberExactlyWhen('hasRegistryId')
  registryId?: string | null;

  @IsBoolean()
  hasNhiaAccreditation!: boolean;

  /** The NHIA accreditation number, exactly when hasNhiaAccreditation is true. */
  @Transform(trim) @NumberExactlyWhen('hasNhiaAccreditation')
  nhiaAccreditationNumber?: string | null;

  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200)
  medicalDirectorName!: string;

  /** The Medical Director's MDCN number, in the format staff licences use (D4). */
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? normalizeLicenceNumber(value) : value)
  @IsString() @Matches(LICENCE_NUMBER) @Matches(/^(?!.* {2})/)
  medicalDirectorMdcn!: string;

  @IsInt() @Min(1) @Max(100000)
  expectedStaff!: number;

  /** Will the facility bring records from an older system (Migrate)? */
  @IsBoolean()
  migratingRecords!: boolean;

  /** Does the facility need to exchange records with other systems? */
  @IsBoolean()
  needsInteroperability!: boolean;
}

/** The profile as 0114's JSON (the identity.facility_profiles column names). */
export function facilityProfileForDatabase(profile: FacilityProfileDto): Record<string, unknown> {
  return {
    trading_name: profile.tradingName,
    ownership: profile.ownership,
    care_level: profile.careLevel,
    address_line: profile.addressLine,
    city: profile.city,
    state_code: profile.stateCode,
    lga: profile.lga,
    gps_latitude: profile.gpsLatitude,
    gps_longitude: profile.gpsLongitude,
    phone_e164: profile.phone,
    email: profile.email,
    bed_count: profile.bedCount,
    operating_hours: profile.operatingHours,
    emergency_24h: profile.emergency24h,
    departments: profile.departments,
    services_offered: profile.servicesOffered,
    smoh_licence_number: profile.smohLicenceNumber,
    has_registry_id: profile.hasRegistryId,
    registry_id: profile.hasRegistryId ? profile.registryId ?? null : null,
    has_nhia_accreditation: profile.hasNhiaAccreditation,
    nhia_accreditation_number: profile.hasNhiaAccreditation ? profile.nhiaAccreditationNumber ?? null : null,
    medical_director_name: profile.medicalDirectorName,
    medical_director_mdcn: profile.medicalDirectorMdcn,
    expected_staff: profile.expectedStaff,
    migrating_records: profile.migratingRecords,
    needs_interoperability: profile.needsInteroperability,
  };
}

/** The stored profile (0114's JSON) as the API answers it. */
export interface FacilityProfileView {
  tradingName: string;
  ownership: string;
  careLevel: string;
  addressLine: string;
  city: string;
  stateCode: string;
  lga: string;
  gpsLatitude: number;
  gpsLongitude: number;
  phone: string;
  email: string;
  bedCount: number;
  operatingHours: string;
  emergency24h: boolean;
  departments: string[];
  servicesOffered: string;
  smohLicenceNumber: string;
  hasRegistryId: boolean;
  registryId: string | null;
  hasNhiaAccreditation: boolean;
  nhiaAccreditationNumber: string | null;
  medicalDirectorName: string;
  medicalDirectorMdcn: string;
  expectedStaff: number;
  migratingRecords: boolean;
  needsInteroperability: boolean;
  source: 'self_service_signup' | 'facility_administrator';
  submitterRole: string | null;
  submitterPhoneOnRecord: boolean;
  updatedAt: string | null;
  version: number;
}

export function facilityProfileFromDatabase(row: Record<string, unknown>): FacilityProfileView {
  const text = (key: string) => String(row[key]);
  const nullableText = (key: string) => row[key] === null || row[key] === undefined ? null : String(row[key]);
  return {
    tradingName: text('trading_name'),
    ownership: text('ownership'),
    careLevel: text('care_level'),
    addressLine: text('address_line'),
    city: text('city'),
    stateCode: text('state_code'),
    lga: text('lga'),
    gpsLatitude: Number(row.gps_latitude),
    gpsLongitude: Number(row.gps_longitude),
    phone: text('phone_e164'),
    email: text('email'),
    bedCount: Number(row.bed_count),
    operatingHours: text('operating_hours'),
    emergency24h: row.emergency_24h === true,
    departments: Array.isArray(row.departments) ? row.departments.map(String) : [],
    servicesOffered: text('services_offered'),
    smohLicenceNumber: text('smoh_licence_number'),
    hasRegistryId: row.has_registry_id === true,
    registryId: nullableText('registry_id'),
    hasNhiaAccreditation: row.has_nhia_accreditation === true,
    nhiaAccreditationNumber: nullableText('nhia_accreditation_number'),
    medicalDirectorName: text('medical_director_name'),
    medicalDirectorMdcn: text('medical_director_mdcn'),
    expectedStaff: Number(row.expected_staff),
    migratingRecords: row.migrating_records === true,
    needsInteroperability: row.needs_interoperability === true,
    source: text('source') as FacilityProfileView['source'],
    submitterRole: nullableText('submitter_role'),
    submitterPhoneOnRecord: row.submitter_phone_on_record === true,
    updatedAt: nullableText('updated_at'),
    version: Number(row.row_version),
  };
}
