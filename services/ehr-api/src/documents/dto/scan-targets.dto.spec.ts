import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListScanTargetsDto } from './list-scan-targets.dto';
import { ResolveScanTargetDto } from './resolve-scan-target.dto';

const target = {
  storageBucket: 'hid-staging-documents-a1b2c3',
  storageKey: 'clinical/objects/0c9e8a7b-6d5c-4b3a-9f8e-7d6c5b4a3f2e',
  objectVersionId: '3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nr8X8gdRQBpUMLUo',
};
const fields = async (cls: new () => object, value: object) =>
  (await validate(plainToInstance(cls, value), { whitelist: true, forbidNonWhitelisted: true }))
    .map(error => error.property).sort();

describe('ResolveScanTargetDto', () => {
  it('accepts an object under clinical/objects/ in a named bucket', async () => {
    expect(await fields(ResolveScanTargetDto, target)).toEqual([]);
  });

  it.each([
    ['a key outside clinical/objects/', { storageKey: 'migration-quarantine/abc' }, 'storageKey'],
    ['GuardDuty\'s validation object', { storageKey: 'malware-protection-resource-validation-object' }, 'storageKey'],
    ['a key with a suffix', { storageKey: `${target.storageKey}/x` }, 'storageKey'],
    ['an upper-case UUID', { storageKey: target.storageKey.toUpperCase().replace('CLINICAL/OBJECTS', 'clinical/objects') }, 'storageKey'],
    ['a bucket with upper case', { storageBucket: 'HID-documents' }, 'storageBucket'],
    ['a bucket too short', { storageBucket: 'ab' }, 'storageBucket'],
    ['no version', { objectVersionId: '   ' }, 'objectVersionId'],
    ['a version over 1024 characters', { objectVersionId: 'v'.repeat(1025) }, 'objectVersionId'],
  ])('refuses %s', async (_name, change, field) => {
    expect(await fields(ResolveScanTargetDto, { ...target, ...change })).toEqual([field]);
  });

  it('refuses extra fields', async () => {
    expect(await fields(ResolveScanTargetDto, { ...target, documentId: 'x' })).toEqual(['documentId']);
  });
});

describe('ListScanTargetsDto', () => {
  it('takes the two query values as integers', async () => {
    const query = plainToInstance(ListScanTargetsDto, { olderThanSeconds: '900', limit: '50' });
    expect(query).toMatchObject({ olderThanSeconds: 900, limit: 50 });
    expect(await validate(query)).toHaveLength(0);
    expect(await fields(ListScanTargetsDto, { olderThanSeconds: '0', limit: '100' })).toEqual([]);
  });

  it.each([
    [{ olderThanSeconds: '900' }, ['limit']],
    [{ limit: '50' }, ['olderThanSeconds']],
    [{ olderThanSeconds: '-1', limit: '50' }, ['olderThanSeconds']],
    [{ olderThanSeconds: '31536001', limit: '50' }, ['olderThanSeconds']],
    [{ olderThanSeconds: '9.5', limit: '50' }, ['olderThanSeconds']],
    [{ olderThanSeconds: '1e3', limit: '50' }, ['olderThanSeconds']],
    [{ olderThanSeconds: '900', limit: '0' }, ['limit']],
    [{ olderThanSeconds: '900', limit: '101' }, ['limit']],
    [{ olderThanSeconds: ['900', '1'], limit: '50' }, ['olderThanSeconds']],
  ])('refuses %j', async (query, expected) => {
    expect(await fields(ListScanTargetsDto, query)).toEqual(expected);
  });
});
