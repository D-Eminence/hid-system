import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AcceptEhrOrderDto } from './accept-ehr-order.dto';

// EHR creates a lab request with these limits (services/ehr-api clinical.dto.ts,
// CreateLabRequestDto) and commits it before it asks Lab to accept it; the Lab
// tables allow the same lengths (0018). Lab must accept every request EHR can
// create, or the active EHR order is left without Lab work.
const limits = { testCodeSystem: 255, testCode: 100, testName: 500, clinicalIndication: 4000 } as const;

describe('AcceptEhrOrderDto', () => {
  const valid = { sourceEhrOrderId: '10000000-0000-4000-8000-000000000001', sourceEhrOrderVersion: 1,
    sourceEncounterId: '10000000-0000-4000-8000-000000000002', patientId: '10000000-0000-4000-8000-000000000003',
    orderingFacilityId: '10000000-0000-4000-8000-000000000004', testCodeSystem: 'http://loinc.org', testCode: '718-7',
    testName: 'Haemoglobin', priority: 'routine', clinicalIndication: 'Fatigue',
    requestedBy: '10000000-0000-4000-8000-000000000005', requestedAt: '2026-10-01T09:00:00.123456Z' };
  const failed = async (input: Record<string, unknown>) =>
    (await validate(plainToInstance(AcceptEhrOrderDto, input))).map((error) => error.property);

  it('accepts an order at every EHR lab-request limit', async () => {
    expect(await failed({ ...valid, testCodeSystem: 's'.repeat(limits.testCodeSystem), testCode: 'c'.repeat(limits.testCode),
      testName: 'n'.repeat(limits.testName), clinicalIndication: 'i'.repeat(limits.clinicalIndication) })).toEqual([]);
  });

  it.each(Object.entries(limits))('refuses a %s one character over the EHR limit of %i', async (field, limit) => {
    expect(await failed({ ...valid, [field]: 'x'.repeat(limit + 1) })).toEqual([field]);
  });

  it.each(['testCodeSystem', 'testCode', 'testName'])('refuses an empty %s, which EHR never creates', async (field) => {
    expect(await failed({ ...valid, [field]: '' })).toEqual([field]);
  });

  // EHR sends the ids it holds. A patient or account migrated from the legacy
  // system keeps its source id, of any UUID version from 1 to 8
  // (promote-legacy-identity.mjs), and EHR's ParseUUIDPipe takes any version;
  // lab.validate_work_item (0077) still binds each id to the EHR order.
  const ids = ['sourceEhrOrderId', 'sourceEncounterId', 'patientId', 'orderingFacilityId', 'requestedBy'];
  it.each([['1', '6fa459ea-ee8a-11ea-9f1b-0242ac130003'], ['7', '01890a5d-ac96-774b-bcce-b302099a8057']])(
    'accepts a version %s UUID in every id EHR sends', async (_version, uuid) => {
      expect(await failed({ ...valid, ...Object.fromEntries(ids.map((field) => [field, uuid])) })).toEqual([]);
    });

  it.each(ids)('refuses a %s that is not a UUID', async (field) => {
    expect(await failed({ ...valid, [field]: '6fa459ea-ee8a-11ea-9f1b' })).toEqual([field]);
  });
});
