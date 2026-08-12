import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

export enum EncounterType {
  Ambulatory = 'ambulatory',
  Emergency = 'emergency',
  Inpatient = 'inpatient',
  Home = 'home',
  Virtual = 'virtual',
  Other = 'other',
}

export enum EncounterStatus {
  Planned = 'planned',
  InProgress = 'in_progress',
  OnHold = 'on_hold',
  Completed = 'completed',
  Cancelled = 'cancelled',
  EnteredInError = 'entered_in_error',
}

export enum NoteStatus {
  Draft = 'draft',
  Signed = 'signed',
  EnteredInError = 'entered_in_error',
}

export enum VitalSource {
  Manual = 'manual',
  Device = 'device',
  Import = 'import',
}

export enum DiagnosisClinicalStatus {
  Active = 'active',
  Recurrence = 'recurrence',
  Relapse = 'relapse',
  Inactive = 'inactive',
  Remission = 'remission',
  Resolved = 'resolved',
}

export enum DiagnosisVerificationStatus {
  Unconfirmed = 'unconfirmed',
  Provisional = 'provisional',
  Differential = 'differential',
  Confirmed = 'confirmed',
  Refuted = 'refuted',
  EnteredInError = 'entered_in_error',
}

export enum OrderStatus {
  Draft = 'draft',
  Active = 'active',
  OnHold = 'on_hold',
  Completed = 'completed',
  Cancelled = 'cancelled',
  EnteredInError = 'entered_in_error',
}

export enum LabPriority {
  Routine = 'routine',
  Urgent = 'urgent',
  Asap = 'asap',
  Stat = 'stat',
}

export class TimelineQueryDto {
  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,512}$/)
  cursor?: string;
}

export class VersionedUpdateDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @Transform(trim)
  @IsString()
  @Length(3, 500)
  changeReason!: string;
}

export class CreateEncounterDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  encounterNumber?: string;

  @IsEnum(EncounterType)
  encounterType!: EncounterType;

  @IsEnum(EncounterStatus)
  status!: EncounterStatus;

  @IsDateString({ strict: true })
  startedAt!: string;

  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  endedAt?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  chiefComplaint?: string;
}

export class UpdateEncounterDto extends VersionedUpdateDto {
  @IsOptionalButNotNull()
  @IsEnum(EncounterStatus)
  status?: EncounterStatus;

  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  endedAt?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  chiefComplaint?: string;
}

export class CreateClinicalNoteDto {
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  noteType!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 240)
  title!: string;

  @IsEnum(NoteStatus)
  status: NoteStatus = NoteStatus.Draft;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(100_000)
  content!: string;
}

export class UpdateClinicalNoteDto extends VersionedUpdateDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 240)
  title?: string;

  @IsOptionalButNotNull()
  @IsEnum(NoteStatus)
  status?: NoteStatus;
}

export class CreateClinicalNoteRevisionDto extends VersionedUpdateDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @MaxLength(100_000)
  content!: string;
}

export class VitalMeasurementsDto {
  @IsOptionalButNotNull()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(20)
  @Max(300)
  heightCm?: number;

  @IsOptionalButNotNull()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.2)
  @Max(700)
  weightKg?: number;

  @IsOptionalButNotNull()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(20)
  @Max(50)
  temperatureC?: number;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(10)
  @Max(350)
  pulseBpm?: number;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(1)
  @Max(100)
  respiratoryRate?: number;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(30)
  @Max(350)
  systolicMmhg?: number;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(10)
  @Max(250)
  diastolicMmhg?: number;

  @IsOptionalButNotNull()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  oxygenSaturationPercent?: number;
}

export class CreateVitalDto extends VitalMeasurementsDto {
  @IsDateString({ strict: true })
  recordedAt!: string;

  @IsOptionalButNotNull()
  @IsEnum(VitalSource)
  source: VitalSource = VitalSource.Manual;
}

export class CreateVitalCorrectionDto extends VersionedUpdateDto {
  @IsObject()
  @ValidateNested()
  @Type(() => VitalMeasurementsDto)
  replacementValues!: VitalMeasurementsDto;
}

export class CreateDiagnosisDto {
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  codeSystem!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  code!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 500)
  display!: string;

  @IsEnum(DiagnosisClinicalStatus)
  clinicalStatus!: DiagnosisClinicalStatus;

  @IsEnum(DiagnosisVerificationStatus)
  verificationStatus!: DiagnosisVerificationStatus;

  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  onsetAt?: string;

  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  abatementAt?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateDiagnosisDto extends VersionedUpdateDto {
  @IsOptionalButNotNull()
  @IsEnum(DiagnosisClinicalStatus)
  clinicalStatus?: DiagnosisClinicalStatus;

  @IsOptionalButNotNull()
  @IsEnum(DiagnosisVerificationStatus)
  verificationStatus?: DiagnosisVerificationStatus;

  @IsOptionalButNotNull()
  @IsDateString({ strict: true })
  abatementAt?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class CreatePrescriptionDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  medicationCodeSystem?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  medicationCode?: string;

  @Transform(trim)
  @IsString()
  @Length(1, 500)
  medicationDisplay!: string;

  @IsOptionalButNotNull()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  doseQuantity?: number;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  doseUnit?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  routeCode?: string;

  @Transform(trim)
  @IsString()
  @Length(1, 240)
  frequency!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 4000)
  instructions!: string;

  @IsOptionalButNotNull()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startsOn?: string;

  @IsOptionalButNotNull()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endsOn?: string;

  @IsEnum(OrderStatus)
  status!: OrderStatus;
}

export class UpdatePrescriptionDto extends VersionedUpdateDto {
  @IsOptionalButNotNull()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 240)
  frequency?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 4000)
  instructions?: string;

  @IsOptionalButNotNull()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endsOn?: string;
}

export class AcceptPrescriptionForPharmacyDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @Transform(trim)
  @IsString()
  @Length(8, 500)
  reason!: string;
}

export class CreateLabRequestDto {
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  testCodeSystem!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  testCode!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 500)
  testDisplay!: string;

  @IsOptionalButNotNull()
  @IsEnum(LabPriority)
  priority: LabPriority = LabPriority.Routine;

  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  specimenTypeCode?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  clinicalInformation?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  externalOrderReference?: string;
}

export class UpdateLabRequestDto extends VersionedUpdateDto {
  @IsOptionalButNotNull()
  @IsEnum(LabPriority)
  priority?: LabPriority;

  @IsOptionalButNotNull()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  clinicalInformation?: string;
}

export class ResourceParamsDto {
  @IsUUID()
  patientId!: string;

  @IsUUID()
  resourceId!: string;
}

export function hasMeasurements(value: VitalMeasurementsDto): boolean {
  return [
    value.heightCm,
    value.weightKg,
    value.temperatureC,
    value.pulseBpm,
    value.respiratoryRate,
    value.systolicMmhg,
    value.diastolicMmhg,
    value.oxygenSaturationPercent,
  ].some((measurement) => measurement !== undefined);
}
