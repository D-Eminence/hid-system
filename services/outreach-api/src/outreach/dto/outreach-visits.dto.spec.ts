import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { lagosToday } from '../lagos-date';
import { CreateVisitDto } from './create-visit.dto';
import { LinkExistingPatientDto } from './link-existing-patient.dto';
import { LinkPreviewDto } from './link-preview.dto';

const strict = { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true };
const fields = async (cls: new () => object, value: object) =>
  (await validate(plainToInstance(cls, value) as object, strict)).map((error) => error.property);
const patient = '123e4567-e89b-42d3-a456-426614174005';
const reason = 'Reviewed exact Identity match';

describe('LinkExistingPatientDto', () => {
  it('accepts exactly one of canonicalPatientId or healthId', async () => {
    expect(await fields(LinkExistingPatientDto, { canonicalPatientId: patient, expectedVersion: 1, reason })).toEqual([]);
    expect(await fields(LinkExistingPatientDto, { healthId: ' hid-7kq2m9xa ', expectedVersion: 1, reason })).toEqual([]);
    expect(await fields(LinkExistingPatientDto, { expectedVersion: 1, reason })).toEqual(['canonicalPatientId']);
    expect(await fields(LinkExistingPatientDto, { canonicalPatientId: patient, healthId: 'HID-7KQ2M9XA',
      expectedVersion: 1, reason })).toEqual(['healthId']);
    expect(await fields(LinkExistingPatientDto, { healthId: null, expectedVersion: 1, reason })).toEqual(['healthId']);
  });

  it('normalizes the Health ID as Identity does and refuses one Identity would refuse', async () => {
    const dto = plainToInstance(LinkExistingPatientDto, { healthId: ' hid-7kq2m9xa ', expectedVersion: 1, reason });
    expect(dto.healthId).toBe('HID-7KQ2M9XA');
    for (const healthId of ['HID-7KQ2M', 'HID-7KQ2M9XO', 'HID-7KQ2M9X1', 'NHS-7KQ2M9XA', `HID-${'A'.repeat(33)}`]) {
      expect(await fields(LinkExistingPatientDto, { healthId, expectedVersion: 1, reason })).toEqual(['healthId']);
    }
  });
});

describe('LinkPreviewDto', () => {
  it('requires one Health ID and nothing else', async () => {
    expect(await fields(LinkPreviewDto, { healthId: 'HID-7KQ2M9XA' })).toEqual([]);
    expect(await fields(LinkPreviewDto, {})).toEqual(['healthId']);
    expect(await fields(LinkPreviewDto, { healthId: 'HID-7KQ2M9XA', patientId: patient })).toEqual(['patientId']);
  });
});

describe('CreateVisitDto', () => {
  const today = lagosToday();
  const tomorrow = lagosToday(new Date(Date.now() + 86_400_000));

  it('accepts a visit today in Lagos with no follow-up', async () => {
    expect(await fields(CreateVisitDto, { kind: 'visit', occurredOn: today })).toEqual([]);
    expect(await fields(CreateVisitDto, { kind: 'referral', occurredOn: '2026-10-30', followUpOn: null,
      referredTo: 'Fictional General Hospital', notes: null })).toEqual([]);
  });

  it('refuses a future, impossible or malformed date and an unknown kind', async () => {
    expect(await fields(CreateVisitDto, { kind: 'visit', occurredOn: tomorrow })).toEqual(['occurredOn']);
    expect(await fields(CreateVisitDto, { kind: 'visit', occurredOn: '2026-02-30' })).toEqual(['occurredOn']);
    expect(await fields(CreateVisitDto, { kind: 'visit', occurredOn: '30/10/2026' })).toEqual(['occurredOn']);
    expect(await fields(CreateVisitDto, { kind: 'home', occurredOn: today })).toEqual(['kind']);
  });

  it('requires followUpOn after occurredOn', async () => {
    expect(await fields(CreateVisitDto, { kind: 'follow_up', occurredOn: '2026-10-30', followUpOn: '2026-10-30' }))
      .toEqual(['followUpOn']);
    expect(await fields(CreateVisitDto, { kind: 'follow_up', occurredOn: '2026-10-30', followUpOn: '2026-11-01' }))
      .toEqual([]);
  });

  it('bounds referredTo and notes, keeps line breaks and treats blanks as none', async () => {
    expect(await fields(CreateVisitDto, { kind: 'referral', occurredOn: today, referredTo: 'X' })).toEqual(['referredTo']);
    expect(await fields(CreateVisitDto, { kind: 'referral', occurredOn: today, referredTo: 'R'.repeat(161) }))
      .toEqual(['referredTo']);
    expect(await fields(CreateVisitDto, { kind: 'visit', occurredOn: today, notes: 'n'.repeat(1001) })).toEqual(['notes']);
    expect(await fields(CreateVisitDto, { kind: 'visit', occurredOn: today, notes: 'one\ttwo' })).toEqual(['notes']);
    const dto = plainToInstance(CreateVisitDto, { kind: 'visit', occurredOn: today, notes: ' one\r\ntwo \n',
      referredTo: '   ' });
    expect(dto.notes).toBe('one\ntwo');
    expect(dto.referredTo).toBeNull();
    expect(await validate(dto, strict)).toEqual([]);
  });
});
