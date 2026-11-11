import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLabImportDto, ListLabImportsQueryDto } from './create-lab-import.dto';

describe('CreateLabImportDto', () => {
  const valid = { patientId: '10000000-0000-4000-8000-000000000001',
    sourceDocumentId: '10000000-0000-4000-8000-000000000002', reason: 'Reviewed external report import',
    purpose: 'direct-care', observations: [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL' }] };

  it('accepts bounded imported external observations using canonical UUID references', async () => {
    expect(await validate(plainToInstance(CreateLabImportDto, valid))).toHaveLength(0);
  });

  it('rejects noncanonical patient references and missing observations', async () => {
    const errors = await validate(plainToInstance(CreateLabImportDto, { ...valid, patientId: 'HID-123', observations: [] }));
    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining(['patientId', 'observations']));
  });
});

describe('ListLabImportsQueryDto', () => {
  const patientId = '10000000-0000-4000-8000-000000000001';
  const fields = async (query: Record<string, unknown>) =>
    (await validate(plainToInstance(ListLabImportsQueryDto, query))).map((error) => error.property);

  it('accepts a canonical patient id, a cursor and a page size from 1 to 50 sent as query strings', async () => {
    expect(await fields({ patientId })).toEqual([]);
    expect(await fields({ patientId, cursor: '10000000-0000-4000-8000-000000000002', limit: '50' })).toEqual([]);
    expect(plainToInstance(ListLabImportsQueryDto, { patientId, limit: '7' }).limit).toBe(7);
  });

  it('refuses a missing or non-UUID patient, a malformed cursor and an out-of-bounds page size', async () => {
    expect(await fields({})).toEqual(['patientId']);
    expect(await fields({ patientId: 'HID-123' })).toEqual(['patientId']);
    expect(await fields({ patientId, cursor: 'x' })).toEqual(['cursor']);
    for (const limit of ['0', '51', '-1', '1.5', 'ten', '1e2']) expect(await fields({ patientId, limit })).toEqual(['limit']);
  });
});
