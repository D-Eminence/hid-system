import { Type } from 'class-transformer';
import { Equals, IsBoolean, IsDefined, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength,
  ValidateNested } from 'class-validator';

/** The approved procedure (ADR-063): one original photo ID of these four kinds, checked in person. */
export const ASSISTED_DOCUMENT_TYPES = ['national_id_card', 'international_passport', 'drivers_licence',
  'voters_card'] as const;
export type AssistedDocumentType = typeof ASSISTED_DOCUMENT_TYPES[number];

/** What the staff member types from the document; compared with the NIN record and never stored. */
export class AssistedVerificationDocumentDto {
  @IsString() @MinLength(1) @MaxLength(100) firstName!: string;
  @IsString() @MinLength(1) @MaxLength(100) lastName!: string;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateOfBirth?: string;
}

/** The staff member's five attestations; each must be true. */
export class AssistedVerificationAttestationsDto {
  @IsBoolean() @Equals(true) patientPresent!: true;
  @IsBoolean() @Equals(true) originalDocumentSeen!: true;
  @IsBoolean() @Equals(true) photoMatchesPerson!: true;
  @IsBoolean() @Equals(true) codeShownOnPatientsOwnDevice!: true;
  @IsBoolean() @Equals(true) patientConsents!: true;
}

export class AssistedVerificationDto {
  /** As shown on the patient's own device; spaces, hyphens and case are ignored. */
  @IsString() @Matches(/^[0-9A-Za-z -]{10,20}$/) deskCode!: string;
  @IsIn(['government_photo_id_in_person']) method!: 'government_photo_id_in_person';
  @IsIn(ASSISTED_DOCUMENT_TYPES) documentType!: AssistedDocumentType;
  @IsDefined() @IsObject() @ValidateNested() @Type(() => AssistedVerificationDocumentDto)
  document!: AssistedVerificationDocumentDto;
  @IsDefined() @IsObject() @ValidateNested() @Type(() => AssistedVerificationAttestationsDto)
  attestations!: AssistedVerificationAttestationsDto;
}
