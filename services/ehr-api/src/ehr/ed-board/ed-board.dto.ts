import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';
import { MATCH_REF_PATTERN } from '../worklist/visit-queue.dto';

/**
 * ED-1 (0168, 0169): the emergency department board's request bodies. Built at
 * the recommended options Q-ED-1 A to Q-ED-7 A (not yet answered by the
 * owner). No Health ID or NIN in any field: a patient is named by a search
 * card's `matchRef` or by the patient's UUID, an ED record by its UUID.
 */

/** How the patient came to the department. */
export const ED_ARRIVAL_MODES = ['walk_in', 'ambulance', 'brought_by_public', 'police', 'referred', 'other'] as const;
export type EdArrivalMode = (typeof ED_ARRIVAL_MODES)[number];

/** The open stages of the waiting-list row (0135) the board moves between. */
export const ED_OPEN_STAGES = ['waiting', 'triage', 'ready', 'with_clinician'] as const;
export type EdOpenStage = (typeof ED_OPEN_STAGES)[number];

/** Where the patient goes next (Q-ED-5 A, Q-ED-6 A). */
export const ED_OUTCOMES = ['discharged', 'admit_requested', 'referred_out', 'sent_to_outpatients', 'left_before_seen',
  'left_against_advice', 'died'] as const;
export type EdOutcome = (typeof ED_OUTCOMES)[number];

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
/** A query flag: exactly "true" or "false"; anything else stays as given and fails @IsBoolean. */
const queryFlag = ({ value }: TransformFnParams): unknown => value === 'true' ? true : value === 'false' ? false : value;
/** No control characters (as the database's [[:cntrl:]] check). */
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
/** ISO 8601 in UTC with a Z, as every other time the API takes. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z$/;

/**
 * Route 1, POST ehr/ed-attendances. Exactly one of `matchRef` (this member's
 * own search card, in the last 10 minutes; an emergency search's card with
 * X-Purpose-Of-Use: emergency) or `patientId` (this facility's own patient,
 * including an unknown record made here). The triage level and complaint are
 * for nurses, clinicians and doctors only.
 */
export class EdArriveDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(47)
  @Matches(MATCH_REF_PATTERN, { message: 'matchRef must be the match reference a patient search gave' })
  matchRef?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  patientId?: string;

  @IsIn(ED_ARRIVAL_MODES)
  arrivalMode!: EdArrivalMode;

  @IsOptionalButNotNull()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(UTC_INSTANT, { message: 'arrivedAt must be a UTC time ending in Z' })
  arrivedAt?: string;

  /** 1 (most urgent) to 5, 0135's scale. Outside 1-5 answers ED_TRIAGE_INVALID. */
  @IsOptionalButNotNull()
  @IsInt()
  triageLevel?: number;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  @Matches(NO_CONTROL, { message: 'presentingComplaint must not contain control characters' })
  presentingComplaint?: string;
}

/** Route 2, GET ehr/ed-board?includeClosedToday=true also lists the records closed that arrived today (Lagos day). */
export class EdBoardQueryDto {
  @IsOptionalButNotNull()
  @Transform(queryFlag)
  @IsBoolean()
  includeClosedToday?: boolean;
}

/** Every write names the card's `rowVersion` it was made on. */
export class EdVersionedDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;
}

/** Route 4, POST ehr/ed-attendances/:attendanceId/triage. `presentingComplaint: null` clears it. */
export class EdTriageDto extends EdVersionedDto {
  @IsInt()
  triageLevel!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  @Matches(NO_CONTROL, { message: 'presentingComplaint must not contain control characters' })
  presentingComplaint?: string | null;
}

/** Route 5, POST ehr/ed-attendances/:attendanceId/move. At least one change; `assignedMembershipId: null` clears it. */
export class EdMoveDto extends EdVersionedDto {
  @IsOptionalButNotNull()
  @IsIn(ED_OPEN_STAGES)
  stage?: EdOpenStage;

  @IsOptional()
  @IsUUID('all')
  assignedMembershipId?: string | null;
}

/** Route 6, POST ehr/ed-attendances/:attendanceId/visit. */
export class EdLinkVisitDto extends EdVersionedDto {
  @IsUUID('all')
  encounterId!: string;
}

/** Route 7, POST ehr/ed-attendances/:attendanceId/disposition. */
export class EdDispositionDto extends EdVersionedDto {
  @IsIn(ED_OUTCOMES)
  outcome!: EdOutcome;

  /** For admit_requested only: one of this facility's departments (0114 codes) other than emergency. */
  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^[a-z_]{2,40}$/, { message: 'admitToDepartmentCode must be a department code' })
  admitToDepartmentCode?: string;

  /** For admit_requested only: an active clinician or doctor of this facility. */
  @IsOptionalButNotNull()
  @IsUUID('all')
  admittingMembershipId?: string;

  /** For referred_out only: 2-120 characters. */
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  @Matches(NO_CONTROL, { message: 'referredToFacilityName must not contain control characters' })
  referredToFacilityName?: string;

  /** Required (8-500 characters) when a recorded decision is changed. */
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  reason?: string;
}

/** Route 8, POST ehr/ed-attendances/:attendanceId/leave. */
export class EdLeaveDto extends EdVersionedDto {}

/** Route 9, POST ehr/ed-attendances/:attendanceId/cancel: an arrival made in error, with a reason (8-500). */
export class EdCancelDto extends EdVersionedDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  reason?: string;
}
