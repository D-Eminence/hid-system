import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID,
  Length, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
const booleanQuery = ({ value }: TransformFnParams): unknown => value === 'true' ? true : value === 'false' ? false : value;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const DOSE_OUTCOMES = ['given', 'held', 'refused', 'omitted', 'not_available'] as const;
export const DOSE_REASON_CODES = ['clinical_decision', 'awaiting_result', 'nil_by_mouth', 'patient_away', 'no_access',
  'other', 'not_in_stock', 'awaiting_pharmacy', 'patient_to_buy', 'patient_refused'] as const;
export const SUPPLY_SOURCES = ['ward_stock', 'patient_own', 'bought_outside'] as const;
export const FLUID_KINDS = ['oral', 'iv', 'enteral_tube', 'blood_product', 'other', 'urine', 'vomit', 'drain', 'stool',
  'tube_aspirate', 'blood_loss'] as const;
export const SHIFT_DUTIES = ['nurse', 'nurse_in_charge', 'on_call_doctor'] as const;

/** Route 2: the observation chart's window (up to 7 days) and view. */
export class ObservationChartQueryDto {
  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  to?: string;

  @IsOptionalButNotNull()
  @IsIn(['all', 'hourly'])
  view?: 'all' | 'hourly';
}

/** Route 4: the stay's medicine round (default: the last 24 hours and the next 24). */
export class MedicineRoundQueryDto {
  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  to?: string;
}

/** Route 5: the ward's round. */
export class WardRoundQueryDto {
  @IsUUID()
  wardId!: string;

  @IsOptionalButNotNull()
  @IsIn(['now', 'next_4h'])
  window?: 'now' | 'next_4h';
}

export class DoseAmountDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity!: number;

  @Transform(trim)
  @IsString()
  @Length(1, 80)
  unit!: string;
}

/** Route 6: a dose recorded against an order (Q196 A, Q198 A, Q-NUR-9 to Q-NUR-12). */
export class RecordDoseDto {
  @IsUUID()
  prescriptionId!: string;

  @IsOptional()
  @IsDateString({ strict: true })
  scheduledFor?: string | null;

  @IsIn(DOSE_OUTCOMES)
  outcome!: (typeof DOSE_OUTCOMES)[number];

  @IsDateString({ strict: true })
  givenAt!: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DoseAmountDto)
  dose?: DoseAmountDto | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  route?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(8, 300)
  doseDiffersReason?: string | null;

  @IsOptional()
  @IsIn(DOSE_REASON_CODES)
  reasonCode?: (typeof DOSE_REASON_CODES)[number] | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  reasonText?: string | null;

  @IsOptional()
  @IsIn(SUPPLY_SOURCES)
  supplySource?: (typeof SUPPLY_SOURCES)[number] | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(8, 300)
  overrideReason?: string | null;

  @IsOptional()
  @IsIn(['started', 'stopped'])
  infusionAction?: 'started' | 'stopped' | null;
}

/** Routes 7 and 13: a dose or fluid entry marked entered in error. */
export class NursingEnteredInErrorDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @Transform(trim)
  @IsString()
  @Length(8, 500)
  reason!: string;
}

/** Route 8: the task list. */
export class TaskListQueryDto {
  @IsOptionalButNotNull()
  @IsUUID()
  wardId?: string;

  @IsOptionalButNotNull()
  @IsUUID()
  admissionId?: string;

  @IsOptionalButNotNull()
  @IsIn(['open', 'done'])
  status?: 'open' | 'done';

  @IsOptionalButNotNull()
  @Transform(booleanQuery)
  @IsBoolean()
  mine?: boolean;
}

/** Route 9: a new task. */
export class CreateTaskDto {
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsDateString({ strict: true })
  dueAt!: string;

  @IsOptionalButNotNull()
  @IsUUID()
  assignedMembershipId?: string;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(1)
  @Max(168)
  repeatEveryHours?: number;
}

/** Route 10: start. */
export class TaskVersionDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;
}

/** Route 10: complete, with the completion record (chart content). */
export class CompleteTaskDto extends TaskVersionDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  completionRecord?: string;
}

/** Route 10: cancel. */
export class CancelTaskDto extends TaskVersionDto {
  @Transform(trim)
  @IsString()
  @Length(8, 300)
  reason!: string;
}

/** Route 10: reassign or move. */
export class UpdateTaskDto extends TaskVersionDto {
  @IsOptionalButNotNull()
  @IsUUID()
  assignedMembershipId?: string;

  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  dueAt?: string;
}

/** Route 11: a fluid day (Q-NUR-15 A). */
export class FluidDayQueryDto {
  @IsOptionalButNotNull()
  @Matches(DATE)
  day?: string;
}

/** Route 12: a fluid entry. */
export class FluidEntryDto {
  @IsIn(['in', 'out'])
  direction!: 'in' | 'out';

  @IsIn(FLUID_KINDS)
  kind!: (typeof FLUID_KINDS)[number];

  @IsOptionalButNotNull()
  @IsInt()
  @Min(1)
  @Max(10_000)
  volumeMl?: number;

  @IsOptionalButNotNull()
  @IsBoolean()
  notMeasured?: boolean;

  @IsDateString({ strict: true })
  recordedAt!: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  note?: string;
}

/** Route 14: a clinical shift (Lagos times; it may cross midnight). */
export class CreateShiftDto {
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  name!: string;

  @Matches(CLOCK)
  startsAt!: string;

  @Matches(CLOCK)
  endsAt!: string;
}

export class UpdateShiftDto extends TaskVersionDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  name?: string;

  @IsOptionalButNotNull()
  @IsBoolean()
  active?: boolean;
}

/** Route 15: a ward's list for a shift of a Lagos date. */
export class AssignmentsQueryDto {
  @Matches(DATE)
  date!: string;

  @IsUUID()
  shiftId!: string;

  @IsUUID()
  wardId!: string;
}

export class AssignmentDto {
  @IsUUID()
  membershipId!: string;

  @IsIn(SHIFT_DUTIES)
  duty!: (typeof SHIFT_DUTIES)[number];

  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID(undefined, { each: true })
  admissionIds?: string[];
}

export class SetAssignmentsDto extends AssignmentsQueryDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => AssignmentDto)
  assignments!: AssignmentDto[];
}

/** Route 16: the handover sheet. */
export class HandoverQueryDto extends AssignmentsQueryDto {}

/** Route 17: a patient's handover note on a draft sheet. */
export class HandoverNoteDto {
  @IsOptionalButNotNull()
  @IsInt()
  @Min(1)
  expectedRowVersion?: number;

  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  note!: string;

  @IsOptionalButNotNull()
  @IsBoolean()
  watch?: boolean;
}

/** Route 17 on a sheet not made yet: the ward, date and shift. */
export class NewHandoverNoteDto extends HandoverNoteDto {
  @IsUUID()
  wardId!: string;

  @Matches(DATE)
  date!: string;

  @IsUUID()
  shiftId!: string;
}

/** Route 18: give and accept. */
export class HandoverStepDto extends TaskVersionDto {}
