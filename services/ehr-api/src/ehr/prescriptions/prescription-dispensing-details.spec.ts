import { Body, Controller, type INestApplication, Module, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import { CreatePrescriptionDto, CreatePrescriptionWithDetailsDto, OrderStatus } from '../shared/clinical.dto';
import { CreatePrescriptionBodyPipe, PRESCRIPTION_DISPENSING_DETAILS_OFF,
  PrescriptionDispensingDetails } from './prescription-dispensing-details';
import { PrescriptionsController } from './prescriptions.controller';
import { PrescriptionsModule } from './prescriptions.module';
import { PrescriptionsService } from './prescriptions.service';

/*
 * Prescription strength, form, duration, quantity and priority (0122, owner
 * decision 25 of 2026-11-01, "all recommended except D5", items 3b and 4):
 * behind PRESCRIPTION_DISPENSING_DETAILS_ENABLED. Off, the create body, the
 * statements, the answers and the list are exactly as before; on, a create
 * may carry the seven optional fields (each pair together), they are stored
 * and echoed when set, the list says `dispensingDetails: true`, and a body
 * without them keeps its Idempotency-Key digest.
 */

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const prescriptionId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
    permissions: ['ehr.prescription.write'], facilityIds: [facilityId], facilities: [] } } as unknown as DataAccessContext;

const body = { medicationDisplay: 'Amoxicillin 500 mg capsule', doseQuantity: 1, doseUnit: 'capsule', routeCode: 'oral',
  frequency: 'Every 8 hours', instructions: 'Take after food', startsOn: '2026-11-02', endsOn: '2026-11-08',
  status: 'active' };
const details = { priority: 'urgent', strength: '500 mg', doseForm: 'capsule', durationValue: 7, durationUnit: 'day',
  quantityToDispense: 21, quantityUnit: 'capsule' };

/** The validation main.ts installed before this release, written out, to compare answers with. */
const todaysValidation = () => new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
  transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
  exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
    errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) });

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const problem = error as DomainProblem;
    return { status: problem.getStatus(), code: problem.code, errors: problem.errors };
  }
  throw new Error('expected a refusal');
};
const pipe = (enabled: boolean) => new CreatePrescriptionBodyPipe(new PrescriptionDispensingDetails(enabled));

/** A database row as node-postgres gives it, with the detail columns when the statement named them. */
const row = (withDetails: boolean, values: Partial<Record<string, unknown>> = {}) => ({
  id: prescriptionId, encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  medicationCodeSystem: null, medicationCode: null, medicationDisplay: 'Amoxicillin 500 mg capsule', doseQuantity: '1.0000',
  doseUnit: 'capsule', routeCode: 'oral', frequency: 'Every 8 hours', instructions: 'Take after food', startsOn: '2026-11-02',
  endsOn: '2026-11-08', status: OrderStatus.Active, rowVersion: '1', createdAt: new Date('2026-11-02T10:00:00Z'),
  updatedAt: new Date('2026-11-02T10:00:00Z'),
  ...(withDetails ? { priority: null, strength: null, doseForm: null, durationValue: null, durationUnit: null,
    quantityToDispense: null, quantityUnit: null, ...values } : {}),
});
const TODAYS_KEYS = Object.keys(row(false));

const harness = (enabled: boolean | undefined, values: Partial<Record<string, unknown>> = {}) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
    statements.push({ sql, values: parameters });
    return { rows: [row(/medication_strength/.test(sql), values)] };
  }) };
  const repository = {
    run: jest.fn(async (_context, _patient, _access, _event, operation) => (await operation(client)).value),
    executeCreate: jest.fn(async (_client, _context, _patient, _key, _operation, digest, _type, create) =>
      ({ ...(await create()), digest })),
    setChangeReason: jest.fn(),
  };
  const routes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };
  const service = enabled === undefined
    ? new PrescriptionsService(repository as never, {} as never, routes as never)
    : new PrescriptionsService(repository as never, {} as never, routes as never, new PrescriptionDispensingDetails(enabled));
  const digest = () => (repository.executeCreate.mock.calls.at(-1) as unknown[] | undefined)?.[5];
  return { service, statements, digest, repository };
};
const create = async (service: PrescriptionsService, input: object) => service.create(context, patientId, encounterId,
  input as CreatePrescriptionDto, 'create-key-0000001');

