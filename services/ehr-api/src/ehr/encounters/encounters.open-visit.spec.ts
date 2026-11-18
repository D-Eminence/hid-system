import { ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import { requestDigest } from '../../common/idempotency';
import type { DataAccessContext } from '../../common/request-context';
import { CreateEncounterDto, EncounterStatus, EncounterType } from '../shared/clinical.dto';
import { EncountersController } from './encounters.controller';
import { EncountersService, type EncounterRow } from './encounters.service';
import { lagosCalendarDate, lagosDaySql } from './lagos-day';

// Fictional identifiers only.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const openVisitId = '123e4567-e89b-42d3-a456-426614174020';

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['doctor'], permissions: [], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['doctor'],
      permissions: [], isPrimary: true } } } as unknown as DataAccessContext;

const visit = (overrides: Partial<EncounterRow> = {}): EncounterRow => ({
  id: openVisitId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  encounterNumber: null, encounterType: 'ambulatory', status: EncounterStatus.InProgress,
  startedAt: new Date('2026-11-18T08:00:00Z'), endedAt: null, chiefComplaint: 'Fever', rowVersion: '1',
  createdAt: new Date('2026-11-18T08:00:00Z'), updatedAt: new Date('2026-11-18T08:00:00Z'),
  importedPaperRecords: false, ...overrides,
});

const createBody = (overrides: Partial<CreateEncounterDto> = {}): CreateEncounterDto => ({
  encounterType: EncounterType.Ambulatory, status: EncounterStatus.InProgress, startedAt: '2026-11-18T09:00:00.000Z',
  reuseOpenVisit: true, ...overrides,
});

const OPEN_LOOKUP = /from ehr\.encounters\s+where patient_id = \$1 and facility_id = \$2\s+and status = any/;
const LOCK = /pg_advisory_xact_lock\(hashtextextended\('ehr\.open-visit:'/;

describe('EHR-C1 Lagos day', () => {
  it('is the Lagos calendar date: 23:59 and 00:01 in Lagos are different days', () => {
    expect(lagosCalendarDate(new Date('2026-11-18T22:59:00Z'))).toBe('2026-11-18'); // 23:59 in Lagos
    expect(lagosCalendarDate(new Date('2026-11-18T23:01:00Z'))).toBe('2026-11-19'); // 00:01 in Lagos
    expect(lagosCalendarDate(new Date('2026-11-18T23:00:00Z'))).toBe('2026-11-19'); // midnight in Lagos
    expect(lagosCalendarDate(new Date('2026-11-18T00:30:00Z'))).toBe('2026-11-18'); // 01:30 in Lagos, still the 18th
  });

  it('bounds the day by Lagos midnights in the database', () => {
    expect(lagosDaySql('started_at', 3)).toBe(`started_at >= ($3::date::timestamp at time zone 'Africa/Lagos')
     and started_at < (($3::date + 1)::timestamp at time zone 'Africa/Lagos')`);
  });
});

describe('EHR-C1 GET ehr/patients/:patientId/encounters/open-today', () => {
  it('is a GET for encounter readers, declared before :encounterId so the word is not read as an id', () => {
    const handler = EncountersController.prototype.openToday;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('open-today');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.encounter.read']);
    const names = Object.getOwnPropertyNames(EncountersController.prototype);
    expect(names.indexOf('openToday')).toBeLessThan(names.indexOf('get'));
  });

  function setup(found: EncounterRow | undefined, now: string) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: OPEN_LOOKUP.test(sql) && found ? [found] : [] };
    }) };
    const audits: Record<string, unknown>[] = [];
    const repository = { run: jest.fn(async (_c, _p, access, event, operation) => {
      const result = await operation(client);
      audits.push({ access, action: event.action, resourceId: result.resourceId ?? event.resourceId,
        details: { ...event.details, ...result.details } });
      return result.value;
    }) };
    const service = new EncountersService(repository as never);
    service.now = () => new Date(now);
    return { service, calls, audits };
  }

  it('answers the open visit started today, read under consent and audited', async () => {
    const { service, calls, audits } = setup(visit(), '2026-11-18T10:00:00Z');
    await expect(service.openToday(context, patientId)).resolves.toEqual({ day: '2026-11-18', timeZone: 'Africa/Lagos',
      encounter: visit() });
    expect(calls[0]?.values).toEqual([patientId, facilityId, '2026-11-18', ['planned', 'in_progress', 'on_hold']]);
    expect(calls[0]?.sql).toMatch(/not imported_paper_records/);
    expect(calls[0]?.sql).toContain(lagosDaySql('started_at', 3));
    expect(audits).toEqual([{ access: 'read_records', action: 'ehr.encounter.open-today', resourceId: openVisitId,
      details: { day: '2026-11-18', found: true } }]);
  });

  it('answers encounter null when there is none, still audited', async () => {
    const { service, audits } = setup(undefined, '2026-11-18T10:00:00Z');
    await expect(service.openToday(context, patientId)).resolves.toMatchObject({ encounter: null });
    expect(audits[0]).toMatchObject({ details: { found: false } });
  });

  it('asks for the next Lagos day at 00:01, so a visit opened at 23:59 the day before is not today\'s', async () => {
    const { service, calls } = setup(undefined, '2026-11-18T23:01:00Z');
    await expect(service.openToday(context, patientId)).resolves.toMatchObject({ day: '2026-11-19', encounter: null });
    expect(calls[0]?.values[2]).toBe('2026-11-19');
  });

  it('carries a 403 from the repository unchanged (the repository audits the refusal)', async () => {
    const repository = { run: jest.fn().mockRejectedValue(Object.assign(new Error('Active consent'), { status: 403,
      code: 'CONSENT_REQUIRED' })) };
    const service = new EncountersService(repository as never);
    await expect(service.openToday(context, patientId)).rejects.toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
    expect(repository.run.mock.calls[0]?.[2]).toBe('read_records');
  });
});

