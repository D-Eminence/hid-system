import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsString, IsUUID, Length, Matches, MaxLength, Min,
  ValidateNested,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';
import { MATCH_REF_PATTERN } from '../worklist/visit-queue.dto';

/**
 * REF-1 (0191-0193): the request bodies of referrals between facilities. Built
 * on the owner's answers Q261-Q266 A (25 November 2026) and at the recommended
 * options Q-REF-7 to Q-REF-15 (not yet answered by the owner). No Health ID or
 * NIN in any field: a patient is named by UUID or a search card's `matchRef`,
 * a referral by its UUID.
 */

/** Where a referral goes: a facility on Health ID, or a printed letter (Q263 A). */
export const REFERRAL_DESTINATION_KINDS = ['health_id', 'printed'] as const;
export type ReferralDestinationKind = (typeof REFERRAL_DESTINATION_KINDS)[number];

/** Routine and urgent only (Q266 A). */
export const REFERRAL_URGENCIES = ['routine', 'urgent'] as const;
export type ReferralUrgency = (typeof REFERRAL_URGENCIES)[number];

/** The 15 facility department codes (0114, section 43.6; Q-REF-11 A). */
export const REFERRAL_DEPARTMENT_CODES = ['general_outpatient', 'emergency', 'inpatient', 'laboratory', 'pharmacy',
  'maternity', 'pediatrics', 'radiology', 'dental', 'physiotherapy', 'dialysis', 'oncology', 'cardiology', 'icu',
  'theatre'] as const;

export const REFERRAL_WITHDRAW_REASONS = ['patient_changed_mind', 'no_longer_needed', 'sent_in_error', 'other'] as const;
export type ReferralWithdrawReason = (typeof REFERRAL_WITHDRAW_REASONS)[number];

/** Drafts for the clinical lead's sign-off (Q124 A). */
export const REFERRAL_DECLINE_REASONS = ['service_not_offered', 'no_capacity', 'more_information_needed',
  'better_elsewhere', 'other'] as const;
export type ReferralDeclineReason = (typeof REFERRAL_DECLINE_REASONS)[number];

/** Drafts for the clinical lead's sign-off (Q124 A); did_not_attend only before arrival, the others only after. */
export const REFERRAL_OUTCOMES = ['seen_care_returned', 'seen_care_continues', 'admitted', 'referred_onward',
  'did_not_attend'] as const;
export type ReferralOutcome = (typeof REFERRAL_OUTCOMES)[number];

export const REFERRAL_STATES = ['printed', 'sent', 'accepted', 'arrived', 'completed', 'declined', 'withdrawn'] as const;
export const REFERRAL_EFFECTIVE_STATES = [...REFERRAL_STATES, 'expired'] as const;
export type ReferralEffectiveState = (typeof REFERRAL_EFFECTIVE_STATES)[number];

/** The per-kind package limits (drafts for the clinical lead): over a limit answers REFERRAL_PACKAGE_INVALID. */
export const REFERRAL_PACKAGE_LIMITS = {
  diagnosisIds: 30, prescriptionIds: 30, allergyIds: 30, vitalIds: 10, labResultIds: 20,
} as const;

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
/** No control characters (as the database's [[:cntrl:]] check). */
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
/** Line breaks allowed, no other control character. */
const LINES_ONLY = /^[^\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]*$/;

/** `{ "kind": "health_id", "facilityId" }` or `{ "kind": "printed", "facilityName", "town"? }`. */
export class ReferralDestinationDto {
  @IsIn(REFERRAL_DESTINATION_KINDS)
  kind!: ReferralDestinationKind;

  @IsOptionalButNotNull()
  @IsUUID('all')
  facilityId?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  @Matches(NO_CONTROL, { message: 'facilityName must not contain control characters' })
  facilityName?: string;

  /** 0-120 characters; an empty town is no town. */
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  @Matches(NO_CONTROL, { message: 'town must not contain control characters' })
  town?: string;
}

/** The ids the clinician ticked, per kind. The server builds the frozen copy from the source rows. */
export class ReferralPackageDto {
  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  diagnosisIds?: string[];

  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  prescriptionIds?: string[];

  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  allergyIds?: string[];

  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  vitalIds?: string[];

  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  labResultIds?: string[];
}

