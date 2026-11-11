import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendOrderRouteDto } from '../order-routes/dto/order-route.dto';
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
    'routeCode', 'startsOn', 'endsOn', 'allergyAcknowledgement',
  ]],
  [UpdatePrescriptionDto, ['status', 'frequency', 'instructions', 'endsOn', 'allergyAcknowledgement']],
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

describe('the allergy acknowledgement through the ValidationPipe (0117)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true });
  const warningToken = 'a'.repeat(64);
  const bodies: [new () => object, Record<string, unknown>][] = [
    [CreatePrescriptionDto, { medicationDisplay: 'Amoxicillin 500 mg', frequency: 'Three times daily', instructions: 'After food',
      status: 'active' }],
    [UpdatePrescriptionDto, { expectedRowVersion: 1, changeReason: 'Ready to give', status: 'active' }],
    [SendOrderRouteDto, { expectedRowVersion: 1, receivingFacilityId: '123e4567-e89b-42d3-a456-426614174007',
      patientAgreed: true, attestationTextVersion: 'order-route-prescription-attestation-v1' }],
  ];
  const run = (metatype: new () => object, body: Record<string, unknown>, allergyAcknowledgement: unknown) =>
    pipe.transform({ ...body, allergyAcknowledgement }, { type: 'body', metatype });

  it.each(bodies)('%p refuses only a non-object or non-string parts; the reason and token rules answer the 409', async (metatype, body) => {
    for (const acknowledgement of [
      'yes', 7, [], { reason: 7, warningToken }, { reason: 'Tolerated amoxicillin in 2024', warningToken: 7 },
      { reason: null, warningToken }, { reason: 'Tolerated amoxicillin in 2024', warningToken: null },
      { reason: 'x'.repeat(2001), warningToken }, { reason: 'Tolerated amoxicillin in 2024', warningToken: 'a'.repeat(201) },
      { reason: 'Tolerated amoxicillin in 2024', warningToken, extra: true },
    ]) {
      await expect(run(metatype, body, acknowledgement)).rejects.toMatchObject({ status: 400 });
    }
    // Reaches the allergy check at prescribing, which names what failed (prescription-allergy-gate.ts).
    for (const acknowledgement of [
      {}, { reason: '   ', warningToken }, { reason: 'ok', warningToken }, { reason: '1234567890', warningToken },
      { reason: 'x'.repeat(501), warningToken }, { reason: 'Tolerated amoxicillin in 2024' },
      { reason: 'Tolerated amoxicillin in 2024', warningToken: 'not-a-token' },
    ]) {
      await expect(run(metatype, body, acknowledgement)).resolves.toMatchObject({ allergyAcknowledgement: expect.any(Object) });
    }
  });

  it.each(bodies)('%p trims the reason and keeps a two-line reason', async (metatype, body) => {
    await expect(run(metatype, body, { reason: '  Tolerated before  ', warningToken }))
      .resolves.toMatchObject({ allergyAcknowledgement: { reason: 'Tolerated before', warningToken } });
    await expect(run(metatype, body, { reason: 'Tolerated amoxicillin in 2024.\nObserve 30 minutes.', warningToken }))
      .resolves.toMatchObject({ allergyAcknowledgement: { reason: 'Tolerated amoxicillin in 2024.\nObserve 30 minutes.' } });
  });
});
