import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsObject, ValidateNested } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';
import {
  CreateClinicalNoteDto,
  CreateDiagnosisDto,
  CreateDiagnosisNameOnlyDto,
  CreateEncounterDto,
  CreateVitalDto,
} from '../shared/clinical.dto';

/** EHR-C5: at most this many diagnoses in one consultation. */
export const CONSULTATION_MAX_DIAGNOSES = 20;

/**
 * EHR-C5 (Akos N-5): one call that saves a consultation, all or nothing.
 * Each part is the body of its own route, with the same validation:
 * - `visit`: the visit create body. The consultation always uses the open
 *   visit today (EHR-C1), so `reuseOpenVisit` may be left out or be `true`.
 * - `note`: the clinical note create body (draft or signed). Optional.
 * - `vitals`: the vitals create body. Optional.
 * - `diagnoses`: diagnosis create bodies, at most 20. Optional.
 * No prescriptions or lab requests here (they keep their own routes).
 */
export class CreateConsultationDto {
  @IsObject()
  @ValidateNested()
  @Type(() => CreateEncounterDto)
  visit!: CreateEncounterDto;

  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateClinicalNoteDto)
  note?: CreateClinicalNoteDto;

  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateVitalDto)
  vitals?: CreateVitalDto;

  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(CONSULTATION_MAX_DIAGNOSES)
  @ValidateNested({ each: true })
  @Type(() => CreateDiagnosisDto)
  diagnoses?: CreateDiagnosisDto[];
}

/**
 * The same body while DIAGNOSIS_NAME_ONLY_ENABLED is on (0156): each diagnosis
 * may leave out its code pair, both or neither (CreateDiagnosisNameOnlyDto;
 * DIAGNOSIS_CODE_INCOMPLETE otherwise, CreateConsultationBodyPipe). Off, the
 * body is checked against CreateConsultationDto as before. The four parts and
 * their checks are CreateConsultationDto's, in the same order.
 */
export class CreateConsultationNameOnlyDto {
  @IsObject()
  @ValidateNested()
  @Type(() => CreateEncounterDto)
  visit!: CreateEncounterDto;

  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateClinicalNoteDto)
  note?: CreateClinicalNoteDto;

  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateVitalDto)
  vitals?: CreateVitalDto;

  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(CONSULTATION_MAX_DIAGNOSES)
  @ValidateNested({ each: true })
  @Type(() => CreateDiagnosisNameOnlyDto)
  diagnoses?: CreateDiagnosisNameOnlyDto[];
}

/** The body a consultation carries: today's, or (0156, while on) with diagnoses by name only. */
export type CreateConsultationInput = CreateConsultationDto | CreateConsultationNameOnlyDto;
