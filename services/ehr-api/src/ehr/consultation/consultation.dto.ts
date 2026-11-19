import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsObject, ValidateNested } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';
import {
  CreateClinicalNoteDto,
  CreateDiagnosisDto,
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
