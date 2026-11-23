import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { requestDigest } from '../../common/idempotency';
import type { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import { CreatePrescriptionDto, CreatePrescriptionWithDetailsAndRefillsDto, CreatePrescriptionWithDetailsDto,
  CreatePrescriptionWithRefillsDto, OrderStatus, UpdatePrescriptionDto } from '../shared/clinical.dto';
import { CreatePrescriptionBodyPipe, PRESCRIPTION_DISPENSING_DETAILS_OFF,
  PrescriptionDispensingDetails } from './prescription-dispensing-details';
import { PRESCRIPTION_REFILLS_OFF, PrescriptionRefills } from './prescription-refills';
import { PrescriptionsModule } from './prescriptions.module';
import { PrescriptionsService } from './prescriptions.service';

/*
 * ORD-12 (refills; owner decision Q131 A, 19 November 2026; the clinical
 * owner's design note on hid-system#258, Rahman's review and the clinical
 * owner's answers, 23 November 2026; migration 0152): the prescriber sets
 * refills 0-11 when writing, behind PRESCRIPTION_REFILLS_ENABLED (separate
 * from 0125's setting). Off, the create body, the statements, the answers and
 * the list are exactly as before; on, a create may carry `refillsAllowed`, it
 * is stored (left out: null, none), every prescription answer of these routes
 * carries it (null as 0), the list says `refills: true`, and a body without it
 * keeps its Idempotency-Key digest. The update route never takes it. Fictional
 * ids only.
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

const body = { medicationDisplay: 'Amlodipine 5 mg tablet', doseQuantity: 1, doseUnit: 'tablet', routeCode: 'oral',
  frequency: 'Once daily', instructions: 'In the morning', startsOn: '2026-11-02', endsOn: '2027-02-01',
  status: 'active' };
const details = { priority: 'routine', strength: '5 mg', doseForm: 'tablet', durationValue: 30, durationUnit: 'day',
  quantityToDispense: 30, quantityUnit: 'tablet' };

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const problem = error as DomainProblem;
    return { status: problem.getStatus(), code: problem.code, errors: problem.errors };
  }
  throw new Error('expected a refusal');
};
const pipe = (refills: boolean, withDetails = false) => new CreatePrescriptionBodyPipe(
  new PrescriptionDispensingDetails(withDetails), new PrescriptionRefills(refills));

/** A database row as node-postgres gives it: the refills column (a smallint, a number) when the statement named it. */
const row = (sql: string, refillsAllowed: number | null) => ({
  id: prescriptionId, encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  medicationCodeSystem: null, medicationCode: null, medicationDisplay: 'Amlodipine 5 mg tablet', doseQuantity: '1.0000',
  doseUnit: 'tablet', routeCode: 'oral', frequency: 'Once daily', instructions: 'In the morning', startsOn: '2026-11-02',
  endsOn: '2027-02-01', status: OrderStatus.Active, rowVersion: '1', createdAt: new Date('2026-11-02T10:00:00Z'),
  updatedAt: new Date('2026-11-02T10:00:00Z'),
  ...(/medication_strength/.test(sql) ? { priority: 'routine', strength: '5 mg', doseForm: null, durationValue: null,
    durationUnit: null, quantityToDispense: null, quantityUnit: null } : {}),
  ...(/refills_allowed as "refillsAllowed"/.test(sql) ? { refillsAllowed } : {}),
});
const TODAYS_KEYS = Object.keys(row('', null));

const harness = (refills: boolean | undefined, options: { details?: boolean; stored?: number | null } = {}) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
    statements.push({ sql, values: parameters });
    if (/ehr\.context_allows\(/.test(sql)) return { rows: [{ allowed: true }] };
    if (/pg_advisory_xact_lock|recorded_allergies|patient_reported_health_profiles|prescription_allergy_acknowledgements/
      .test(sql)) return { rows: [] };
    if (/encounters|neverReached|prescription_versions|change_reason|set_config/.test(sql)) return { rows: [{}] };
    return { rows: [row(sql, options.stored === undefined ? 2 : options.stored)] };
  }) };
  const repository = {
    run: jest.fn(async (_context, _patient, _access, _event, operation) => (await operation(client)).value),
    executeCreate: jest.fn(async (_client, _context, _patient, _key, _operation, digest, _type, create) =>
      ({ ...(await create()), digest })),
    setChangeReason: jest.fn(),
  };
  const routes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };
  const detailsReader = options.details ? new PrescriptionDispensingDetails(true) : PRESCRIPTION_DISPENSING_DETAILS_OFF;
  const service = refills === undefined
    ? new PrescriptionsService(repository as never, {} as never, routes as never, detailsReader)
    : new PrescriptionsService(repository as never, {} as never, routes as never, detailsReader, undefined,
      new PrescriptionRefills(refills));
  const digest = () => (repository.executeCreate.mock.calls.at(-1) as unknown[] | undefined)?.[5];
  return { service, statements, digest };
};
const create = async (service: PrescriptionsService, input: object) => service.create(context, patientId, encounterId,
  input as CreatePrescriptionDto, 'create-key-0000001') as Promise<Record<string, unknown>>;
