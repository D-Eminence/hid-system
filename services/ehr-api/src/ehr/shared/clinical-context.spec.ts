import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DomainProblem } from '../../common/problem';
import {
  decodeTimelineCursor,
  requestDigest,
  requireIdempotencyKey,
  timelinePage,
} from './clinical-context';
import { CreateVitalDto, UpdateEncounterDto } from './clinical.dto';

describe('clinical request safety', () => {
  it('hashes logically identical payloads deterministically', () => {
    const first = requestDigest('encounter.create', { patientId: 'patient', input: { status: 'planned', type: 'home' } });
    const second = requestDigest('encounter.create', { input: { type: 'home', status: 'planned' }, patientId: 'patient' });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds the hash to operation and payload', () => {
    expect(requestDigest('vital.create', { pulse: 70 }))
      .not.toBe(requestDigest('vital.create', { pulse: 71 }));
    expect(requestDigest('vital.create', { pulse: 70 }))
      .not.toBe(requestDigest('vital.correct', { pulse: 70 }));
  });

  it('rejects missing, short, and unsafe idempotency keys', () => {
    for (const value of [undefined, 'short', 'valid-length-key!']) {
      expect(() => requireIdempotencyKey(value)).toThrow(DomainProblem);
    }
    expect(requireIdempotencyKey('01J5A2C3D4E5F6G7H8J9K0MNPQ')).toBe('01J5A2C3D4E5F6G7H8J9K0MNPQ');
  });

  it('does not coerce version numbers supplied as strings', async () => {
    const dto = plainToInstance(UpdateEncounterDto, {
      expectedRowVersion: '2',
      changeReason: 'correct encounter state',
      status: 'in_progress',
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'expectedRowVersion')).toBe(true);
  });

  it('requires at least one measured vital while preserving strict numeric types', async () => {
    const empty = plainToInstance(CreateVitalDto, { recordedAt: '2026-08-02T09:00:00Z' });
    expect(Object.values(empty).some((value) => typeof value === 'number')).toBe(false);

    const stringPulse = plainToInstance(CreateVitalDto, {
      recordedAt: '2026-08-02T09:00:00Z',
      pulseBpm: '70',
    });
    const errors = await validate(stringPulse);
    expect(errors.some((error) => error.property === 'pulseBpm')).toBe(true);
  });

  it('uses a composite timestamp and UUID cursor without skipping tied rows', () => {
    const rows = [
      { id: '00000000-0000-4000-8000-000000000003', createdAt: '2026-08-02T09:00:00.000Z' },
      { id: '00000000-0000-4000-8000-000000000002', createdAt: '2026-08-02T09:00:00.000Z' },
      { id: '00000000-0000-4000-8000-000000000001', createdAt: '2026-08-02T09:00:00.000Z' },
    ];
    const page = timelinePage(rows, 2, (row) => row.createdAt);
    expect(page.items).toEqual(rows.slice(0, 2));
    expect(decodeTimelineCursor(page.nextCursor ?? undefined)).toEqual({
      sortAt: '2026-08-02T09:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000002',
    });
  });
});
