import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { AcceptEhrOrderDto } from './dto/accept-ehr-order.dto';
import { LabExecutionsService } from './lab-executions.service';
import { LabWorkItemsService } from './lab-work-items.service';
import type { AcceptEhrLabOrderCommand } from './lab-work-items.types';
import { LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards } from './order-route-cards';

// 0156 (ORD-7 F3): a lab test ordered by its name only. EHR sends it with both
// codes null; Lab accepts it, keeps both null in the work item and its
// requested test, and answers them as null. A pair with one code only is
// refused. Fictional identifiers only.

const facilityId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const orderId = '30000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const context = { correlationId: 'name-only-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:lab', accountId, roles: ['lab'], permissions: ['lab.work-item.accept', 'lab.execution.start',
      'lab.execution.read', 'lab.result.released.read'], facilityIds: [facilityId], facilities: [],
    authenticationMethod: 'local' } } satisfies DataAccessContext;

/** The body EHR sends for version 1 of a request: today's coded test, or (0156) by name only with both codes null. */
const body = (codes: { testCodeSystem?: string | null; testCode?: string | null } = { testCodeSystem: null,
  testCode: null }) => ({ sourceEhrOrderId: orderId, sourceEhrOrderVersion: 1,
  sourceEncounterId: '70000000-0000-4000-8000-000000000001', patientId, orderingFacilityId: facilityId,
  ...codes, testName: 'Sickling test', priority: 'routine', clinicalIndication: 'Bone pain',
  requestedBy: accountId, requestedAt: '2026-12-01T09:00:00.123456Z' });

// The global validation pipe of lab-api (main.ts).
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true,
  transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false });
const accepted = (input: unknown) => pipe.transform(input, { type: 'body', metatype: AcceptEhrOrderDto }) as
  Promise<AcceptEhrOrderDto>;
const failed = async (input: Record<string, unknown>) =>
  (await validate(plainToInstance(AcceptEhrOrderDto, input))).map((error) => error.property);

describe('AcceptEhrOrderDto: a test by name only (0156)', () => {
  it('accepts both codes null, as EHR sends a name-only request, and keeps them null', async () => {
    await expect(accepted(body())).resolves.toMatchObject({ testCodeSystem: null, testCode: null, testName: 'Sickling test' });
  });

  it('accepts both codes left out', async () => {
    const { testCodeSystem: _system, testCode: _code, ...rest } = body();
    expect(await failed(rest)).toEqual([]);
  });

  it('still accepts a coded test as before', async () => {
    expect(await failed(body({ testCodeSystem: 'http://loinc.org', testCode: '718-7' }))).toEqual([]);
  });

  it.each([
    [{ testCodeSystem: 'http://loinc.org', testCode: null }, 'testCode'],
    [{ testCodeSystem: 'http://loinc.org' }, 'testCode'],
    [{ testCodeSystem: null, testCode: '718-7' }, 'testCodeSystem'],
    [{ testCode: '718-7' }, 'testCodeSystem'],
  ])('refuses one code without the other (%j), naming the missing one', async (codes, missing) => {
    expect(await failed(body(codes))).toEqual([missing]);
    await expect(accepted(body(codes))).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    [{ testCodeSystem: '', testCode: '718-7' }, 'testCodeSystem'],
    [{ testCodeSystem: 'http://loinc.org', testCode: '' }, 'testCode'],
  ])('refuses an empty code as before (%j)', async (codes, field) => {
    expect(await failed(body(codes))).toEqual([field]);
  });

  it('still requires the test name', async () => {
    expect(await failed({ ...body(), testName: '' })).toEqual(['testName']);
    expect(await failed({ ...body(), testName: null })).toEqual(['testName']);
  });
});

const stored = (command: AcceptEhrLabOrderCommand) => ({ id: workItemId, patient_id: patientId, facility_id: facilityId,
  ordering_facility_id: facilityId, source_ehr_order_id: orderId, source_ehr_order_version: '1',
  source_encounter_id: '70000000-0000-4000-8000-000000000001', status: 'accepted', priority: 'routine',
  accepted_by: accountId, accepted_at: new Date('2026-12-01T09:00:01Z'), row_version: '1',
  created_at: new Date('2026-12-01T09:00:01Z'), request_sha256: requestDigest('lab.work-item.accept-ehr-order', command) });

/** A fake database: the replay lookup returns `rows`; inserts are recorded with their values. */
const workItems = (rows: ReturnType<typeof stored>[]) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (/^\s*select\b/i.test(sql) && /from lab\.work_items/.test(sql)) return { rows };
    if (/insert into lab\.work_items\b/.test(sql)) return { rows: [{ ...stored(body() as AcceptEhrLabOrderCommand),
      test_code_system: values[8], test_code: values[9], test_name: values[10] }] };
    return { rows: [], rowCount: 1 };
  }) } as unknown as PoolClient;
  const database = { withTransaction: async <T>(_context: DataAccessContext, operation: (c: PoolClient) => Promise<T>) =>
    operation(client) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { service: new LabWorkItemsService(database, identity, audit, new LabOrderRouteAccess(identity),
    new LabOrderRouteCards(database)), statements };
};

