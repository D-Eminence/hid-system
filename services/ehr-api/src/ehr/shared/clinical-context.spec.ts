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

});

describe('timeline cursors', () => {
  // A cursor names the last row of a page at the sort key's full (microsecond)
  // precision, and the list and scope it was issued for. Postgres keeps
  // microseconds; a cursor cut to milliseconds made the next page skip the
  // rows that share the last row's millisecond and sort after it.
  const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const notes = { list: 'ehr.clinical-notes', patientId: '10000000-0000-4000-8000-000000000001',
    encounterId: '20000000-0000-4000-8000-000000000001' };
  const row = (n: number, cursorAt: string) => ({ id: id(n), createdAt: new Date(cursorAt), cursorAt });
  const raw = (cursor: string | null) => JSON.parse(Buffer.from(cursor ?? '', 'base64url').toString('utf8'));
  const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const refused = (value: string, scope = notes) => {
    try {
      decodeTimelineCursor(value, scope);
    } catch (error) {
      return error instanceof DomainProblem ? [error.getStatus(), error.code] : error;
    }
    return 'accepted';
  };

  it('keeps the last row\'s sort key to the microsecond', () => {
    const page = timelinePage([row(3, '2026-10-11T08:00:00.124000Z'), row(2, '2026-10-11T08:00:00.123456Z'),
      row(1, '2026-10-11T08:00:00.123400Z')], 2, notes);
    expect(decodeTimelineCursor(page.nextCursor ?? undefined, notes)).toEqual({ sortAt: '2026-10-11T08:00:00.123456Z', id: id(2) });
  });

  it('splits rows tied to the microsecond by id', () => {
    const page = timelinePage([row(3, '2026-10-11T08:00:00.123456Z'), row(2, '2026-10-11T08:00:00.123456Z'),
      row(1, '2026-10-11T08:00:00.123456Z')], 2, notes);
    expect(page.items.map((item) => item.id)).toEqual([id(3), id(2)]);
    expect(decodeTimelineCursor(page.nextCursor ?? undefined, notes)).toEqual({ sortAt: '2026-10-11T08:00:00.123456Z', id: id(2) });
  });

  it('returns the rows without the cursor column, and no cursor after the last page', () => {
    const page = timelinePage([row(1, '2026-10-11T08:00:00.123456Z')], 2, notes);
    expect(page.items).toEqual([{ id: id(1), createdAt: new Date('2026-10-11T08:00:00.123Z') }]);
    expect(page.nextCursor).toBeNull();
  });

  it.each(['2026-10-11T08:00:00.000000Z', '2026-10-11T08:00:00.000001Z', '2026-10-11T08:00:00.999999Z',
    '0001-01-01T00:00:00.000000Z', '2028-02-29T23:59:59.999999Z'])('round-trips %s', (cursorAt) => {
    const page = timelinePage([row(2, cursorAt), row(1, cursorAt)], 1, notes);
    expect(decodeTimelineCursor(page.nextCursor ?? undefined, notes)).toEqual({ sortAt: cursorAt, id: id(2) });
  });

  it('refuses a cursor issued for another list, encounter or patient', () => {
    const cursor = timelinePage([row(2, '2026-10-11T08:00:00.123456Z'), row(1, '2026-10-11T08:00:00.123456Z')], 1, notes).nextCursor ?? '';
    expect(refused(cursor, { ...notes, list: 'ehr.diagnoses' })).toEqual([400, 'INVALID_CURSOR']);
    expect(refused(cursor, { ...notes, encounterId: '20000000-0000-4000-8000-000000000002' })).toEqual([400, 'INVALID_CURSOR']);
    expect(refused(cursor, { ...notes, patientId: '10000000-0000-4000-8000-000000000002' })).toEqual([400, 'INVALID_CURSOR']);
    expect(refused(cursor)).toBe('accepted');
  });

  it('refuses every cursor that is not exactly as issued, including the earlier millisecond format', () => {
    const issued = timelinePage([row(2, '2026-10-11T08:00:00.123456Z'), row(1, '2026-10-11T08:00:00.123456Z')], 1, notes).nextCursor ?? '';
    const { v, l, f, t, i } = raw(issued);
    const variants: Array<[string, string]> = [
      ['the earlier { sortAt, id } format', encode({ sortAt: '2026-10-11T08:00:00.123Z', id: id(2) })],
      ['a millisecond timestamp', encode({ v, l, f, t: '2026-10-11T08:00:00.123Z', i })],
      ['seven fraction digits', encode({ v, l, f, t: '2026-10-11T08:00:00.1234567Z', i })],
      ['an offset instead of Z', encode({ v, l, f, t: '2026-10-11T08:00:00.123456+00:00', i })],
      ['30 February', encode({ v, l, f, t: '2026-02-30T08:00:00.123456Z', i })],
      ['year 0000', encode({ v, l, f, t: '0000-10-11T08:00:00.123456Z', i })],
      ['an upper-case id', encode({ v, l, f, t, i: String(i).toUpperCase() })],
      ['another version', encode({ v: 2, l, f, t, i })],
      ['an extra field', encode({ v, l, f, t, i, x: 1 })],
      ['reordered fields', encode({ i, t, f, l, v })],
      ['padding', `${issued}=`],
      ['a character outside base64url', `${issued.slice(0, -1)}+`],
      ['a JSON array', encode([v, l, f, t, i])],
      ['null', encode(null)],
    ];
    for (const [label, value] of variants) expect([label, refused(value)]).toEqual([label, [400, 'INVALID_CURSOR']]);
  });

  it('never issues a cursor that would lose precision', () => {
    expect(() => timelinePage([row(2, '2026-10-11T08:00:00.123Z'), row(1, '2026-10-11T08:00:00.123Z')], 1, notes)).toThrow();
  });
});
