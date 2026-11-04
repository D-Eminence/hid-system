import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';

/** Why a "Discussed with the patient" mark is withdrawn (0121 D-D). */
export const WITHDRAWAL_REASON_CODES = ['marked_in_error', 'not_yet_discussed', 'wrong_patient', 'other'] as const;
export type WithdrawalReasonCode = (typeof WITHDRAWAL_REASON_CODES)[number];

/** POST lab/patients/:patientId/results/:resultId/discussion: the released version the clinician discussed. */
export class RecordResultDiscussionDto {
  @IsInt() @Min(1)
  resultVersion!: number;
}

/**
 * POST .../discussion/withdrawal. The reason is stored only in the Lab's
 * event table; it is never audited, logged or answered (only its code is).
 */
export class WithdrawResultDiscussionDto {
  @IsInt() @Min(1)
  resultVersion!: number;

  @IsIn(WITHDRAWAL_REASON_CODES)
  reasonCode!: WithdrawalReasonCode;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @Length(8, 500)
  reason!: string;
}