describe('prescription dispensing details: off (the default)', () => {
  it.each(Object.entries(details))('refuses %s exactly as today\'s validation does', async (field, value) => {
    const answer = await refusal(pipe(false).transform({ ...body, [field]: value }));
    expect(answer).toEqual(await refusal(todaysValidation().transform({ ...body, [field]: value },
      { type: 'body', metatype: CreatePrescriptionDto, data: undefined })));
    expect(answer).toEqual({ status: 400, code: 'VALIDATION_FAILED',
      errors: [{ field, messages: [`property ${field} should not exist`] }] });
  });

  it('refuses a body with a detail and another error exactly as today', async () => {
    const input = { ...body, frequency: '', durationValue: 7, strength: null };
    expect(await refusal(pipe(false).transform(input))).toEqual(await refusal(todaysValidation().transform(input,
      { type: 'body', metatype: CreatePrescriptionDto, data: undefined })));
  });

  it('accepts today\'s body as today\'s class', async () => {
    const input = await pipe(false).transform({ ...body });
    expect(input).toBeInstanceOf(CreatePrescriptionDto);
    expect(input).not.toBeInstanceOf(CreatePrescriptionWithDetailsDto);
    expect(input).toEqual(await todaysValidation().transform({ ...body },
      { type: 'body', metatype: CreatePrescriptionDto, data: undefined }));
  });

  it.each([['no setting passed (every existing caller)', undefined], ['the setting false', false]])(
    'with %s, the statements, the answers and the digest are today\'s', async (_label, enabled) => {
      const { service, statements, digest } = harness(enabled);
      const input = await pipe(false).transform({ ...body });
      const created = await create(service, input);
      const insert = statements.find(({ sql }) => /insert into ehr\.prescriptions/.test(sql))!;
      expect(insert.sql).not.toMatch(/priority|medication_strength|medication_dose_form|duration_|quantity_to_dispense|quantity_unit/);
      expect(insert.values).toHaveLength(16);
      expect(Object.keys(created)).toEqual(TODAYS_KEYS);
      expect(digest()).toBe(requestDigest('prescription.create', { patientId, encounterId,
        input: plainToInstance(CreatePrescriptionDto, { ...body }) }));
      const page = await service.list(context, patientId, encounterId, { limit: 50 });
      expect('dispensingDetails' in page).toBe(false);
      expect(statements.every(({ sql }) => !/medication_strength/.test(sql))).toBe(true);
      expect(Object.keys((await service.get(context, patientId, encounterId, prescriptionId)) as object))
        .toEqual([...TODAYS_KEYS, 'orderRoute']);
    });

  it('is the shared off instance', () => {
    expect(PRESCRIPTION_DISPENSING_DETAILS_OFF.enabled).toBe(false);
    expect(PRESCRIPTION_DISPENSING_DETAILS_OFF.selectList()).toBe('');
  });
});