const insertOf = (statements: { sql: string; values: unknown[] }[]) =>
  statements.find(({ sql }) => /insert into ehr\.prescriptions/.test(sql))!;

describe('refills: off (the default)', () => {
  it.each([[false], [true]])('E1 refuses refillsAllowed as any field the route does not take (0125 details on: %p)',
    async (withDetails) => {
      const answer = await refusal(pipe(false, withDetails).transform({ ...body, ...(withDetails ? details : {}),
        refillsAllowed: 2 }));
      expect(answer).toEqual({ status: 400, code: 'VALIDATION_FAILED',
        errors: [{ field: 'refillsAllowed', messages: ['property refillsAllowed should not exist'] }] });
      // The same as the class each setting gave before ORD-12.
      expect(answer).toEqual(await refusal(createValidationPipe().transform({ ...body, ...(withDetails ? details : {}),
        refillsAllowed: 2 }, { type: 'body', data: undefined,
        metatype: withDetails ? CreatePrescriptionWithDetailsDto : CreatePrescriptionDto })));
    });

  it.each([['no setting passed (every existing caller)', undefined], ['the setting false', false]])(
    'E2 with %s, the statements, the answers, the list and the digest are today\'s', async (_label, refills) => {
      const { service, statements, digest } = harness(refills);
      const input = await pipe(false).transform({ ...body });
      expect(input).toBeInstanceOf(CreatePrescriptionDto);
      expect(input).not.toBeInstanceOf(CreatePrescriptionWithRefillsDto);
      const created = await create(service, input);
      expect(insertOf(statements).values).toHaveLength(16);
      expect(Object.keys(created)).toEqual(TODAYS_KEYS);
      expect(digest()).toBe(requestDigest('prescription.create', { patientId, encounterId,
        input: plainToInstance(CreatePrescriptionDto, { ...body }) }));
      const page = await service.list(context, patientId, encounterId, { limit: 50 });
      expect('refills' in page).toBe(false);
      expect(Object.keys(page.items[0]!)).toEqual([...TODAYS_KEYS, 'orderRoute', 'allergyAcknowledgements']);
      expect(Object.keys(await service.get(context, patientId, encounterId, prescriptionId) as object))
        .toEqual([...TODAYS_KEYS, 'orderRoute', 'allergyAcknowledgements']);
      expect(statements.every(({ sql }) => !/refills_allowed/.test(sql))).toBe(true);
    });

  it('E3 is the shared off instance', () => {
    expect(PRESCRIPTION_REFILLS_OFF.enabled).toBe(false);
    expect([PRESCRIPTION_REFILLS_OFF.selectList(), PRESCRIPTION_REFILLS_OFF.insertColumns(),
      PRESCRIPTION_REFILLS_OFF.insertPlaceholders(17)]).toEqual(['', '', '']);
    expect(PRESCRIPTION_REFILLS_OFF.insertValues({ refillsAllowed: 3 })).toEqual([]);
    expect(PRESCRIPTION_REFILLS_OFF.flag()).toEqual({});
  });
});