describe('LabWorkItemsService.acceptEhrOrder: a test by name only (0156)', () => {
  it('accepts it with both codes null in the work item and in its requested test', async () => {
    const command = await accepted(body()) as AcceptEhrLabOrderCommand;
    const { service, statements } = workItems([]);
    await expect(service.acceptEhrOrder(context, command)).resolves.toMatchObject({ id: workItemId,
      sourceEhrOrderId: orderId, sourceEhrOrderVersion: 1, status: 'accepted' });
    const workItem = statements.find(({ sql }) => /insert into lab\.work_items\b/.test(sql));
    expect(workItem?.sql).toMatch(/test_code_system,test_code,\s*test_name/);
    expect(workItem?.values.slice(8, 11)).toEqual([null, null, 'Sickling test']);
    const requested = statements.find(({ sql }) => /insert into lab\.work_item_requested_tests\b/.test(sql));
    expect(requested?.sql).toMatch(/"ordinal",code_system,code,name/);
    expect(requested?.values.slice(3)).toEqual([null, null, 'Sickling test']);
  });

  it('takes both codes left out as null too', async () => {
    const { testCodeSystem: _system, testCode: _code, ...rest } = body();
    const { service, statements } = workItems([]);
    await service.acceptEhrOrder(context, await accepted(rest) as AcceptEhrLabOrderCommand);
    expect(statements.find(({ sql }) => /insert into lab\.work_items\b/.test(sql))?.values.slice(8, 10)).toEqual([null, null]);
  });

  it('replays the same name-only order without writing, and refuses the same version sent with a code', async () => {
    const command = await accepted(body()) as AcceptEhrLabOrderCommand;
    const replay = workItems([stored(command)]);
    await expect(replay.service.acceptEhrOrder(context, await accepted(body()) as AcceptEhrLabOrderCommand))
      .resolves.toMatchObject({ id: workItemId, sourceEhrOrderVersion: 1 });
    expect(replay.statements.filter(({ sql }) => /insert into lab\./.test(sql))).toEqual([]);
    const coded = workItems([stored(command)]);
    await expect(coded.service.acceptEhrOrder(context, await accepted(body({ testCodeSystem: 'http://loinc.org',
      testCode: '718-7' })) as AcceptEhrLabOrderCommand)).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('digests a coded order as before, so a retry across the release replays', async () => {
    // Today's digest of a coded order (the body as the earlier DTO kept it: every field set).
    const coded = body({ testCodeSystem: 'http://loinc.org', testCode: '718-7' });
    expect(requestDigest('lab.work-item.accept-ehr-order', await accepted(coded)))
      .toBe(requestDigest('lab.work-item.accept-ehr-order', plainToInstance(AcceptEhrOrderDto, coded)));
    expect(Object.keys(await accepted(coded)).sort()).toEqual(Object.keys(coded).sort());
  });
});

describe('LabExecutionsService: a test by name only answers null codes (0156)', () => {
  const specimenId = '80000000-0000-4000-8000-000000000001';
  const executionId = '90000000-0000-4000-8000-000000000001';
  const execution = { id: executionId, accession_id: 'a0000000-0000-4000-8000-000000000001', specimen_id: specimenId,
    requested_test_id: 'b0000000-0000-4000-8000-000000000001', patient_id: patientId, facility_id: facilityId,
    status: 'in_progress', method: null, started_at: new Date('2026-12-01T10:00:00Z'), completed_at: null, row_version: '1',
    idempotency_key: 'execution-name-only-0001', request_sha256: requestDigest('lab.execution.start', { specimenId,
      expectedSpecimenVersion: 3, startedAt: '2026-12-01T10:00:00Z', method: null, reason: 'Begin manual method' }),
    completed_idempotency_key: null, completed_request_sha256: null, test_name: 'Sickling test', test_code: null,
    test_code_system: null };
  const harness = () => {
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.includes('from lab.specimens s')) return { rows: [{ id: specimenId, accession_id: execution.accession_id,
        patient_id: patientId, facility_id: facilityId, status: 'received', row_version: '3', work_item_id: workItemId }] };
      if (sql.includes('from lab.test_executions e join lab.work_item_requested_tests t')) return { rows: [execution] };
      if (/\bfrom lab\.work_items\b/.test(sql)) return { rows: [{ id: workItemId, patient_id: patientId,
        source_ehr_order_id: orderId, source_ehr_order_version: '1', test_code_system: null, test_code: null,
        test_name: 'Sickling test', accepted_at: new Date('2026-12-01T09:00:01Z') }] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    const database = { withTransaction: async <T>(_c: DataAccessContext, operation: (c: PoolClient) => Promise<T>) =>
      operation(client) } as unknown as DatabaseService;
    const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
    const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    return new LabExecutionsService(database, audit, new LabOrderRouteAccess(identity));
  };

  it('a replayed start (the replay select reads the requested test) answers the name with both codes null', async () => {
    await expect(harness().start(context, specimenId, { expectedSpecimenVersion: 3, startedAt: '2026-12-01T10:00:00Z',
      reason: 'Begin manual method' }, 'execution-name-only-0001')).resolves.toMatchObject({ id: executionId,
      test: { codeSystem: null, code: null, name: 'Sickling test' } });
  });

  it('an execution read answers the name with both codes null', async () => {
    await expect(harness().get(context, executionId)).resolves.toMatchObject({
      test: { codeSystem: null, code: null, name: 'Sickling test' } });
  });

  it('the released results of the order answer the name with both codes null', async () => {
    await expect(harness().listReleasedForEhrOrder(context, orderId)).resolves.toMatchObject({ workItemId,
      sourceEhrOrderId: orderId, test: { codeSystem: null, code: null, name: 'Sickling test' }, results: [] });
  });
});