/**
 * A fake database for the create path: committed visits, one advisory lock
 * per key held until the transaction ends, and a READ COMMITTED lookup
 * (each statement sees what was committed before it ran).
 */
function fakeDatabase(committed: EncounterRow[] = []) {
  const locks = new Map<string, Promise<void>>();
  const log: string[] = [];
  let created = 0;
  const repository = {
    run: jest.fn(async (_c, _p, _a, _event, operation) => {
      const pending: EncounterRow[] = [];
      const releases: (() => void)[] = [];
      const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
        if (LOCK.test(sql)) {
          const key = values.join(':');
          log.push('lock');
          while (locks.has(key)) await locks.get(key);
          let release!: () => void;
          locks.set(key, new Promise<void>((resolve) => { release = () => { locks.delete(key); resolve(); }; }));
          releases.push(release);
          return { rows: [] };
        }
        if (OPEN_LOOKUP.test(sql)) {
          log.push('lookup');
          return { rows: committed.filter((row) => row.status !== 'completed').slice(0, 1) };
        }
        if (/insert into ehr\.encounters/.test(sql)) {
          created += 1;
          log.push('insert');
          // Give the other request a chance to run between the insert and the commit.
          await new Promise((resolve) => setImmediate(resolve));
          const row = visit({ id: `123e4567-e89b-42d3-a456-4266141741${String(created).padStart(2, '0')}` });
          pending.push(row);
          return { rows: [row] };
        }
        return { rows: [] };
      }) };
      try {
        const result = await operation(client);
        committed.push(...pending);
        return result.value;
      } finally {
        for (const release of releases) release();
      }
    }),
    executeCreate: jest.fn(async (_client, _c, _p, _k, _o, _d, _r, create) => {
      const result = await create();
      return { value: result.value, resourceId: result.id, details: result.details };
    }),
  };
  const service = new EncountersService(repository as never);
  service.now = () => new Date('2026-11-18T10:00:00Z');
  return { service, repository, log, committed, createdCount: () => created };
}

