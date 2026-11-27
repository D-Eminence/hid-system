import { Transform, Type, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import type { PurposeOfUse } from '../common/request-context';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

export const PATIENT_MERGE_STATUSES = ['requested', 'merged', 'undone', 'refused', 'cancelled'] as const;
export type PatientMergeStatus = typeof PATIENT_MERGE_STATUSES[number];
export const PATIENT_MERGE_VIEWS = ['mine', 'facility'] as const;
export type PatientMergeView = typeof PATIENT_MERGE_VIEWS[number];

/**
 * POST identity/patient-merges: ask to merge. An empty matchRef or one over 200
 * characters is 400 VALIDATION_FAILED here; any other string goes to the
 * database, where one that is not this member's own direct-care search in the
 * last 10 minutes (malformed included) is 403 MERGE_SEARCH_FIRST, one answer
 * for all.
 */
export class RequestPatientMergeDto {
  @IsUUID()
  sourcePatientId!: string;

  @IsString() @Length(1, 200)
  targetMatchRef!: string;

  @Transform(trim) @IsString() @Length(8, 500)
  reason!: string;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}

/** GET identity/patient-merges. */
export class ListPatientMergesDto {
  @IsIn(PATIENT_MERGE_VIEWS)
  view!: PatientMergeView;

  @IsOptional() @IsIn(PATIENT_MERGE_STATUSES)
  status?: PatientMergeStatus;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{16,200}$/)
  cursor?: string;
}

/** POST .../refuse: an approver's reason and the request's version. */
export class RefusePatientMergeDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @Transform(trim) @IsString() @Length(8, 500)
  reason!: string;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}

/** POST .../cancel and POST .../approve: the request's version. */
export class VersionedPatientMergeDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}

/** POST .../undo (ID-8b): the request's version and the reason. */
export class UndoPatientMergeDto extends RefusePatientMergeDto {}
