import { Transform, Type } from 'class-transformer';
import { Equals, IsIn, IsInt, IsISO8601, IsObject, IsString, Length, Matches, Max, MaxLength, Min, MinLength,
  ValidateNested } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export const CLINICIAN_APPLICATION_LIST_STATES = ['open', 'awaiting_authenticator', 'submitted', 'under_review',
  'approved', 'rejected', 'withdrawn', 'expired'] as const;
export type ClinicianApplicationListState = typeof CLINICIAN_APPLICATION_LIST_STATES[number];

/** The applicant-facing reasons of a rejection (ADR-064); `identity_not_confirmed` blocks further applications. */
export const CLINICIAN_APPLICATION_DECISION_CODES = ['licence_not_verified', 'licence_not_current', 'details_mismatch',
  'identity_not_confirmed', 'employment_not_confirmed', 'facility_not_available', 'duplicate', 'existing_account',
  'other'] as const;

/** A1: the verification queue. No personal data in the query. */
export class ListClinicianApplicationsDto {
  @IsOptionalButNotNull() @IsIn(CLINICIAN_APPLICATION_LIST_STATES)
  state: ClinicianApplicationListState = 'open';

  /** Rows per page (1 to 50, default 20). */
  @IsOptionalButNotNull() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  limit = 20;

  /** The opaque `nextCursor` of the previous page. */
  @IsOptionalButNotNull() @IsString() @MinLength(1) @MaxLength(512)
  cursor?: string;
}

/**
 * Step 1's checklist (design §7): every check true, how identity was confirmed
 * and through which independent channel employment was confirmed. Exactly
 * these six keys; the database checks them again.
 */
export class ClinicianApplicationChecklistDto {
  @Equals(true)
  registerChecked!: true;

  @Equals(true)
  licenceCurrentUntilRecorded!: true;

  @IsIn(['video_call_photo_id', 'in_person_photo_id'])
  identityMethod!: 'video_call_photo_id' | 'in_person_photo_id';

  @Equals(true)
  identityConfirmed!: true;

  @IsIn(['facility_public_phone', 'in_person_visit'])
  employmentChannel!: 'facility_public_phone' | 'in_person_visit';

  @Equals(true)
  employmentConfirmed!: true;
}

/** A3: step 1, with a live code the applicant reads from their authenticator. */
export class AttestClinicianApplicationDto {
  /** When the attestation lapses: by the end of the licence's expiry date (Lagos) and within three years. */
  @IsISO8601({ strict: true, strictSeparator: true })
  validUntil!: string;

  /** Where the reviewed evidence is kept (a ticket or document reference); never the document itself. */
  @Transform(trim) @IsString() @Length(8, 500)
  evidenceReference!: string;

  @IsObject() @ValidateNested() @Type(() => ClinicianApplicationChecklistDto)
  checklist!: ClinicianApplicationChecklistDto;

  /** Never stored or audited; not part of the request digest, so a replay needs no new code. */
  @Transform(trim) @Matches(/^[0-9]{6}$/)
  authenticatorCode!: string;

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/** A4: step 2 by a different Super Admin. */
export class ApproveClinicianApplicationDto {
  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/** A5. */
export class RejectClinicianApplicationDto {
  @IsIn(CLINICIAN_APPLICATION_DECISION_CODES)
  decisionCode!: typeof CLINICIAN_APPLICATION_DECISION_CODES[number];

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}
