import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
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
import { AllergyAcknowledgementDto } from '../allergies/allergies.dto';

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

/**
 * FR-1 and Q105 (18 Nov 2026): the reason may be left out, but only where the
 * service can record a fixed reason instead (the first signature of a draft
 * note, the first activation of a draft prescription or lab request, starting
 * or finishing a visit, and edits to a draft note, prescription or lab
 * request that was never signed or active; see shared/change-reason.ts).
 * Every other change without a reason answers 400 CHANGE_REASON_REQUIRED
 * ("Please say why you are changing this."). When given, the same rules as
 * VersionedUpdateDto apply (trimmed, 3 to 500 characters, never null).
 */
export class OptionalReasonVersionedUpdateDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  changeReason?: string;
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

  /**
   * EHR-C1: true asks for this patient's open visit today at this facility
   * (planned, in progress or on hold, started on today's Lagos calendar day)
   * instead of a new one; a new visit is created only when there is none.
   * Only with status planned or in_progress. Absent or false: as before.
   */
  @IsOptionalButNotNull()
  @IsBoolean()
  reuseOpenVisit?: boolean;
}

/** Q105: the reason may be left out to start or finish a visit (see shared/change-reason.ts). */
export class UpdateEncounterDto extends OptionalReasonVersionedUpdateDto {
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

export class UpdateClinicalNoteDto extends OptionalReasonVersionedUpdateDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 240)
  title?: string;

  @IsOptionalButNotNull()
  @IsEnum(NoteStatus)
  status?: NoteStatus;
}

/** Q105: the reason may be left out for new text on a draft that was never signed (see shared/change-reason.ts). */
export class CreateClinicalNoteRevisionDto extends OptionalReasonVersionedUpdateDto {
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

  /**
   * 0117: sent only after an allergy warning (409 ALLERGY_ACKNOWLEDGEMENT_REQUIRED
   * or the allergy check), with the prescriber's reason to go ahead and the
   * warning's token.
   */
  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => AllergyAcknowledgementDto)
  allergyAcknowledgement?: AllergyAcknowledgementDto;
}

/** How urgent a prescription is (0125): the Lab request priorities. */
export enum PrescriptionPriority {
  Routine = 'routine',
  Urgent = 'urgent',
  Asap = 'asap',
  Stat = 'stat',
}

/** The forms a prescriber chooses from (0125), as the pharmacy queue draws them. */
export enum PrescriptionDoseForm {
  Tablet = 'tablet',
  Capsule = 'capsule',
  Liquid = 'liquid',
  Injection = 'injection',
  Cream = 'cream',
  Inhaler = 'inhaler',
  Drops = 'drops',
  Other = 'other',
}

export enum PrescriptionDurationUnit {
  Day = 'day',
  Week = 'week',
  Month = 'month',
}

/**
 * A new prescription with the optional dispensing details (0125): its
 * priority, its strength and form as the prescriber means them, how long it
 * is for, and how much to hand over (the pharmacist still confirms what is
 * dispensed). Set at creation only: UpdatePrescriptionDto has none of them.
 * durationValue and durationUnit go together, as do quantityToDispense and
 * quantityUnit (PrescriptionsService.create). Used only while
 * PRESCRIPTION_DISPENSING_DETAILS_ENABLED is on (CreatePrescriptionBodyPipe);
 * off, a body is checked against CreatePrescriptionDto as before, so each of
 * these fields is refused like any unknown field.
 */
export class CreatePrescriptionWithDetailsDto extends CreatePrescriptionDto {
  @IsOptionalButNotNull()
  @IsEnum(PrescriptionPriority)
  priority?: PrescriptionPriority;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  strength?: string;

  @IsOptionalButNotNull()
  @IsEnum(PrescriptionDoseForm)
  doseForm?: PrescriptionDoseForm;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(1)
  @Max(3650)
  durationValue?: number;

  @IsOptionalButNotNull()
  @IsEnum(PrescriptionDurationUnit)
  durationUnit?: PrescriptionDurationUnit;

  /** ehr.prescriptions.quantity_to_dispense is numeric(12,4). */
  @IsOptionalButNotNull()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(99_999_999.9999)
  quantityToDispense?: number;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  quantityUnit?: string;
}

/**
 * ORD-12 (refills, 0152): how many times the prescription may be dispensed
 * again after the first fill, 0-11, at this hospital's own pharmacy. Left out
 * means none (stored as null, as every prescription written before 0152); an
 * explicit null, a fraction or a number outside 0-11 is refused. Set at
 * creation only: UpdatePrescriptionDto has no such field, so a PATCH naming it
 * is refused like any unknown field. Used only while
 * PRESCRIPTION_REFILLS_ENABLED is on (CreatePrescriptionBodyPipe), with or
 * without the 0125 details.
 */
export class CreatePrescriptionWithRefillsDto extends CreatePrescriptionDto {
  @IsOptionalButNotNull()
  @IsInt()
  @Min(0)
  @Max(11)
  refillsAllowed?: number;
}

/** CreatePrescriptionWithDetailsDto and `refillsAllowed` (both settings on); see CreatePrescriptionWithRefillsDto. */
export class CreatePrescriptionWithDetailsAndRefillsDto extends CreatePrescriptionWithDetailsDto {
  @IsOptionalButNotNull()
  @IsInt()
  @Min(0)
  @Max(11)
  refillsAllowed?: number;
}

export class UpdatePrescriptionDto extends OptionalReasonVersionedUpdateDto {
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

  /**
   * 0117: on Activate or Resume, sent only after an allergy warning (409
   * ALLERGY_ACKNOWLEDGEMENT_REQUIRED or the allergy check), with the
   * prescriber's reason and the warning's token.
   */
  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => AllergyAcknowledgementDto)
  allergyAcknowledgement?: AllergyAcknowledgementDto;
}

export class AcceptPrescriptionForPharmacyDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @Transform(trim)
  @IsString()
  @Length(8, 500)
  reason!: string;

  /**
   * 0117: sent only after an allergy warning on the hand-off (409
   * ALLERGY_ACKNOWLEDGEMENT_REQUIRED or the allergy check), with the reason to
   * go ahead and the warning's token.
   */
  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => AllergyAcknowledgementDto)
  allergyAcknowledgement?: AllergyAcknowledgementDto;
}

/** Sends an active lab request, at the version the client last read, to Lab. */
export class SendLabRequestToLabDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;
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

export class UpdateLabRequestDto extends OptionalReasonVersionedUpdateDto {
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