describe('EHR-C1 create with reuseOpenVisit', () => {
  it('reuses the open visit today instead of creating one', async () => {
    const { service, log, createdCount } = fakeDatabase([visit()]);
    await expect(service.create(context, patientId, createBody(), 'visit-key-00000001'))
      .resolves.toEqual({ ...visit(), reusedOpenVisit: true });
    expect(createdCount()).toBe(0);
    expect(log).toEqual(['lock', 'lookup']);
  });

  it('creates a visit when there is none, and says so', async () => {
    const { service, log } = fakeDatabase();
    const created = await service.create(context, patientId, createBody(), 'visit-key-00000001');
    expect(created).toMatchObject({ reusedOpenVisit: false });
    expect(log).toEqual(['lock', 'lookup', 'insert']);
  });

  it.each([[true], [false]])('a replay of the same request answers the same visit with reusedOpenVisit %p', async (reused) => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (/from ehr\.idempotency_keys key_row/.test(sql)) return { rows: [{ reused }] };
      if (/from ehr\.encounters where id = \$1/.test(sql)) return { rows: [visit()] };
      return { rows: [] };
    }) };
    const repository = {
      run: jest.fn(async (_c, _p, _a, _e, operation) => (await operation(client)).value),
      executeCreate: jest.fn(async (_client, _c, _p, _k, _o, _d, _r, _create, load) =>
        ({ value: await load(openVisitId), resourceId: openVisitId, details: { idempotentReplay: true } })),
    };
    const service = new EncountersService(repository as never);
    await expect(service.create(context, patientId, createBody(), 'visit-key-00000001'))
      .resolves.toEqual({ ...visit(), reusedOpenVisit: reused });
    const key = calls.find((call) => /from ehr\.idempotency_keys key_row/.test(call.sql));
    // Review finding 5: decided by whether the visit's create version and the key's create version were
    // written by the same request (correlation id and account); creation times only when they cannot be seen.
    const sql = key?.sql.replace(/\s+/g, ' ') ?? '';
    expect(sql).toContain('encounter_version.correlation_id is distinct from key_version.correlation_id');
    expect(sql).toContain('encounter_version.changed_by is distinct from key_version.changed_by');
    expect(sql).toContain("encounter_version.resource_type = 'encounters' and encounter_version.resource_id = encounter_row.id::text and encounter_version.version_no = 1");
    expect(sql).toContain("key_version.resource_type = 'idempotency_keys' and key_version.resource_id = key_row.id::text and key_version.version_no = 1");
    expect(sql).toMatch(/coalesce\(.*, encounter_row\.created_at < key_row\.created_at\) as reused/);
    expect(key?.values).toEqual([openVisitId, patientId, facilityId, accountId, 'encounter.create', 'visit-key-00000001']);
  });

  it('gives one visit for two requests at the same moment', async () => {
    const { service, committed, createdCount } = fakeDatabase();
    const [first, second] = await Promise.all([
      service.create(context, patientId, createBody(), 'visit-key-00000001'),
      service.create(context, patientId, createBody(), 'visit-key-00000002'),
    ]);
    expect(createdCount()).toBe(1);
    expect(committed).toHaveLength(1);
    expect(first.id).toBe(second.id);
    expect([first.reusedOpenVisit, second.reusedOpenVisit].sort()).toEqual([false, true]);
  });

  it('without reuseOpenVisit creates as before: no lock, no lookup, no new field', async () => {
    const { service, log } = fakeDatabase([visit()]);
    const created = await service.create(context, patientId, createBody({ reuseOpenVisit: undefined }), 'visit-key-00000001');
    expect(log).toEqual(['insert']);
    expect(created).not.toHaveProperty('reusedOpenVisit');
  });

  it('keeps the Idempotency-Key digest of a body without reuseOpenVisit', async () => {
    const { service, repository } = fakeDatabase();
    const body = createBody({ reuseOpenVisit: undefined });
    await service.create(context, patientId, body, 'visit-key-00000001');
    const { reuseOpenVisit: _reuse, ...before } = body;
    expect(repository.executeCreate.mock.calls[0]?.[5]).toBe(requestDigest('encounter.create', { patientId, input: before }));
  });

  it.each([EncounterStatus.Completed, EncounterStatus.Cancelled, EncounterStatus.EnteredInError, EncounterStatus.OnHold])(
    'refuses reuseOpenVisit with status %s before the database', async (status) => {
      const { service, repository } = fakeDatabase();
      expect(() => service.create(context, patientId, createBody({ status }), 'visit-key-00000001'))
        .toThrow(expect.objectContaining({ status: 400, code: 'REUSE_OPEN_VISIT_NEEDS_OPEN_STATUS' }));
      expect(repository.run).not.toHaveBeenCalled();
    });

  // Review finding 3: the visit a reuse request would create must start on the day the lookup is for.
  it.each([
    ['a desk clock 2 hours behind just after midnight (yesterday 22:30 in Lagos)', '2026-11-18T23:30:00Z',
      '2026-11-18T21:30:00.000Z'],
    ['a planned visit for tomorrow', '2026-11-18T10:00:00Z', '2026-11-19T09:00:00.000Z'],
  ])('refuses reuseOpenVisit with a start time that is not today: %s', async (_label, now, startedAt) => {
    const { service, repository } = fakeDatabase([visit()]);
    service.now = () => new Date(now);
    expect(() => service.create(context, patientId, createBody({ startedAt, status: EncounterStatus.Planned }),
      'visit-key-00000001')).toThrow(expect.objectContaining({ status: 400, code: 'REUSE_OPEN_VISIT_STARTED_AT_NOT_TODAY',
      message: 'To use the open visit today, the visit must start today (Lagos time). Check the date and time on this device.' }));
    expect(repository.run).not.toHaveBeenCalled();
  });

  it('a double tap with a slow clock no longer creates two visits dated yesterday (both are refused)', async () => {
    const { service, createdCount } = fakeDatabase();
    service.now = () => new Date('2026-11-18T23:30:00Z'); // 00:30 on the 19th in Lagos
    const body = createBody({ startedAt: '2026-11-18T21:30:00.000Z' }); // 22:30 on the 18th in Lagos
    for (const key of ['visit-key-00000001', 'visit-key-00000002']) {
      expect(() => service.create(context, patientId, body, key)).toThrow(expect.objectContaining({ status: 400 }));
    }
    expect(createdCount()).toBe(0);
  });

  it('accepts a start time anywhere in today\'s Lagos day, its edges included', async () => {
    for (const [now, startedAt] of [['2026-11-18T23:30:00Z', '2026-11-18T23:00:00.000Z'],
      ['2026-11-18T10:00:00Z', '2026-11-18T22:59:59.999Z']]) {
      const { service, createdCount } = fakeDatabase();
      service.now = () => new Date(now as string);
      await expect(service.create(context, patientId, createBody({ startedAt: startedAt as string }), 'visit-key-00000001'))
        .resolves.toMatchObject({ reusedOpenVisit: false });
      expect(createdCount()).toBe(1);
    }
  });

  it('without reuseOpenVisit any start time is accepted, as before', async () => {
    const { service, createdCount } = fakeDatabase();
    await service.create(context, patientId, createBody({ reuseOpenVisit: undefined, startedAt: '2026-11-25T09:00:00.000Z',
      status: EncounterStatus.Planned }), 'visit-key-00000001');
    expect(createdCount()).toBe(1);
  });

  it('accepts reuseOpenVisit only as a boolean, never null', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true });
    const body = { encounterType: 'ambulatory', status: 'in_progress', startedAt: '2026-11-18T09:00:00.000Z' };
    for (const reuseOpenVisit of [null, 'true', 1]) {
      await expect(pipe.transform({ ...body, reuseOpenVisit }, { type: 'body', metatype: CreateEncounterDto }))
        .rejects.toMatchObject({ status: 400 });
    }
    await expect(pipe.transform({ ...body, reuseOpenVisit: true }, { type: 'body', metatype: CreateEncounterDto }))
      .resolves.toMatchObject({ reuseOpenVisit: true });
  });
});
