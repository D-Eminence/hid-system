import { Transform, type TransformFnParams } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/** EHR-C7 (0135): the stages of a waiting-list row. The last three close it. */
export const VISIT_QUEUE_STAGES = ['waiting', 'triage', 'ready', 'with_clinician', 'finished', 'left', 'cancelled'] as const;
export type VisitQueueStage = (typeof VISIT_QUEUE_STAGES)[number];

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
/** A query flag: exactly "true" or "false"; anything else stays as given and fails @IsBoolean. */
const queryFlag = ({ value }: TransformFnParams): unknown => value === 'true' ? true : value === 'false' ? false : value;

/**
 * POST ehr/visit-queue/check-in. Exactly one of:
 * - `matchRef`: a match reference from this member's own staff patient search
 *   (POST identity/patient-search, direct care) in the last 10 minutes; or
 * - `patientId`: the id (a UUID) of a patient already this facility's own
 *   (registered at this desk, or a consented visit here in the last 24 months).
 * Never a Health ID. The server checks both; anything else is refused.
 */
export class CheckInToVisitQueueDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'matchRef must be the match reference a patient search gave' })
  matchRef?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  patientId?: string;
}

/** GET ehr/visit-queue?includeClosedToday=true also lists rows closed today (Lagos day). */
export class ListVisitQueueQueryDto {
  @IsOptionalButNotNull()
  @Transform(queryFlag)
  @IsBoolean()
  includeClosedToday?: boolean;
}

/**
 * PATCH ehr/visit-queue/:entryId. `expectedRowVersion` is the card's
 * `rowVersion`. At least one change:
 * - `stage`: waiting, triage, ready, with_clinician; finished, left or
 *   cancelled close the row;
 * - `triageLevel`: 1 (most urgent) to 5, or null to clear it;
 * - `assignedMembershipId`: a nurse, clinician or doctor of this facility
 *   (their membership id), or null to clear it.
 */
export class UpdateVisitQueueEntryDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptionalButNotNull()
  @IsIn(VISIT_QUEUE_STAGES)
  stage?: VisitQueueStage;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  triageLevel?: number | null;

  @IsOptional()
  @IsUUID('all')
  assignedMembershipId?: string | null;
}