describe('prescription dispensing details: on', () => {
  it('accepts the seven fields, trimmed', async () => {
    const input = await pipe(true).transform({ ...body, ...details, strength: '  500 mg ', quantityUnit: ' capsule' });
    expect(input).toBeInstanceOf(CreatePrescriptionWithDetailsDto);
    expect(input).toMatchObject(details);
  });

  it('accepts a body without them', async () => {
    expect(await pipe(true).transform({ ...body })).toMatchObject(body);
  });

  it.each([
    ['priority', 'high'], ['priority', 'Urgent'], ['priority', null], ['strength', ''], ['strength', '   '],
    ['strength', 'm'.repeat(81)], ['strength', 500], ['strength', null], ['doseForm', 'pill'], ['doseForm', null],
    ['durationValue', 0], ['durationValue', 3651], ['durationValue', 1.5], ['durationValue', '7'], ['durationValue', null],
    ['durationUnit', 'year'], ['durationUnit', 'days'], ['durationUnit', null], ['quantityToDispense', 0],
    ['quantityToDispense', -1], ['quantityToDispense', 1.00001], ['quantityToDispense', '21'],
    ['quantityToDispense', 100_000_000], ['quantityToDispense', null], ['quantityUnit', ''], ['quantityUnit', 'u'.repeat(81)],
    ['quantityUnit', null],
  ])('refuses %s %p', async (field, value) => {
    const answer = await refusal(pipe(true).transform({ ...body, ...details, [field]: value }));
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('VALIDATION_FAILED');
    expect(answer.errors?.map((error) => error.field)).toEqual([field]);
  });

  it('accepts the limits', async () => {
    const input = await pipe(true).transform({ ...body, ...details, strength: 'm'.repeat(80), durationValue: 3650,
      quantityToDispense: 99_999_999.9999, quantityUnit: 'u'.repeat(80) });
    expect(input).toMatchObject({ durationValue: 3650, quantityToDispense: 99_999_999.9999 });
    await expect(pipe(true).transform({ ...body, durationValue: 1, durationUnit: 'month', quantityToDispense: 0.0001,
      quantityUnit: 'g' })).resolves.toBeInstanceOf(CreatePrescriptionWithDetailsDto);
  });

  it('still refuses an unknown field', async () => {
    expect(await refusal(pipe(true).transform({ ...body, imageUrl: 'https://example.invalid/a.png' }))).toEqual({
      status: 400, code: 'VALIDATION_FAILED', errors: [{ field: 'imageUrl', messages: ['property imageUrl should not exist'] }] });
  });

  it.each([
    [{ durationValue: 7 }, 'DURATION_INCOMPLETE'], [{ durationUnit: 'day' }, 'DURATION_INCOMPLETE'],
    [{ quantityToDispense: 21 }, 'QUANTITY_INCOMPLETE'], [{ quantityUnit: 'capsule' }, 'QUANTITY_INCOMPLETE'],
  ])('refuses %p without its pair (%s)', async (part, code) => {
    const { service, statements } = harness(true);
    const input = await pipe(true).transform({ ...body, ...part });
    await expect(create(service, input)).rejects.toMatchObject({ status: 400, code });
    expect(statements).toHaveLength(0);
  });

  it('stores the seven and echoes the ones set under their request names', async () => {
    const { service, statements } = harness(true, { priority: 'urgent', strength: '500 mg', doseForm: 'capsule',
      durationValue: 7, durationUnit: 'day', quantityToDispense: '21.0000', quantityUnit: 'capsule' });
    const created: object = await create(service, await pipe(true).transform({ ...body, ...details }));
    const insert = statements.find(({ sql }) => /insert into ehr\.prescriptions/.test(sql))!;
    expect(insert.sql).toMatch(/priority, medication_strength, medication_dose_form, duration_value, duration_unit,\s+quantity_to_dispense, quantity_unit/);
    expect(insert.sql).toMatch(/\$16,\$17,\$18,\$19,\$20,\$21,\$22,\$23\)/);
    expect(insert.values.slice(16)).toEqual(['urgent', '500 mg', 'capsule', 7, 'day', 21, 'capsule']);
    expect(created).toMatchObject(details);
    expect(Object.keys(created)).toEqual([...TODAYS_KEYS, ...Object.keys(details)]);
    expect(created).not.toHaveProperty('medicationStrength');
  });

  it('stores nulls for the ones not given and answers today\'s keys only', async () => {
    const { service, statements } = harness(true, { priority: 'stat' });
    const created: object = await create(service, await pipe(true).transform({ ...body, priority: 'stat' }));
    const insert = statements.find(({ sql }) => /insert into ehr\.prescriptions/.test(sql))!;
    expect(insert.values.slice(16)).toEqual(['stat', null, null, null, null, null, null]);
    expect(Object.keys(created)).toEqual([...TODAYS_KEYS, 'priority']);
  });

  it('keeps the Idempotency-Key digest of a body without details, and changes it with them', async () => {
    const off = harness(false);
    await create(off.service, await pipe(false).transform({ ...body }));
    const on = harness(true);
    await create(on.service, await pipe(true).transform({ ...body }));
    expect(on.digest()).toBe(off.digest());
    await create(on.service, await pipe(true).transform({ ...body, priority: 'urgent' }));
    expect(on.digest()).not.toBe(off.digest());
  });

  it('adds dispensingDetails to the list, and the set details to every answer', async () => {
    const { service } = harness(true, { durationValue: 2, durationUnit: 'week' });
    const page = await service.list(context, patientId, encounterId, { limit: 50 });
    expect(page).toMatchObject({ wrongPatientReports: true, lateCorrection: true, dispensingDetails: true });
    expect(Object.keys(page.items[0]!)).toEqual([...TODAYS_KEYS, 'durationValue', 'durationUnit', 'orderRoute']);
    expect(await service.get(context, patientId, encounterId, prescriptionId)).toMatchObject({ durationValue: 2,
      durationUnit: 'week' });
    const updated = await service.update(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 1,
      changeReason: 'Clarified', instructions: 'Take with water' });
    expect(updated).toMatchObject({ durationValue: 2, durationUnit: 'week' });
    expect(updated).not.toHaveProperty('priority');
  });

  it('answers an idempotent replay exactly as the create it replays', async () => {
    const { service, repository } = harness(true, { priority: 'urgent', strength: '500 mg', doseForm: 'capsule',
      durationValue: 7, durationUnit: 'day', quantityToDispense: '21.0000', quantityUnit: 'capsule' });
    const input = await pipe(true).transform({ ...body, ...details });
    const created: object = await create(service, input);
    // The replay: the key is already used with this digest, so the repository
    // loads the stored prescription with the service's own reader.
    (repository.executeCreate as jest.Mock).mockImplementationOnce(async (...args: unknown[]) =>
      ({ value: await (args[8] as (id: string) => Promise<unknown>)(prescriptionId) }));
    const replayed: object = await create(service, input);
    expect(replayed).toEqual(created);
    expect(Object.keys(replayed)).toEqual(Object.keys(created));
    expect(replayed).toMatchObject({ quantityToDispense: 21 });
  });
});