describe('refills: on', () => {
  it('E4 takes 0 to 11, and a body without it', async () => {
    for (const refillsAllowed of [0, 1, 11]) {
      await expect(pipe(true).transform({ ...body, refillsAllowed })).resolves.toMatchObject({ refillsAllowed });
    }
    const without = await pipe(true).transform({ ...body });
    expect(without).toBeInstanceOf(CreatePrescriptionWithRefillsDto);
    expect((without as CreatePrescriptionWithRefillsDto).refillsAllowed).toBeUndefined();
  });

  it.each([[null], [-1], [12], [1.5], ['2'], [true]])('E5 refuses refillsAllowed %p, naming it', async (refillsAllowed) => {
    const answer = await refusal(pipe(true).transform({ ...body, refillsAllowed }));
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('VALIDATION_FAILED');
    expect(answer.errors?.map((error) => error.field)).toEqual(['refillsAllowed']);
  });

  it('E6 picks the class for each pair of settings, and still refuses an unknown field', async () => {
    expect(await pipe(true, true).transform({ ...body, ...details, refillsAllowed: 2 }))
      .toBeInstanceOf(CreatePrescriptionWithDetailsAndRefillsDto);
    expect(await pipe(true, false).transform({ ...body, refillsAllowed: 2 })).toBeInstanceOf(CreatePrescriptionWithRefillsDto);
    expect(await pipe(false, true).transform({ ...body, ...details })).toBeInstanceOf(CreatePrescriptionWithDetailsDto);
    // Refills on, details off: a detail field is still refused; details on, refills off: refillsAllowed is.
    expect((await refusal(pipe(true, false).transform({ ...body, priority: 'urgent' }))).errors)
      .toEqual([{ field: 'priority', messages: ['property priority should not exist'] }]);
    expect((await refusal(pipe(true).transform({ ...body, refillsRemaining: 1 }))).errors)
      .toEqual([{ field: 'refillsRemaining', messages: ['property refillsRemaining should not exist'] }]);
  });

  it.each([[false, 17], [true, 24]])('E7 stores it after today\'s columns (0125 details on: %p, placeholder $%p)',
    async (withDetails, placeholder) => {
      const { service, statements } = harness(true, { details: withDetails });
      await create(service, await pipe(true, withDetails).transform({ ...body, ...(withDetails ? details : {}),
        refillsAllowed: 3 }));
      const insert = insertOf(statements);
      expect(insert.sql).toMatch(new RegExp(`status${withDetails ? '[\\s\\S]*quantity_unit' : ''}, refills_allowed\\s*\\)`));
      expect(insert.sql).toMatch(new RegExp(`\\$${placeholder - 1},\\$${placeholder}\\)`));
      expect(insert.values).toHaveLength(placeholder);
      expect(insert.values.at(-1)).toBe(3);
      expect(insert.sql).toContain('returning');
      expect(insert.sql).toContain('refills_allowed as "refillsAllowed"');
    });

  it('E8 stores null when left out (none, as every prescription before 0152)', async () => {
    const { service, statements } = harness(true);
    await create(service, await pipe(true).transform({ ...body }));
    expect(insertOf(statements).values.at(-1)).toBeNull();
  });

  it('E9 every answer carries refillsAllowed last, null as 0; the list says refills: true', async () => {
    const { service } = harness(true, { stored: null });
    const created = await create(service, await pipe(true).transform({ ...body }));
    expect(Object.keys(created)).toEqual([...TODAYS_KEYS, 'refillsAllowed']);
    expect(created.refillsAllowed).toBe(0);
    const stored = harness(true, { stored: 4 });
    const page = await stored.service.list(context, patientId, encounterId, { limit: 50 });
    expect(page).toMatchObject({ refills: true });
    expect(page.items[0]).toMatchObject({ refillsAllowed: 4 });
    expect(Object.keys(page.items[0]!)).toEqual([...TODAYS_KEYS, 'refillsAllowed', 'orderRoute', 'allergyAcknowledgements']);
    expect(await stored.service.get(context, patientId, encounterId, prescriptionId)).toMatchObject({ refillsAllowed: 4 });
  });

  it('E10 with the 0125 details on too, the details come before refillsAllowed', async () => {
    const { service } = harness(true, { details: true, stored: 1 });
    const created = await create(service, await pipe(true, true).transform({ ...body, ...details, refillsAllowed: 1 }));
    expect(Object.keys(created)).toEqual([...TODAYS_KEYS, 'priority', 'strength', 'refillsAllowed']);
  });

  it('E11 keeps the Idempotency-Key digest of a body without it, and changes it with it', async () => {
    const off = harness(false);
    await create(off.service, await pipe(false).transform({ ...body }));
    const on = harness(true);
    await create(on.service, await pipe(true).transform({ ...body }));
    expect(on.digest()).toBe(off.digest());
    const two = harness(true);
    await create(two.service, await pipe(true).transform({ ...body, refillsAllowed: 2 }));
    const three = harness(true);
    await create(three.service, await pipe(true).transform({ ...body, refillsAllowed: 3 }));
    expect(new Set([off.digest(), two.digest(), three.digest()]).size).toBe(3);
  });

  it('E12 an update answers refillsAllowed and never sets it: its body refuses the field', async () => {
    const { service, statements } = harness(true, { stored: 2 });
    const updated = await service.update(context, patientId, encounterId, prescriptionId,
      { expectedRowVersion: 1, instructions: 'In the morning with water',
        changeReason: 'Clarified the instructions' } as never) as Record<string, unknown>;
    expect(updated.refillsAllowed).toBe(2);
    const update = statements.find(({ sql }) => /^\s*update ehr\.prescriptions/.test(sql))!;
    expect(update.sql.slice(0, update.sql.indexOf('where'))).not.toMatch(/refills_allowed/);
    const refused = await refusal(createValidationPipe().transform({ expectedRowVersion: 1, refillsAllowed: 3 },
      { type: 'body', data: undefined, metatype: UpdatePrescriptionDto }));
    expect(refused.errors).toEqual(expect.arrayContaining([{ field: 'refillsAllowed',
      messages: ['property refillsAllowed should not exist'] }]));
  });
});

