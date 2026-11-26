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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { PRESCRIPTION_REFILLS_OFF, PrescriptionRefills, REFILLS_COLLECTABLE_QUERY, REFILLS_NEED_DURATION_MESSAGE,
  refillsCannotBeCollectedMessage } from './prescription-refills';
import { PrescriptionsModule } from './prescriptions.module';
import { PrescriptionsService } from './prescriptions.service';

/*
 * ORD-12 (refills; owner decision Q131 A, 19 November 2026; the clinical
 * owner's design note on hid-system#258, Rahman's review and the clinical
 * owner's answers, 23 November 2026; migration 0154): the prescriber sets
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

/** The database's answer to REFILLS_COLLECTABLE_QUERY: collectable unless `never` names the two days. */
type Collectable = { never?: { refillsEndOn: string; firstRefillOn: string } };
const harness = (refills: boolean | undefined,
  options: { details?: boolean; stored?: number | null } & Collectable = {}) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
    statements.push({ sql, values: parameters });
    if (sql === REFILLS_COLLECTABLE_QUERY) {
      return { rows: [options.never ? { neverCollectable: true, ...options.never }
        : { neverCollectable: false, refillsEndOn: '2027-01-11', firstRefillOn: '2026-11-25' }] };
    }
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

  // Refills above 0 need a duration (E16), which a create carries only with 0125's details on: details off, 0 refills.
  it.each([[false, 17, 0], [true, 24, 3]])(
    'E7 stores it after today\'s columns (0125 details on: %p, placeholder $%p, refills %p)',
    async (withDetails, placeholder, refillsAllowed) => {
      const { service, statements } = harness(true, { details: withDetails });
      await create(service, await pipe(true, withDetails).transform({ ...body, ...(withDetails ? details : {}),
        refillsAllowed }));
      const insert = insertOf(statements);
      expect(insert.sql).toMatch(new RegExp(`status${withDetails ? '[\\s\\S]*quantity_unit' : ''}, refills_allowed\\s*\\)`));
      expect(insert.sql).toMatch(new RegExp(`\\$${placeholder - 1},\\$${placeholder}\\)`));
      expect(insert.values).toHaveLength(placeholder);
      expect(insert.values.at(-1)).toBe(refillsAllowed);
      expect(insert.sql).toContain('returning');
      expect(insert.sql).toContain('refills_allowed as "refillsAllowed"');
    });

  it('E8 stores null when left out (none, as every prescription before 0154)', async () => {
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
    const two = harness(true, { details: true });
    await create(two.service, await pipe(true, true).transform({ ...body, ...details, refillsAllowed: 2 }));
    const three = harness(true, { details: true });
    await create(three.service, await pipe(true, true).transform({ ...body, ...details, refillsAllowed: 3 }));
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

describe('refills need a duration (the clinical owner\'s refill interval, 24 November 2026)', () => {
  it.each([[true], [false]])('E16 refillsAllowed above 0 without a duration is 400 REFILLS_NEED_DURATION, nothing written '
    + '(0125 details on: %p)', async (withDetails) => {
    for (const refillsAllowed of [1, 11]) {
      const { service, statements } = harness(true, { details: withDetails });
      const input = await pipe(true, withDetails).transform({ ...body, refillsAllowed });
      expect(await refusal(create(service, input))).toEqual({ status: 400, code: 'REFILLS_NEED_DURATION', errors: undefined });
      expect(statements).toEqual([]);
    }
  });

  it('E17 refills 0 or left out need none; refills with a duration (each unit) are written', async () => {
    for (const extra of [{ refillsAllowed: 0 }, {}]) {
      const { service, statements } = harness(true);
      await create(service, await pipe(true).transform({ ...body, ...extra }));
      expect(insertOf(statements)).toBeDefined();
    }
    for (const unit of ['day', 'week', 'month']) {
      const { service, statements } = harness(true, { details: true });
      await create(service, await pipe(true, true).transform({ ...body, ...details, durationValue: 2, durationUnit: unit,
        refillsAllowed: 2 }));
      expect(insertOf(statements).values.at(-1)).toBe(2);
    }
  });

  it('E19 the refusal says the duration is how long one fill lasts, not the whole course', async () => {
    const { service } = harness(true, { details: true });
    const input = await pipe(true, true).transform({ ...body, refillsAllowed: 2 });
    let problem: unknown;
    try { await create(service, input); } catch (error) { problem = error; }
    expect(problem).toMatchObject({ code: 'REFILLS_NEED_DURATION' });
    expect((problem as Error).message).toBe(REFILLS_NEED_DURATION_MESSAGE);
    expect((problem as Error).message).toContain('the duration of each fill: how long one supply lasts, not the whole course');
    expect(REFILLS_NEED_DURATION_MESSAGE).toBe('A prescription with refills needs the duration of each fill: how long '
      + 'one supply lasts, not the whole course. Add it, or set refills to 0.');
  });

  it('E18 off, nothing is checked (the body cannot carry refillsAllowed); on, a value without its unit is refused', () => {
    expect(() => PRESCRIPTION_REFILLS_OFF.requireDuration({ refillsAllowed: 3 })).not.toThrow();
    expect(() => new PrescriptionRefills(true).requireDuration({ refillsAllowed: 3, durationValue: 10 }))
      .toThrow(expect.objectContaining({ code: 'REFILLS_NEED_DURATION' }));
  });
});

/*
 * Refills that can never be collected (Rahman's review of 25 November 2026;
 * the clinical owner's call on hid-system#258, 26 November 2026): ehr-api
 * refuses them at create, 400 REFILLS_CANNOT_BE_COLLECTED in plain words, by
 * the database's own rule (0154's ehr.prescription_refills_end_on and its
 * refill interval) on the row just written, never by a copy of the limit.
 */
describe('refills that can never be collected', () => {
  const longFill = { ...details, durationValue: 487, durationUnit: 'day' };
  const never = { refillsEndOn: '2027-11-26', firstRefillOn: '2027-11-27' };

  it('E20 are refused 400 REFILLS_CANNOT_BE_COLLECTED, with both days, after the INSERT and before any send', async () => {
    const { service, statements } = harness(true, { details: true, never });
    let problem: unknown;
    try {
      await create(service, await pipe(true, true).transform({ ...body, ...longFill, refillsAllowed: 1 }));
    } catch (error) { problem = error; }
    expect(problem).toMatchObject({ code: 'REFILLS_CANNOT_BE_COLLECTED', extensions: never });
    expect((problem as DomainProblem).getStatus()).toBe(400);
    expect((problem as Error).message).toBe('No refill of this prescription could ever be collected: refills end on '
      + '2027-11-26, before the first refill would be due (2027-11-27 at the earliest). Use a shorter duration of each '
      + 'fill or a later end date, or set refills to 0.');
    expect((problem as Error).message).toBe(refillsCannotBeCollectedMessage('2027-11-26', '2027-11-27'));
    const asked = statements.findIndex(({ sql }) => sql === REFILLS_COLLECTABLE_QUERY);
    expect(asked).toBeGreaterThan(statements.indexOf(insertOf(statements)));
    expect(statements[asked]!.values).toEqual([prescriptionId]);
    // Nothing after it: no send to the pharmacy, no audit of an acknowledgement (the transaction rolls back).
    expect(statements).toHaveLength(asked + 1);
  });

  it('E21 a prescription whose refills can be collected is written and answered as before', async () => {
    const { service, statements } = harness(true, { details: true, stored: 2 });
    const created = await create(service, await pipe(true, true).transform({ ...body, ...details, refillsAllowed: 2 }));
    expect(created.refillsAllowed).toBe(2);
    expect(statements.filter(({ sql }) => sql === REFILLS_COLLECTABLE_QUERY).map(({ values }) => values))
      .toEqual([[prescriptionId]]);
  });

  it('E22 nothing is asked while off, or with refills 0 or left out', async () => {
    for (const [on, input] of [[false, { ...body }], [true, { ...body }], [true, { ...body, refillsAllowed: 0 }]] as const) {
      const { service, statements } = harness(on, { never });
      await create(service, await pipe(on).transform(input));
      expect(statements.some(({ sql }) => sql === REFILLS_COLLECTABLE_QUERY)).toBe(false);
    }
    const asked = jest.fn();
    await PRESCRIPTION_REFILLS_OFF.requireCollectable({ query: asked } as never, prescriptionId, { refillsAllowed: 3 });
    expect(asked).not.toHaveBeenCalled();
  });

  it('E23 the rule is the database\'s: 0154\'s last day, called on the stored row, and 0154\'s own interval text', () => {
    const migration = readFileSync(path.resolve(__dirname,
      '../../../database/migrations/0154_prescription_refills.sql'), 'utf8');
    const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
    const query = flat(REFILLS_COLLECTABLE_QUERY);
    expect(query).toContain('ehr.prescription_refills_end_on(p.created_at, p.refills_allowed, p.duration_value, '
      + 'p.duration_unit, p.ends_on) as refills_end_on');
    expect(query).toContain('from ehr.prescriptions p where p.id = $1::uuid');
    // The refill interval exactly as pharmacy.validate_dispensing (R4) writes it, on the prescription's own columns.
    const validator = migration.slice(migration.indexOf('create or replace function pharmacy.validate_dispensing()'));
    const interval = /\+ greatest\(1, ceil\(0\.75 \* source_row\.duration_value\s+\* case source_row\.duration_unit[^)]*\)\)::integer/
      .exec(validator);
    expect(interval).not.toBeNull();
    expect(query).toContain(`(p.created_at at time zone 'Africa/Lagos')::date ${flat(interval![0])
      .replaceAll('source_row.', 'p.')} as first_refill_on`);
    expect(query).toContain('first_refill_on > refills_end_on as "neverCollectable"');
    // No copy of the limit: no day count of its own.
    expect(REFILLS_COLLECTABLE_QUERY).not.toMatch(/\b(365|366|486|487)\b/);
  });
});

/*
 * The same query on PostgreSQL, against 0154's own ehr.prescription_refills_end_on
 * (its CREATE statement read from the migration file). Runs only when
 * EHR_REFILLS_SCRATCH_DATABASE_URL names an empty scratch database whose name
 * ends in `_scratch` (skipped otherwise, so CI without a database is
 * unchanged); it makes an `ehr` schema there with the columns the query reads,
 * and drops it afterwards. Fictional rows only.
 */
const scratchUrl = process.env.EHR_REFILLS_SCRATCH_DATABASE_URL;
const describeScratch = scratchUrl !== undefined && /\/[A-Za-z0-9_]*_scratch(\?|$)/.test(scratchUrl)
  ? describe : describe.skip;
describeScratch('refills that can never be collected, on PostgreSQL with 0154\'s rule', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: scratchUrl, max: 1 });
    const migration = readFileSync(path.resolve(__dirname,
      '../../../database/migrations/0154_prescription_refills.sql'), 'utf8');
    const start = migration.indexOf('create function ehr.prescription_refills_end_on(');
    const end = migration.indexOf('$$;', migration.indexOf('as $$', start) + 5) + 3;
    await pool.query('create schema ehr');
    await pool.query(`create table ehr.prescriptions (id uuid primary key, created_at timestamptz not null,
      refills_allowed smallint, duration_value integer, duration_unit text, ends_on date)`);
    await pool.query(migration.slice(start, end));
  });
  afterAll(async () => {
    await pool.query('drop schema if exists ehr cascade');
    await pool.end();
  });

  it('E24 one fill of 486 days, 69 weeks or 16 months can be collected; 487 days, 70 weeks or 17 months cannot; an '
    + 'end date on the first refill\'s day can, the day before cannot; the Lagos day written, whatever the time zone',
  async () => {
    // Written at 23:30 Lagos on 1 March 2027 (22:30 UTC): the Lagos day written is 1 March.
    const written = '2027-03-01T22:30:00Z';
    const cases: [string, number, number, string, string | null][] = [
      ['486 days', 1, 486, 'day', null], ['487 days', 1, 487, 'day', null],
      ['69 weeks', 11, 69, 'week', null], ['70 weeks', 11, 70, 'week', null],
      ['16 months', 2, 16, 'month', null], ['17 months', 2, 17, 'month', null],
      ['10 days, ends on day 8', 1, 10, 'day', '2027-03-09'], ['10 days, ends on day 7', 1, 10, 'day', '2027-03-08'],
    ];
    const answers: Record<string, unknown> = {};
    for (const [index, [label, refills, value, unit, endsOn]] of cases.entries()) {
      const id = `00000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`;
      await pool.query('insert into ehr.prescriptions values ($1, $2, $3, $4, $5, $6)',
        [id, written, refills, value, unit, endsOn]);
      for (const zone of ['UTC', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
        await pool.query(`set timezone = '${zone}'`);
        const { rows } = await pool.query(REFILLS_COLLECTABLE_QUERY, [id]);
        answers[`${label} ${zone}`] = rows[0];
      }
    }
    await pool.query('reset timezone');
    const expected = (label: string, never: boolean, refillsEndOn: string, firstRefillOn: string) =>
      Object.fromEntries(['UTC', 'Pacific/Kiritimati', 'Etc/GMT+12'].map((zone) =>
        [`${label} ${zone}`, { neverCollectable: never, refillsEndOn, firstRefillOn }]));
    expect(answers).toEqual({
      ...expected('486 days', false, '2028-02-29', '2028-02-29'),
      ...expected('487 days', true, '2028-02-29', '2028-03-01'),
      ...expected('69 weeks', false, '2028-02-29', '2028-02-27'),
      ...expected('70 weeks', true, '2028-02-29', '2028-03-03'),
      ...expected('16 months', false, '2028-02-29', '2028-02-24'),
      ...expected('17 months', true, '2028-02-29', '2028-03-18'),
      ...expected('10 days, ends on day 8', false, '2027-03-09', '2027-03-09'),
      ...expected('10 days, ends on day 7', true, '2027-03-08', '2027-03-09'),
    });
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
