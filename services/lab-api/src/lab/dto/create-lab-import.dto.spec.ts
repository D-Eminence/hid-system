import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLabImportDto } from './create-lab-import.dto';

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