describe('PRESCRIPTION_REFILLS_ENABLED', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid', CORS_ORIGINS: 'http://localhost:3000',
    STORAGE_MODE: 'disabled' };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
  const provider = () => (Reflect.getMetadata('providers', PrescriptionsModule) as unknown[]).find((entry) =>
    typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === PrescriptionRefills) as
    { useFactory: () => PrescriptionRefills };

  it('E13 is off unless set to true, separate from 0125\'s setting, and PrescriptionsModule follows it', () => {
    Object.assign(process.env, base, { PRESCRIPTION_DISPENSING_DETAILS_ENABLED: 'true' });
    delete process.env.PRESCRIPTION_REFILLS_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().PRESCRIPTION_REFILLS_ENABLED).toBe(false);
    expect(provider().useFactory().enabled).toBe(false);
    Object.assign(process.env, { PRESCRIPTION_REFILLS_ENABLED: 'true', PRESCRIPTION_DISPENSING_DETAILS_ENABLED: 'false' });
    resetEnvironmentForTests();
    expect(provider().useFactory().enabled).toBe(true);
    const types = Reflect.getMetadata('design:paramtypes', PrescriptionsService) as unknown[];
    expect(types.at(-1)).toBe(PrescriptionRefills);
  });

  it('E14 refuses any value but true or false', () => {
    Object.assign(process.env, base, { PRESCRIPTION_REFILLS_ENABLED: 'on' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/PRESCRIPTION_REFILLS_ENABLED/);
  });

  it('E15 Nest gives the pipe and the service the module\'s refills; without a provider both are off', async () => {
    const on = new PrescriptionRefills(true);
    const others = [{ provide: PrescriptionDispensingDetails, useValue: PRESCRIPTION_DISPENSING_DETAILS_OFF }];
    const withIt = await Test.createTestingModule({ providers: [CreatePrescriptionBodyPipe, ...others,
      { provide: PrescriptionRefills, useValue: on }] }).compile();
    expect((withIt.get(CreatePrescriptionBodyPipe) as unknown as { refills: unknown }).refills).toBe(on);
    const without = await Test.createTestingModule({ providers: [CreatePrescriptionBodyPipe, ...others] }).compile();
    expect((without.get(CreatePrescriptionBodyPipe) as unknown as { refills: unknown }).refills).toBe(PRESCRIPTION_REFILLS_OFF);
  });
});