/** Route 2, POST ehr/patients/:patientId/encounters/:encounterId/referrals. */
export class SendReferralDto {
  /** Missing, or neither kind's shape: 400 REFERRAL_DESTINATION_REQUIRED. */
  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => ReferralDestinationDto)
  destination?: ReferralDestinationDto;

  @IsIn(REFERRAL_DEPARTMENT_CODES)
  departmentCode!: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  @Matches(NO_CONTROL, { message: 'serviceWanted must not contain control characters' })
  serviceWanted?: string;

  @IsIn(REFERRAL_URGENCIES)
  urgency!: ReferralUrgency;

  @Transform(trim)
  @IsString()
  @Length(8, 300)
  @Matches(NO_CONTROL, { message: 'reason must not contain control characters' })
  reason!: string;

  @IsString()
  @Length(20, 8000)
  @Matches(LINES_ONLY, { message: 'letterText may hold line breaks but no other control characters' })
  letterText!: string;

  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => ReferralPackageDto)
  package?: ReferralPackageDto;

  @IsString()
  @Matches(/^referral-(health-id|printed)-attestation-v[1-9][0-9]{0,3}$/, {
    message: 'attestationTextVersion must be the version the agreement text route gave',
  })
  attestationTextVersion!: string;

  /** Must be true: 400 REFERRAL_ATTESTATION_REQUIRED otherwise. */
  @IsBoolean()
  patientAgreed!: boolean;
}

/** Route 1, GET ehr/referral-attestation?destinationKind=. */
export class ReferralAttestationQueryDto {
  @IsIn(REFERRAL_DESTINATION_KINDS)
  destinationKind!: ReferralDestinationKind;
}

/** Routes 3 and 10: `state` a comma-separated list, `limit` 1-200, an opaque `cursor`. */
export class ReferralListQueryDto {
  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^[a-z]+(,[a-z]+){0,7}$/, { message: 'state must be a comma-separated list of states' })
  state?: string;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^(?:[1-9]|[1-9][0-9]|1[0-9][0-9]|200)$/, { message: 'limit must be a whole number from 1 to 200' })
  limit?: string;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^[0-9]{1,20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, {
    message: 'cursor must be the nextCursor a list gave',
  })
  cursor?: string;
}

/** Route 8: the visit's referrals with `encounterId`, the patient page's without. */
export class PatientReferralsQueryDto {
  @IsOptionalButNotNull()
  @IsUUID('all')
  encounterId?: string;
}

/** Every write names the card's `rowVersion` it was made on (412 REFERRAL_VERSION_CONFLICT otherwise). */
export class ReferralVersionedDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;
}

/** Route 4: the referring facility withdraws. A note of 8-500 is required for sent_in_error and other. */
export class WithdrawReferralDto extends ReferralVersionedDto {
  @IsIn(REFERRAL_WITHDRAW_REASONS)
  reasonCode!: ReferralWithdrawReason;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @Matches(LINES_ONLY, { message: 'note may hold line breaks but no other control characters' })
  note?: string;
}

/** Route 11: accept, with an optional note to the referrer (0-500). */
export class AcceptReferralDto extends ReferralVersionedDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @Matches(LINES_ONLY, { message: 'note may hold line breaks but no other control characters' })
  note?: string;
}

/** Route 12: decline with a reason and a note (8-500; shorter answers REFERRAL_REASON_REQUIRED). */
export class DeclineReferralDto extends ReferralVersionedDto {
  @IsIn(REFERRAL_DECLINE_REASONS)
  reasonCode!: ReferralDeclineReason;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @Matches(LINES_ONLY, { message: 'note may hold line breaks but no other control characters' })
  note?: string;
}

/** Route 14: exactly one of `matchRef` (this member's own search here) or `patientId` (this facility's own patient). */
export class ArriveReferralDto extends ReferralVersionedDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(47)
  @Matches(MATCH_REF_PATTERN, { message: 'matchRef must be the match reference a patient search gave' })
  matchRef?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  patientId?: string;
}

/** Route 15: the counter-referral. */
export class CompleteReferralDto extends ReferralVersionedDto {
  @IsIn(REFERRAL_OUTCOMES)
  outcome!: ReferralOutcome;

  @Transform(trim)
  @IsString()
  @Length(8, 2000)
  @Matches(LINES_ONLY, { message: 'feedbackNote may hold line breaks but no other control characters' })
  feedbackNote!: string;
}

/** Route 17: the patient withdraws before acceptance. */
export class PatientWithdrawReferralDto extends ReferralVersionedDto {}
