import { EHR_LAB_REQUEST_GROUP_MAX_TESTS, EHR_LAB_REQUEST_GROUP_TIMEOUT_MS, EhrApiClient, EhrApiProblem,
  type EhrLabRequestGroupCreated, type EhrLabRequestGroupInput } from '@hid/api-client';
import { type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { ProblemDetailsFilter } from '../../common/problem';
import { createValidationPipe } from '../../common/validation-pipe';
import { NameOnlyCodes } from '../shared/name-only-codes';
import { LabRequestGroups } from './lab-request-groups';
import { LabRequestGroupsController } from './lab-request-groups.controller';
import { LAB_REQUEST_GROUP_MAX_TESTS } from './lab-request-groups.dto';
import { LabRequestsService } from './lab-requests.service';

/*
 * ORD-6 (0158): @hid/api-client's group call against ehr-api's own route
 * (the controller, its guard and body pipe, the global pipe and filter; the
 * service faked), so the client and the route agree on the path, the
 * headers, the body and the answer. A staff call: the user's credentials and
 * no internal caller. Fictional data only.
 */
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const groupId = '323e4567-e89b-42d3-a456-426614174099';
const requestIds = ['223e4567-e89b-42d3-a456-000000000001', '223e4567-e89b-42d3-a456-000000000002'];
const context = { correlationId: 'group-contract-123456', facilityId, purposeOfUse: 'direct-care',
  cookie: 'hid_access=session-token; hid_access_csrf=csrf-cookie', csrfToken: 'csrf-cookie', origin: 'https://ehr.test' };
const input: EhrLabRequestGroupInput = { status: 'active', clinicalInformation: 'Fever for 3 days', tests: [
  { testCodeSystem: 'LOINC', testCode: '58410-2', testDisplay: 'Full blood count', specimenTypeCode: 'Blood (EDTA)' },
  { testCodeSystem: 'HID-LAB', testCode: 'MP-RDT', testDisplay: 'Malaria rapid diagnostic test', priority: 'urgent' }] };
const request = (id: string, testDisplay: string, labHandoff: unknown) => ({ id, encounterId, patientId, facilityId,
  createdBy: 'account', createdByMembershipId: 'membership', testCodeSystem: null, testCode: null, testDisplay,
  priority: 'routine', status: 'active', specimenTypeCode: null, clinicalInformation: 'Fever for 3 days',
  externalOrderReference: null, requestGroupId: groupId, rowVersion: '1', createdAt: '2026-12-01T09:00:00.123Z',
  updatedAt: '2026-12-01T09:00:00.123Z', labWorkItem: null, labHandoff });
const answer: EhrLabRequestGroupCreated = { requestGroupId: groupId, labRequests: [
  request(requestIds[0]!, 'Full blood count', { state: 'accepted' }),
  request(requestIds[1]!, 'Malaria rapid diagnostic test', { state: 'failed', status: 503, code: 'LAB_HANDOFF_NOT_TRIED' }),
] as EhrLabRequestGroupCreated['labRequests'] };

describe('@hid/api-client createLabRequestGroup against ehr-api\'s route (ORD-6)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.restoreAllMocks();
  });

  const start = async (groups = true, reply: unknown = answer) => {
    const seen: { headers: Record<string, unknown> }[] = [];
    const service = { createGroup: jest.fn(async () => reply) };
    @Module({ controllers: [LabRequestGroupsController], providers: [
      { provide: LabRequestsService, useValue: service },
      { provide: NameOnlyCodes, useValue: new NameOnlyCodes(false, false) },
      { provide: LabRequestGroups, useValue: new LabRequestGroups(groups) }] })
    class TestModule {}
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use((incoming: Request & Record<string, unknown>, _response: Response, next: NextFunction) => {
      seen.push({ headers: { ...incoming.headers } });
      incoming.actor = { id: 'actor', subject: 'staff:test', accountId: 'account', authenticationMethod: 'local',
        roles: ['doctor'], facilityIds: [facilityId], facilities: [], permissions: ['ehr.lab-request.write'],
        facility: { id: facilityId, membershipId: 'membership' } };
      incoming.facilityId = facilityId;
      incoming.correlationId = 'group-contract-123456';
      next();
    });
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    return { client: new EhrApiClient({ baseUrl: `http://127.0.0.1:${port}`, internalServiceToken: 'internal-token-1234567890' }),
      service, seen };
  };

  it('posts the group as a staff call to the route, which takes its body, and returns its answer', async () => {
    const { client, service, seen } = await start();
    await expect(client.createLabRequestGroup(patientId, encounterId, input, context, 'group-create-key-00001'))
      .resolves.toEqual(answer);
    expect(service.createGroup).toHaveBeenCalledTimes(1);
    expect((service.createGroup.mock.calls[0] as unknown[]).slice(1, 5)).toEqual([patientId, encounterId,
      expect.objectContaining({ status: 'active', priority: 'routine', clinicalInformation: 'Fever for 3 days',
        tests: [expect.objectContaining(input.tests[0]), expect.objectContaining(input.tests[1])] }), 'group-create-key-00001']);
    expect(seen[0]?.headers).toMatchObject({ cookie: context.cookie, 'x-csrf-token': 'csrf-cookie', origin: 'https://ehr.test',
      'x-facility-id': facilityId, 'x-purpose-of-use': 'direct-care', 'idempotency-key': 'group-create-key-00001',
      'x-correlation-id': 'group-contract-123456' });
    // The user's call, not a workload's: no internal caller and no service credential.
    for (const name of ['x-hid-internal-caller', 'x-hid-service-token', 'x-hid-service-authorization', 'authorization']) {
      expect(seen[0]?.headers).not.toHaveProperty(name);
    }
    // The body as the route took it: the client's fields, and the route's default priority.
    expect(JSON.parse(JSON.stringify((service.createGroup.mock.calls[0] as unknown[])[3])))
      .toEqual({ ...input, priority: 'routine' });
    expect([EHR_LAB_REQUEST_GROUP_MAX_TESTS, EHR_LAB_REQUEST_GROUP_TIMEOUT_MS]).toEqual([LAB_REQUEST_GROUP_MAX_TESTS, 30_000]);
  });

  it('while the setting is off: Problem Details 503 LAB_REQUEST_GROUPS_UNAVAILABLE, the same key tried twice at most', async () => {
    const { client, service, seen } = await start(false);
    await expect(client.createLabRequestGroup(patientId, encounterId, input, context, 'group-create-key-00001'))
      .rejects.toMatchObject({ status: 503, payload: expect.objectContaining({ code: 'LAB_REQUEST_GROUPS_UNAVAILABLE' }) });
    expect(seen.map(({ headers }) => headers['idempotency-key'])).toEqual(['group-create-key-00001', 'group-create-key-00001']);
    expect(service.createGroup).not.toHaveBeenCalled();
  });

  it('a body the route refuses comes back once, as the route answered it', async () => {
    const { client, seen } = await start();
    const repeated = { ...input, tests: [input.tests[0]!, { ...input.tests[0]!, testDisplay: 'FBC' }] };
    await expect(client.createLabRequestGroup(patientId, encounterId, repeated, context, 'group-create-key-00001'))
      .rejects.toMatchObject({ status: 400, payload: expect.objectContaining({ code: 'LAB_REQUEST_TEST_REPEATED' }) });
    const withGroup = { ...input, requestGroupId: groupId } as EhrLabRequestGroupInput;
    await expect(client.createLabRequestGroup(patientId, encounterId, withGroup, context, 'group-create-key-00002'))
      .rejects.toMatchObject({ status: 400, payload: expect.objectContaining({ code: 'VALIDATION_FAILED' }) });
    expect(seen).toHaveLength(2);
  });

  it.each([
    ['no requestGroupId', { ...answer, requestGroupId: undefined }],
    ['a request of another group', { ...answer, labRequests: [answer.labRequests[0], { ...answer.labRequests[1],
      requestGroupId: '323e4567-e89b-42d3-a456-426614174098' }] }],
    ['a request with no group', { ...answer, labRequests: [{ ...answer.labRequests[0], requestGroupId: null }] }],
    ['no requests', { ...answer, labRequests: [] }],
    ['more than 20 requests', { ...answer, labRequests: Array(21).fill(answer.labRequests[0]) }],
    ['an unknown handoff state', { ...answer, labRequests: [{ ...answer.labRequests[0], labHandoff: { state: 'sent' } }] }],
  ])('refuses an answer with %s (502, never a partly read group)', async (_label, reply) => {
    const { client } = await start(true, reply);
    const problem = await client.createLabRequestGroup(patientId, encounterId, input, context, 'group-create-key-00001')
      .catch((error: unknown) => error);
    expect(problem).toBeInstanceOf(EhrApiProblem);
    expect(problem).toMatchObject({ status: 502, payload: { code: 'INVALID_LAB_REQUEST_GROUP_RESPONSE' } });
  });

  it('gives the call 30 s, not the client\'s 10 s, since ehr-api may send for 25 s', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(answer),
      { status: 201, headers: { 'content-type': 'application/json' } }));
    const timers = jest.spyOn(globalThis, 'setTimeout');
    const client = new EhrApiClient({ baseUrl: 'https://ehr.example.test', timeoutMs: 10_000 });
    await client.createLabRequestGroup(patientId, encounterId, input, context, 'group-create-key-00001');
    expect(String(fetch.mock.calls[0]?.[0]))
      .toBe(`https://ehr.example.test/api/v1/ehr/patients/${patientId}/encounters/${encounterId}/lab-request-groups`);
    expect(timers.mock.calls.map((call) => call[1])).toContain(EHR_LAB_REQUEST_GROUP_TIMEOUT_MS);
    expect(timers.mock.calls.map((call) => call[1])).not.toContain(10_000);
  });
});