describe('PRESCRIPTION_DISPENSING_DETAILS_ENABLED', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid', CORS_ORIGINS: 'http://localhost:3000',
    STORAGE_MODE: 'disabled' };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
  const provider = () => (Reflect.getMetadata('providers', PrescriptionsModule) as unknown[]).find((entry) =>
    typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === PrescriptionDispensingDetails) as
    { useFactory: () => PrescriptionDispensingDetails };

  it('is off unless set to true, and PrescriptionsModule follows it', () => {
    Object.assign(process.env, base);
    delete process.env.PRESCRIPTION_DISPENSING_DETAILS_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().PRESCRIPTION_DISPENSING_DETAILS_ENABLED).toBe(false);
    expect(provider().useFactory().enabled).toBe(false);
    process.env.PRESCRIPTION_DISPENSING_DETAILS_ENABLED = 'true';
    resetEnvironmentForTests();
    expect(provider().useFactory().enabled).toBe(true);
    expect((Reflect.getMetadata('design:paramtypes', PrescriptionsService) as unknown[])[3]).toBe(PrescriptionDispensingDetails);
  });

  it('refuses any value but true or false', () => {
    Object.assign(process.env, base, { PRESCRIPTION_DISPENSING_DETAILS_ENABLED: 'yes' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/PRESCRIPTION_DISPENSING_DETAILS_ENABLED/);
  });

  it('leaves the create body to its route pipe: the declared body type is not a class the global pipe checks', () => {
    const types = Reflect.getMetadata('design:paramtypes', PrescriptionsController.prototype, 'create') as unknown[];
    expect(types.at(-1)).toBe(Object);
  });
});

// Over HTTP, through Nest with the app's global pipe and filter: the create
// route answers a body with a detail exactly as a route declared as before
// (`@Body() input: CreatePrescriptionDto`) does while off, and takes it while on.
describe('the create route over HTTP', () => {
  @Controller('before')
  class BeforeController {
    @Post()
    create(@Body() input: CreatePrescriptionDto) {
      return { received: input };
    }
  }

  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const start = async (enabled: boolean) => {
    const received: unknown[] = [];
    const service = { create: jest.fn(async (_context, _patient, _encounter, input: unknown) => {
      received.push(input);
      return { id: prescriptionId };
    }) };
    @Module({ controllers: [PrescriptionsController, BeforeController], providers: [
      { provide: PrescriptionsService, useValue: service },
      { provide: PrescriptionDispensingDetails, useValue: new PrescriptionDispensingDetails(enabled) }] })
    class TestModule {}
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((request: Request & Record<string, unknown>, _response: Response, next: NextFunction) => {
      request.actor = context.actor;
      request.facilityId = facilityId;
      request.correlationId = 'correlation-123456';
      next();
    });
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const post = async (path: string, payload: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', 'idempotency-key': 'create-key-0000001',
          'x-purpose-of-use': 'direct-care' } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    return { post, received };
  };
  const route = `/ehr/patients/${patientId}/encounters/${encounterId}/prescriptions`;

  it('off: a detail field gets today\'s 400, word for word, and the service is not called', async () => {
    const { post, received } = await start(false);
    for (const payload of [{ ...body, priority: 'urgent' }, { ...body, ...details }, { ...body, frequency: '', strength: null }]) {
      const answer = await post(route, payload);
      expect(answer).toEqual(await post('/before', payload));
      expect(answer.status).toBe(400);
    }
    expect(received).toHaveLength(0);
    const accepted = await post(route, body);
    expect(accepted.status).toBe(201);
    expect(received[0]).toBeInstanceOf(CreatePrescriptionDto);
    expect(received[0]).toEqual((await post('/before', body)).body.received);
  });

  it('on: the details reach the service, and an unknown field is still refused', async () => {
    const { post, received } = await start(true);
    expect((await post(route, { ...body, ...details })).status).toBe(201);
    expect(received[0]).toBeInstanceOf(CreatePrescriptionWithDetailsDto);
    expect(received[0]).toMatchObject(details);
    const unknown = await post(route, { ...body, imageUrl: 'https://example.invalid/a.png' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors).toEqual([{ field: 'imageUrl', messages: ['property imageUrl should not exist'] }]);
  });
});
