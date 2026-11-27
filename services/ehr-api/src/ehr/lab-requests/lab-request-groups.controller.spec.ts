import { type INestApplication, Module } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { CorrelationMiddleware } from '../../common/correlation.middleware';
import { ProblemDetailsFilter } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import { WorkItemProgressService } from '../../integrations/work-item-progress.service';
import { NameOnlyCodes } from '../shared/name-only-codes';
import {
  LAB_REQUEST_GROUPS_OFF, LAB_REQUEST_GROUPS_PROVIDER, LabRequestGroups, labRequestGroupsUnavailable, repeatedTests,
} from './lab-request-groups';
import { LabRequestGroupsController } from './lab-request-groups.controller';
import {
  CreateLabRequestGroupDto,
  CreateLabRequestGroupNameOnlyDto,
  LAB_REQUEST_GROUP_MAX_TESTS,
  LabRequestGroupTestDto,
  LabRequestGroupTestNameOnlyDto,
  LabRequestListQueryDto,
} from './lab-request-groups.dto';
import { LabRequestsController } from './lab-requests.controller';
import { LabRequestsModule } from './lab-requests.module';
import { LabRequestsService } from './lab-requests.service';

/*
 * ORD-6 (0158) over HTTP, through Nest with the app's global pipe and filter:
 * the group route behind LAB_REQUEST_GROUPS_ENABLED (the body first; while
 * off the service refuses a new group, 503), its
 * body checks (each test as the single create checks it, name-only tests
 * while LAB_REQUEST_NAME_ONLY_ENABLED is on, repeats refused), and a client's
 * requestGroupId refused everywhere a body is taken (Rahman's answer 2).
 * Fictional data only.
 */
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const requestId = '123e4567-e89b-42d3-a456-426614174005';
const groupId = '323e4567-e89b-42d3-a456-426614174099';
const actor = { id: 'actor', subject: 'staff:test', accountId: '123e4567-e89b-42d3-a456-426614174003',
  authenticationMethod: 'local', roles: ['doctor'], facilityIds: [facilityId], facilities: [],
  permissions: ['ehr.lab-request.write', 'ehr.lab-request.read', 'lab.work-item.accept'],
  facility: { id: facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174004' } };
const coded = { testCodeSystem: 'LOINC', testCode: '58410-2', testDisplay: 'Full blood count' };
const malaria = { testCodeSystem: 'HID-LAB', testCode: 'MP-RDT', testDisplay: 'Malaria rapid diagnostic test',
  priority: 'urgent' };
const body = (fields: Record<string, unknown> = {}) => ({ status: 'active', clinicalInformation: 'Fever for 3 days',
  tests: [coded, malaria], ...fields });
const encounter = `/ehr/patients/${patientId}/encounters/${encounterId}`;

describe('the lab request group route over HTTP (ORD-6)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const start = async (groups: boolean, nameOnly = false) => {
    const service = {
      // While off, the service refuses a new group (LabRequestsService.createGroup reads the key row first).
      createGroup: jest.fn(async () => {
        if (!groups) throw labRequestGroupsUnavailable();
        return { requestGroupId: groupId, labRequests: [] };
      }),
      create: jest.fn(async () => ({ id: requestId })),
      update: jest.fn(async () => ({ id: requestId })),
      list: jest.fn(async () => ({ items: [], nextCursor: null })),
    };
    @Module({ controllers: [LabRequestsController, LabRequestGroupsController], providers: [
      { provide: LabRequestsService, useValue: service },
      { provide: WorkItemProgressService, useValue: { withLabRequestProgress: async (_c: unknown, _p: unknown,
        page: unknown) => page } },
      { provide: NameOnlyCodes, useValue: new NameOnlyCodes(nameOnly, false) },
      { provide: LabRequestGroups, useValue: new LabRequestGroups(groups) }] })
    class TestModule {}
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    const correlation = new CorrelationMiddleware();
    app.use((request: Request & Record<string, unknown>, response: Response, next: NextFunction) => {
      request.actor = actor;
      request.facilityId = facilityId;
      correlation.use(request as unknown as HidRequest, response, next);
    });
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const call = async (method: string, path: string, payload?: unknown, key: string | null = 'group-create-key-00001') => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        headers: { 'content-type': 'application/json', 'x-purpose-of-use': 'direct-care',
          ...(key ? { 'idempotency-key': key } : {}) } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const post = (payload: unknown, key?: string | null) => call('POST', `${encounter}/lab-request-groups`, payload, key);
    return { call, post, service };
  };
  const refused = (field: string) => ({ status: 400, body: expect.objectContaining({ code: 'VALIDATION_FAILED',
    errors: expect.arrayContaining([expect.objectContaining({ field })]) }) });

  it('off: the body and the key are checked first, as when on; then the service answers (503 '
    + 'LAB_REQUEST_GROUPS_UNAVAILABLE to a new group)', async () => {
    const { post, service } = await start(false);
    // No guard of the route's own: the setting is the service's (a same-key retry of a stored group is answered).
    expect(Reflect.getMetadata(GUARDS_METADATA, LabRequestGroupsController.prototype.create)).toBeUndefined();
    expect(await post({ tests: 'not a list' })).toMatchObject(refused('tests'));
    expect(await post(body({ tests: [coded, { ...coded, testDisplay: 'FBC' }] }))).toMatchObject({ status: 400,
      body: { code: 'LAB_REQUEST_TEST_REPEATED' } });
    expect(await post(body(), null)).toMatchObject({ status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect(service.createGroup).not.toHaveBeenCalled();
    // Only a direct caller sees this code: through the public gateway the browser gets nginx's own 503
    // UPSTREAM_UNAVAILABLE, as for every ehr-api 502, 503 and 504; the website reads the catalogue status instead.
    // Its detail is the filter's words for every 5xx: a screen reads the code, never the words.
    expect(await post(body())).toMatchObject({ status: 503, body: { status: 503, code: 'LAB_REQUEST_GROUPS_UNAVAILABLE',
      detail: 'The service could not complete the request.' } });
    expect(service.createGroup).toHaveBeenCalledTimes(1);
    expect((service.createGroup.mock.calls[0] as unknown[]).slice(1, 5)).toEqual([patientId, encounterId,
      expect.any(CreateLabRequestGroupDto), 'group-create-key-00001']);
  });

  it('on: the body reaches the service, with the request\'s arrival time for the send deadline', async () => {
    const before = Date.now();
    const { post, service } = await start(true);
    expect(await post(body())).toMatchObject({ status: 201, body: { requestGroupId: groupId, labRequests: [] } });
    const [context, patient, visit, input, key, receivedAt] = service.createGroup.mock.calls[0] as unknown as
      [unknown, string, string, CreateLabRequestGroupDto, string, number];
    expect([patient, visit, key]).toEqual([patientId, encounterId, 'group-create-key-00001']);
    expect(context).toMatchObject({ facilityId, purposeOfUse: 'direct-care' });
    expect(input).toBeInstanceOf(CreateLabRequestGroupDto);
    expect(input.tests.map((test) => test.constructor)).toEqual([LabRequestGroupTestDto, LabRequestGroupTestDto]);
    expect(input).toMatchObject({ status: 'active', priority: 'routine', clinicalInformation: 'Fever for 3 days' });
    expect(receivedAt).toBeGreaterThanOrEqual(before);
    expect(receivedAt).toBeLessThanOrEqual(Date.now());
  });

  it('on: the key is required as on every clinical create (400 IDEMPOTENCY_KEY_REQUIRED)', async () => {
    const { post, service } = await start(true);
    expect(await post(body(), null)).toMatchObject({ status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect(service.createGroup).not.toHaveBeenCalled();
  });

  it('refuses a client\'s requestGroupId in the group body and in a test (400 VALIDATION_FAILED)', async () => {
    const { post, service } = await start(true);
    expect(await post(body({ requestGroupId: groupId }))).toMatchObject(refused('requestGroupId'));
    expect(await post(body({ tests: [{ ...coded, requestGroupId: groupId }] })))
      .toMatchObject(refused('tests.0.requestGroupId'));
    expect(service.createGroup).not.toHaveBeenCalled();
  });

  it('refuses a client\'s requestGroupId in the single create (setting on or off) and in a PATCH', async () => {
    for (const nameOnly of [false, true]) {
      const { call, service } = await start(true, nameOnly);
      expect(await call('POST', `${encounter}/lab-requests`, { ...coded, status: 'active', requestGroupId: groupId }))
        .toMatchObject(refused('requestGroupId'));
      expect(await call('PATCH', `${encounter}/lab-requests/${requestId}`, { expectedRowVersion: 1, priority: 'stat',
        changeReason: 'Clinical review', requestGroupId: groupId })).toMatchObject(refused('requestGroupId'));
      expect(service.create).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      // Without it, both reach the service as before.
      expect((await call('POST', `${encounter}/lab-requests`, { ...coded, status: 'active' })).status).toBe(201);
      expect((await call('PATCH', `${encounter}/lab-requests/${requestId}`, { expectedRowVersion: 1, priority: 'stat',
        changeReason: 'Clinical review' })).status).toBe(200);
      await app?.close();
      app = undefined;
    }
  });

  it('takes 1 to 20 tests, a status of draft or active, and each test with the single create\'s fields only', async () => {
    const { post, service } = await start(true);
    const many = Array.from({ length: LAB_REQUEST_GROUP_MAX_TESTS + 1 }, (_value, index) => ({ testCodeSystem: 'LOCAL',
      testCode: `T${index}`, testDisplay: `Test ${index}` }));
    expect(LAB_REQUEST_GROUP_MAX_TESTS).toBe(20);
    expect(await post(body({ tests: many }))).toMatchObject(refused('tests'));
    expect(await post(body({ tests: [] }))).toMatchObject(refused('tests'));
    expect(await post(body({ tests: undefined }))).toMatchObject(refused('tests'));
    for (const status of ['on_hold', 'completed', 'cancelled', 'entered_in_error', null]) {
      expect(await post(body({ status }))).toMatchObject(refused('status'));
    }
    for (const field of [{ status: 'active' }, { clinicalInformation: 'Only this test' }, { externalOrderReference: 'X1' },
      { priority: null }, { testDisplay: '' }, { specimenTypeCode: 'x'.repeat(101) }]) {
      expect(await post(body({ tests: [malaria, { ...coded, ...field }] })))
        .toMatchObject(refused(`tests.1.${Object.keys(field)[0] ?? ''}`));
    }
    expect(await post(body({ priority: null }))).toMatchObject(refused('priority'));
    expect(await post(body({ clinicalInformation: 'x'.repeat(4001) }))).toMatchObject(refused('clinicalInformation'));
    expect(service.createGroup).not.toHaveBeenCalled();
    expect((await post(body({ tests: many.slice(0, 20) }))).status).toBe(201);
    expect((await post(body({ status: 'draft', tests: [coded] }))).status).toBe(201);
  });

  it('a test by name only: 400 VALIDATION_FAILED while LAB_REQUEST_NAME_ONLY_ENABLED is off, as the single create', async () => {
    const { post, service } = await start(true, false);
    expect(await post(body({ tests: [coded, { testDisplay: 'Sickling test' }] }))).toMatchObject(refused('tests.1.testCode'));
    expect(service.createGroup).not.toHaveBeenCalled();
  });

  it('names a refused field inside a test as tests.<n>.<field> with its messages, and a test refused whole as tests.<n>',
    async () => {
      const { post, service } = await start(true, true);
      // The global pipe would name only `tests`, with no message, so the website could mark no row.
      expect(await post(body({ tests: [coded, malaria, { testDisplay: '   ' }] }))).toMatchObject({ status: 400,
        body: { code: 'VALIDATION_FAILED', errors: [{ field: 'tests.2.testDisplay',
          messages: ['testDisplay must be longer than or equal to 1 characters'] }] } });
      expect(await post(body({ tests: [coded, { ...malaria, requestGroupId: groupId }] }))).toMatchObject({ status: 400,
        body: { code: 'VALIDATION_FAILED', errors: [{ field: 'tests.1.requestGroupId',
          messages: ['property requestGroupId should not exist'] }] } });
      for (const entry of [null, 'Full blood count']) {
        expect(await post(body({ tests: [coded, entry] }))).toMatchObject({ status: 400, body: {
          code: 'VALIDATION_FAILED', errors: [{ field: 'tests.1',
            messages: ['each value in nested property tests must be either object or array'] }] } });
      }
      // Fields outside the tests keep the global pipe's names.
      expect(await post(body({ status: 'on_hold', tests: [coded, { testDisplay: '' }] }))).toMatchObject({ status: 400,
        body: { errors: [{ field: 'tests.1.testDisplay' }, { field: 'status' }] } });
      expect(service.createGroup).not.toHaveBeenCalled();
    });

  it('with LAB_REQUEST_NAME_ONLY_ENABLED on, a group mixes coded and name-only tests; one code alone is refused', async () => {
    const { post, service } = await start(true, true);
    expect((await post(body({ tests: [coded, { testDisplay: 'Sickling test' }] }))).status).toBe(201);
    const input = (service.createGroup.mock.calls[0] as unknown as unknown[])[3] as CreateLabRequestGroupNameOnlyDto;
    expect(input).toBeInstanceOf(CreateLabRequestGroupNameOnlyDto);
    expect(input.tests.map((test) => test.constructor)).toEqual([LabRequestGroupTestNameOnlyDto, LabRequestGroupTestNameOnlyDto]);
    expect(input.tests[1]).toMatchObject({ testDisplay: 'Sickling test' });
    expect(input.tests[1]?.testCode).toBeUndefined();
    expect(await post(body({ tests: [coded, { testDisplay: 'Sickling test', testCode: 'SICKLE' }] }))).toMatchObject({
      status: 400, body: { code: 'LAB_TEST_CODE_INCOMPLETE', detail: 'Test code and its code system must be supplied together.',
        errors: [{ field: 'tests.1' }] } });
    expect(await post(body({ tests: [{ ...coded, testCode: null }] }))).toMatchObject(refused('tests.0.testCode'));
    // Every test with one code is named, not only the first.
    expect(await post(body({ tests: [coded, { testDisplay: 'Sickling test', testCode: 'SICKLE' },
      { testDisplay: 'Widal test', testCodeSystem: 'HID-LAB' }] }))).toMatchObject({ status: 400, body: {
      code: 'LAB_TEST_CODE_INCOMPLETE', errors: [{ field: 'tests.1' }, { field: 'tests.2' }] } });
  });

  it('refuses a repeated test: the same code system and code, or the same name, on the same specimen or with either '
    + 'specimen missing (400 LAB_REQUEST_TEST_REPEATED)', async () => {
    const { post, service } = await start(true, true);
    const words = 'This test is already in the request for this specimen, or with no specimen. If it is for another '
      + 'specimen, choose the specimen on each. To order it again, save this request, then add it on its own.';
    const repeated = (index: number) => ({ status: 400, body: { code: 'LAB_REQUEST_TEST_REPEATED', detail: words,
      errors: [{ field: `tests.${index}`, messages: [words] }] } });
    expect(await post(body({ tests: [coded, malaria, { ...coded, testDisplay: 'FBC' }] }))).toMatchObject(repeated(2));
    expect(await post(body({ tests: [coded, { ...malaria, testDisplay: 'Full blood count' }] }))).toMatchObject(repeated(1));
    // Two tests by name only with one name; the name is compared without case or extra spaces.
    expect(await post(body({ tests: [{ testDisplay: 'Sickling test' }, { testDisplay: ' sickling  TEST ' }] })))
      .toMatchObject(repeated(1));
    expect(await post(body({ tests: [coded, { testDisplay: 'full blood count' }] }))).toMatchObject(repeated(1));
    // Every test that repeats an earlier one is named, not only the first.
    expect(await post(body({ tests: [coded, malaria, { ...coded, testDisplay: 'FBC' }, { testDisplay: 'Malaria rapid '
      + 'diagnostic test' }] }))).toMatchObject({ status: 400, body: { code: 'LAB_REQUEST_TEST_REPEATED',
      errors: [{ field: 'tests.2' }, { field: 'tests.3' }] } });
    expect(service.createGroup).not.toHaveBeenCalled();
    // The same code in another code system, and different names, are different tests.
    expect((await post(body({ tests: [coded, { ...coded, testCodeSystem: 'LOCAL', testDisplay: 'FBC (local)' },
      { testDisplay: 'Sickling test' }] }))).status).toBe(201);
  });

  it('the repeat rule includes the specimen (the addendum, 7223408785; 27 Nov): one culture on blood and on urine goes '
    + 'in one Save; a second set on the same specimen, or the same test with a specimen missing, is refused', async () => {
    const { post, service } = await start(true, true);
    const repeated = (...indexes: number[]) => ({ status: 400, body: { code: 'LAB_REQUEST_TEST_REPEATED',
      errors: indexes.map((index) => ({ field: `tests.${index}` })) } });
    const culture = { testCodeSystem: 'HID-LAB', testCode: 'MCS', testDisplay: 'Culture and sensitivity' };
    const bloodCulture = { testCodeSystem: 'LOINC', testCode: '600-7', testDisplay: 'Blood culture',
      specimenTypeCode: 'Blood' };
    // Allowed: one code (or one name) on two specimens, whatever their case; and a test with no specimen beside
    // another test.
    for (const tests of [
      [{ ...culture, specimenTypeCode: 'Blood' }, { ...culture, specimenTypeCode: 'Urine' }],
      [{ testDisplay: 'Culture', specimenTypeCode: 'Blood' }, { testDisplay: 'culture', specimenTypeCode: 'URINE' }],
      [bloodCulture, { ...bloodCulture, testCodeSystem: 'loinc', specimenTypeCode: 'Wound swab' }],
      [{ ...culture, specimenTypeCode: 'Blood' }, coded, { testDisplay: 'Sickling test' }],
    ]) {
      expect(await post(body({ tests }))).toMatchObject({ status: 201 });
    }
    expect(service.createGroup).toHaveBeenCalledTimes(4);
    // Refused: one code on one specimen (code system, code and specimen without case), by code or by name, and none
    // twice.
    expect(await post(body({ tests: [bloodCulture, { ...bloodCulture, testDisplay: 'Blood culture, second set' }] })))
      .toMatchObject(repeated(1));
    expect(await post(body({ tests: [bloodCulture, { ...bloodCulture, testCodeSystem: 'loinc',
      testDisplay: 'Blood culture, second set' }] }))).toMatchObject(repeated(1));
    expect(await post(body({ tests: [{ ...culture, specimenTypeCode: 'Urine' }, { ...culture, testCode: 'mcs',
      testDisplay: 'Urine MCS', specimenTypeCode: 'Urine' }] }))).toMatchObject(repeated(1));
    expect(await post(body({ tests: [bloodCulture, { ...bloodCulture, testDisplay: 'Blood culture, second set',
      specimenTypeCode: ' BLOOD ' }] }))).toMatchObject(repeated(1));
    expect(await post(body({ tests: [bloodCulture, { testDisplay: ' BLOOD  culture ', specimenTypeCode: 'blood' }] })))
      .toMatchObject(repeated(1));
    expect(await post(body({ tests: [culture, { ...culture, testDisplay: 'Culture and sensitivity, again' }] })))
      .toMatchObject(repeated(1));
    expect(await post(body({ tests: [{ ...culture, specimenTypeCode: 'Urine' }, { ...culture, specimenTypeCode: 'Blood' },
      { ...culture, specimenTypeCode: 'Urine', testDisplay: 'Urine culture' }] }))).toMatchObject(repeated(2));
    // A missing specimen matches any specimen of the same test, by code or by name, before or after it; every
    // test that repeats an earlier one is named.
    expect(await post(body({ tests: [{ ...culture, specimenTypeCode: 'Blood' }, culture] }))).toMatchObject(repeated(1));
    expect(await post(body({ tests: [{ testDisplay: 'Sickling test' }, { testDisplay: 'sickling test',
      specimenTypeCode: 'Blood' }] }))).toMatchObject(repeated(1));
    expect(await post(body({ tests: [culture, { ...culture, testDisplay: 'Blood MCS', specimenTypeCode: 'Blood' },
      { ...culture, testDisplay: 'Urine MCS', specimenTypeCode: 'Urine' }] }))).toMatchObject(repeated(1, 2));
    // A blank specimen is none (the body trims '   ' to ''), by code or by name: no way round the rule.
    for (const blank of ['', '   ']) {
      expect(await post(body({ tests: [culture, { ...culture, testDisplay: 'Culture, again', specimenTypeCode: blank }] })))
        .toMatchObject(repeated(1));
      expect(await post(body({ tests: [{ testDisplay: 'Sickling test', specimenTypeCode: blank },
        { testDisplay: 'sickling test' }] }))).toMatchObject(repeated(1));
      expect(await post(body({ tests: [bloodCulture, { ...bloodCulture, testDisplay: 'Blood culture, again',
        specimenTypeCode: blank }] }))).toMatchObject(repeated(1));
    }
    expect(service.createGroup).toHaveBeenCalledTimes(4);
  });

  it('repeatedTests: the pairs, case by case', () => {
    const test = (fields: Record<string, string>) => ({ testDisplay: 'Blood culture', ...fields }) as never;
    // Each coded test with a name of its own, so only the code can repeat.
    let named = 0;
    const coded = (system: string, code: string, specimen?: string) => test({ testCodeSystem: system, testCode: code,
      ...(specimen === undefined ? {} : { specimenTypeCode: specimen }), testDisplay: `Test ${named += 1}` });
    expect(repeatedTests([coded('LOINC', '600-7', 'Blood'), coded('loinc', '600-7', 'Blood')])).toEqual([1]);
    expect(repeatedTests([coded('LOINC', '600-7', 'Blood'), coded('Loinc', '600-7', 'Urine')])).toEqual([]);
    expect(repeatedTests([coded('LOINC', '600-7'), coded('LOINC', '600-7')])).toEqual([1]);
    // The code and the specimen are compared without case too (27 Nov; they were compared as sent).
    expect(repeatedTests([coded('HID-LAB', 'MCS', 'Blood'), coded('HID-LAB', 'mcs', 'Blood')])).toEqual([1]);
    expect(repeatedTests([coded('HID-LAB', 'MCS', 'Blood'), coded('HID-LAB', 'MCS', 'BLOOD')])).toEqual([1]);
    expect(repeatedTests([coded('HID-LAB', 'MCS', 'Blood (EDTA)'), coded('HID-LAB', 'MCS', ' blood (edta) ')])).toEqual([1]);
    expect(repeatedTests([coded('HID-LAB', 'MCS', 'Blood'), coded('HID-LAB', 'MCS', 'Blood (EDTA)')])).toEqual([]);
    expect(repeatedTests([coded('HID-LAB', 'MCS', 'Blood'), coded('HID-LAB', 'MCSX', 'Blood')])).toEqual([]);
    // A missing specimen matches any specimen of the same test, either way round (27 Nov; it was a value of its own).
    expect(repeatedTests([coded('LOINC', '600-7'), coded('LOINC', '600-7', 'Blood')])).toEqual([1]);
    expect(repeatedTests([coded('LOINC', '600-7', 'Urine'), coded('LOINC', '600-7')])).toEqual([1]);
    // ... and of the same test only.
    expect(repeatedTests([coded('LOINC', '600-7'), coded('LOINC', '600-8', 'Blood'), coded('HID-LAB', '600-7')]))
      .toEqual([]);
    // The specimen as sent: a specimen named "null" is a specimen, not the missing one.
    expect(repeatedTests([coded('LOINC', '600-7', 'null'), coded('LOINC', '600-7', 'Blood')])).toEqual([]);
    expect(repeatedTests([coded('LOINC', '600-7', 'Null'), coded('LOINC', '600-7', 'NULL')])).toEqual([1]);
    // A blank specimen is missing, so it repeats a test with none, another blank one, and one with a specimen.
    expect(repeatedTests([coded('LOINC', '600-7'), coded('LOINC', '600-7', '')])).toEqual([1]);
    expect(repeatedTests([coded('LOINC', '600-7', '   '), coded('LOINC', '600-7')])).toEqual([1]);
    expect(repeatedTests([coded('LOINC', '600-7', ''), coded('LOINC', '600-7', ' ')])).toEqual([1]);
    expect(repeatedTests([coded('LOINC', '600-7', ''), coded('LOINC', '600-7', 'Blood')])).toEqual([1]);
    expect(repeatedTests([coded('LOINC', '600-7', 'Blood'), coded('LOINC', '600-7', '  ')])).toEqual([1]);
    // By name on the same specimen, or with a specimen missing, coded or not.
    expect(repeatedTests([test({ specimenTypeCode: 'Blood' }), test({ testDisplay: 'blood  CULTURE',
      specimenTypeCode: 'BLOOD' })])).toEqual([1]);
    expect(repeatedTests([test({ specimenTypeCode: 'Blood' }), test({ specimenTypeCode: 'Urine' })])).toEqual([]);
    // Pair by pair: a test with no specimen repeats the same test on blood and on urine, which do not repeat each
    // other, so every later one of the three is named, wherever the one with none stands.
    expect(repeatedTests([test({}), test({ specimenTypeCode: 'Blood' }), test({ specimenTypeCode: 'Urine' })]))
      .toEqual([1, 2]);
    expect(repeatedTests([test({ specimenTypeCode: 'Blood' }), test({}), test({ specimenTypeCode: 'Urine' })]))
      .toEqual([1, 2]);
    expect(repeatedTests([test({ specimenTypeCode: 'Blood' }), test({ specimenTypeCode: 'Urine' }), test({})]))
      .toEqual([2]);
    expect(repeatedTests([test({}), test({ specimenTypeCode: 'Blood' }), test({})])).toEqual([1, 2]);
    expect(repeatedTests([])).toEqual([]);
  });

  it('the list takes ?requestGroupId= (a UUID) whatever the setting says, and refuses anything else', async () => {
    const { call, service } = await start(false);
    expect((await call('GET', `${encounter}/lab-requests?requestGroupId=${groupId}&limit=5`)).status).toBe(200);
    expect(service.list.mock.calls[0]?.[3 as never]).toBeInstanceOf(LabRequestListQueryDto);
    expect(service.list.mock.calls[0]?.[3 as never]).toMatchObject({ requestGroupId: groupId, limit: 5 });
    expect(await call('GET', `${encounter}/lab-requests?requestGroupId=group-1`)).toMatchObject(refused('requestGroupId'));
    expect((await call('GET', `${encounter}/lab-requests`)).status).toBe(200);
    expect(service.list.mock.calls.map((args) => (args as unknown[])[3])).toEqual([
      expect.objectContaining({ requestGroupId: groupId }), expect.not.objectContaining({ requestGroupId: expect.anything() })]);
  });
});

describe('LAB_REQUEST_GROUPS_ENABLED and the module', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
  const environment = (value?: string) => {
    Object.assign(process.env, { DATABASE_URL: 'postgresql://ehr:test@127.0.0.1/hid', CORS_ORIGINS: 'http://localhost',
      STORAGE_MODE: 'disabled' });
    if (value === undefined) delete process.env.LAB_REQUEST_GROUPS_ENABLED;
    else process.env.LAB_REQUEST_GROUPS_ENABLED = value;
    resetEnvironmentForTests();
  };

  it('is off unless set to true', () => {
    environment();
    expect(getEnvironment().LAB_REQUEST_GROUPS_ENABLED).toBe(false);
    expect(LabRequestGroups.fromEnvironment().enabled).toBe(false);
    environment('true');
    expect(LabRequestGroups.fromEnvironment().enabled).toBe(true);
    environment('false');
    expect(LabRequestGroups.fromEnvironment().enabled).toBe(false);
    expect(LAB_REQUEST_GROUPS_OFF.enabled).toBe(false);
  });

  it('LabRequestsModule gives the service the setting as the environment sets it', async () => {
    environment('true');
    const stand = (token: unknown) => ({ standIn: typeof token === 'function' ? token.name : String(token) });
    const moduleRef = await Test.createTestingModule({ imports: [LabRequestsModule] }).useMocker(stand).compile();
    expect(moduleRef.get(LabRequestGroupsController)).toBeInstanceOf(LabRequestGroupsController);
    expect(moduleRef.get(LabRequestGroups)).toEqual(new LabRequestGroups(true));
    const labRequests = moduleRef.get(LabRequestsService) as unknown as Record<string, unknown>;
    expect(labRequests.groups).toBe(moduleRef.get(LabRequestGroups));
    expect(LAB_REQUEST_GROUPS_PROVIDER.provide).toBe(LabRequestGroups);
    await moduleRef.close();
  });
});
