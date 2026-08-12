import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateDiagnosisDto,
  CreateEncounterDto,
  CreateLabRequestDto,
  CreatePrescriptionDto,
  CreateVitalDto,
  TimelineQueryDto,
  UpdateClinicalNoteDto,
  UpdateDiagnosisDto,
  UpdateEncounterDto,
  UpdateLabRequestDto,
  UpdatePrescriptionDto,
  VitalMeasurementsDto,
} from './clinical.dto';

type DtoConstructor = new () => object;

const OPTIONAL_FIELDS: readonly [DtoConstructor, readonly string[]][] = [
  [TimelineQueryDto, ['limit', 'cursor']],
  [CreateEncounterDto, ['encounterNumber', 'endedAt', 'chiefComplaint']],
  [UpdateEncounterDto, ['status', 'endedAt', 'chiefComplaint']],
  [UpdateClinicalNoteDto, ['title', 'status']],
  [VitalMeasurementsDto, [
    'heightCm', 'weightKg', 'temperatureC', 'pulseBpm', 'respiratoryRate',
    'systolicMmhg', 'diastolicMmhg', 'oxygenSaturationPercent',
  ]],
  [CreateVitalDto, ['source']],
  [CreateDiagnosisDto, ['onsetAt', 'abatementAt', 'notes']],
  [UpdateDiagnosisDto, ['clinicalStatus', 'verificationStatus', 'abatementAt', 'notes']],
  [CreatePrescriptionDto, [
    'medicationCodeSystem', 'medicationCode', 'doseQuantity', 'doseUnit',
    'routeCode', 'startsOn', 'endsOn',
  ]],
  [UpdatePrescriptionDto, ['status', 'frequency', 'instructions', 'endsOn']],
  [CreateLabRequestDto, ['priority', 'specimenTypeCode', 'clinicalInformation', 'externalOrderReference']],
  [UpdateLabRequestDto, ['priority', 'status', 'clinicalInformation']],
];

describe('clinical DTO optional-field semantics', () => {
  it.each(OPTIONAL_FIELDS)('%p rejects explicit null for every optional field', async (Dto, fields) => {
    for (const field of fields) {
      const instance = plainToInstance(Dto, { [field]: null });
      const errors = await validate(instance);
      expect(errors.some((error) => error.property === field)).toBe(true);
    }
  });

  it('continues to accept absent optional fields', async () => {
    const instance = plainToInstance(VitalMeasurementsDto, {});
    expect(await validate(instance)).toHaveLength(0);
  });
});
