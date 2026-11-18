jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IDENTITY_PROVIDER, type AuthorizationDecision, type IdentityPatient, type IdentityProvider } from './identity.types';
import {
  healthIdSide,
  type LookupSide,
  PATIENT_LOOKUP_MISS_WINDOW,
  PATIENT_NOT_FOUND_MESSAGE,
  PatientLookupMissService,
} from './patient-lookup-miss.service';

/**
 * Q100 B (owner decision of 18 Nov 2026): a Health ID that no patient record
 * has answers 404 PATIENT_NOT_FOUND "No patient has this Health ID."; a
 * patient that exists but is not available here keeps today's answer. Both
 * are counted (30 in 10 minutes per staff account, whichever of its
 * facilities it works at) and audited without the Health ID. The issued
 * check is asked only when the Health ID and the member's facility are on
 * the same side of the seals (real, demo 0098, QA 0123). Fictional people
 * and Health IDs only.
 */
const patientId = '7c1f0d2e-3c4a-4b5d-8e6f-7a8b9c0d1e2f';
const membershipId = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const facilityId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const KNOWN = 'HID-QX7K2M';
const NOBODY = 'HID-NEWPAT';
/** Fictional sealed-tenant Health IDs in the 0098 and 0123 shapes, none of them seeded. */
const DEMO_NOBODY = 'HID-ZDEMQQQ7';
const QA_NOBODY = 'HID-ZQAQQQQ7';
const SIDE_HEALTH_ID: Readonly<Record<LookupSide, string>> = { real: NOBODY, demo: DEMO_NOBODY, qa: QA_NOBODY };
const FACILITY_SIDE_SQL =
  'select identity.sealed_demo_facility($1::uuid) as demo, identity.sealed_qa_facility($1::uuid) as qa';
const ISSUED_SQL = 'select health_id from identity.support_health_id_matches($1::text[])';
/** identity.sealed_demo_facility and identity.sealed_qa_facility's answer for each side. */
const FACILITY_ROWS: Readonly<Record<LookupSide, { rows: { demo: boolean; qa: boolean }[] }>> = {
  real: { rows: [{ demo: false, qa: false }] },
  demo: { rows: [{ demo: true, qa: false }] },
  qa: { rows: [{ demo: false, qa: true }] },
};
const SIDES: readonly LookupSide[] = ['real', 'demo', 'qa'];
const context = {
  actor: { kind: 'staff', subject: 'synthetic:desk', accountId: 'f0e1d2c3-b4a5-4968-8776-655443322110',
    permissions: ['identity.patient.read'], facility: { organizationId: 'org', membershipId } },
  facilityId, membershipId, correlationId: 'correlation-q100', purposeOfUse: 'direct-care',
} as unknown as DataAccessContext;
const patient: IdentityPatient = { id: patientId, hidCode: KNOWN, firstName: 'Ada', lastName: 'Fictional',
  fullName: 'Ada Fictional', dateOfBirth: '1991-04-05', gender: 'female', rowVersion: 3, ninVerified: false };
const allow: AuthorizationDecision = { allowed: true, patientId, facilityId, membershipId, scope: 'read_records',
  purpose: 'direct-care', consentGrantId: 'grant', breakGlass: false };
const deny: AuthorizationDecision = { ...allow, allowed: false, consentGrantId: undefined };

const UNVERIFIED = /unverified/i;

function setup(found: IdentityPatient | null, decision: AuthorizationDecision = allow,
  misses: { countMiss: jest.Mock; issued: jest.Mock } | null = {
    countMiss: jest.fn(async () => false), issued: jest.fn(async () => false) }) {
  const provider: IdentityProvider = {
    lookupExactHid: jest.fn(async () => found),
    authorize: jest.fn(async () => decision),
    consentStatus: jest.fn(),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new IdentityService(provider, audit as never, undefined, (misses ?? undefined) as never);
  return { service, audit, provider, misses: misses ?? undefined };
}

describe('Q100 B: staff Health ID lookup (IdentityService.lookupPatient)', () => {
  it('answers 404 PATIENT_NOT_FOUND in plain words when no patient record has the Health ID', async () => {
    const { service, audit, misses } = setup(null);
    const failure = await service.lookupPatient(NOBODY, 'direct-care', context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ status: 404, code: 'PATIENT_NOT_FOUND', message: 'No patient has this Health ID.' });
    expect(misses?.countMiss).toHaveBeenCalledWith(context);
    expect(misses?.issued).toHaveBeenCalledWith(NOBODY, context);
    // Audited, denied, with the result and never the Health ID.
    expect(audit.record).toHaveBeenCalledTimes(1);
    const row = (audit.record.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(row).toMatchObject({ action: 'identity.patient.lookup', outcome: 'denied', patientId: undefined,
      details: { lookupResult: 'no_such_patient' } });
    expect(JSON.stringify(row)).not.toContain(NOBODY);
  });

  it('keeps today\'s 404 for a patient that exists but is not available here (any status, sealed, or hidden)', async () => {
    const { service, audit } = setup(null, allow, { countMiss: jest.fn(async () => false), issued: jest.fn(async () => true) });
    const failure = await service.lookupPatient(KNOWN, 'direct-care', context).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ status: 404, message: 'Patient was not found or is not available' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied',
      details: { lookupResult: 'not_available' } }));
  });

  it('keeps today\'s 403 for a patient this lookup may see but not open, and counts it', async () => {
    const { service, audit, misses } = setup(patient, deny);
    await expect(service.lookupPatient(KNOWN, 'direct-care', context))
      .rejects.toMatchObject({ status: 403, message: 'Patient access is not authorized' });
    expect(misses?.countMiss).toHaveBeenCalledTimes(1);
    expect(misses?.issued).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', patientId,
      details: { lookupResult: 'not_authorized' } }));
  });

  it('gives a limited member today\'s 404 for a missing Health ID: never 429, never "No such patient"', async () => {
    const { service, audit, misses } = setup(null, allow,
      { countMiss: jest.fn(async () => true), issued: jest.fn(async () => false) });
    const failure = await service.lookupPatient(NOBODY, 'direct-care', context).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ status: 404, message: 'Patient was not found or is not available' });
    expect(misses?.issued).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', patientId: undefined,
      details: { lookupResult: 'limited' } }));
  });

  it('gives a limited member today\'s 403 for a patient this lookup may not open (a closed record still closes)',
    async () => {
      const { service, audit, misses } = setup(patient, deny,
        { countMiss: jest.fn(async () => true), issued: jest.fn(async () => false) });
      const failure = await service.lookupPatient(KNOWN, 'direct-care', context).catch((error: unknown) => error);
      expect(failure).not.toBeInstanceOf(DomainProblem);
      expect(failure).toMatchObject({ status: 403, message: 'Patient access is not authorized' });
      expect(misses?.issued).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', patientId,
        details: { lookupResult: 'limited' } }));
    });

  it.each([
    ['the member cannot be counted', undefined, false],
    ['the issued check cannot be read', false, undefined],
  ] as const)('fails closed to today\'s 404 when %s', async (_label, limited, issued) => {
    const { service, audit } = setup(null, allow,
      { countMiss: jest.fn(async () => limited), issued: jest.fn(async () => issued) });
    const failure = await service.lookupPatient(NOBODY, 'direct-care', context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 404, message: 'Patient was not found or is not available' });
    expect(failure).not.toBeInstanceOf(DomainProblem);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ details: { lookupResult: 'not_available' } }));
  });

  it('answers today\'s 404 when the service is built without the check (as before Q100)', async () => {
    const { service } = setup(null, allow, null);
    await expect(service.lookupPatient(NOBODY, 'direct-care', context))
      .rejects.toMatchObject({ status: 404, message: 'Patient was not found or is not available' });
  });

  it('opens an allowed patient as before, counting nothing and checking nothing', async () => {
    const { service, audit, misses } = setup(patient, allow);
    const answer = await service.lookupPatient(KNOWN, 'direct-care', context);
    expect(answer.patient).toMatchObject({ patientId, hid: KNOWN, ninStatus: 'not_verified' });
    expect(misses?.countMiss).not.toHaveBeenCalled();
    expect(misses?.issued).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', patientId,
      details: { consentGrantId: 'grant', breakGlass: false } }));
    expect(JSON.stringify(answer)).not.toMatch(UNVERIFIED);
  });

  it('never says "unverified" in any answer', () => {
    expect(`${PATIENT_NOT_FOUND_MESSAGE}`).not.toMatch(UNVERIFIED);
  });
});

describe('Q100 B: PatientLookupMissService', () => {
  const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', DATABASE_SSL: 'false',
    CORS_ORIGINS: 'https://healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    STORAGE_MODE: 'disabled' };
  beforeAll(() => { Object.assign(process.env, env); resetEnvironmentForTests(); });
  afterAll(() => { resetEnvironmentForTests(); });

  type Answer = { rows: readonly unknown[] } | Error;

  /** The issued check answers `answer`; the facility's side query answers `facility` (a real facility by default). */
  function missService(answer: Answer, facility: Answer = FACILITY_ROWS.real) {
    const queries: { sql: string; values: unknown[] }[] = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      const reply = /sealed_demo_facility|sealed_qa_facility/.test(sql) ? facility : answer;
      if (reply instanceof Error) throw reply;
      return reply;
    });
    const database = { query, withTransaction: jest.fn(async (_c: unknown, work: (client: unknown) => unknown) =>
      work({ query })) };
    return { service: new PatientLookupMissService(database as unknown as DatabaseService), queries, database };
  }
  const issuedAsked = (queries: { sql: string }[]) => queries.some((query) => query.sql === ISSUED_SQL);

  it('asks the facility\'s side, then 0109\'s issued check with the one Health ID, upper case', async () => {
    const { service, queries } = missService({ rows: [] });
    await expect(service.issued(' hid-newpat ', context)).resolves.toBe(false);
    expect(queries).toEqual([
      { sql: FACILITY_SIDE_SQL, values: [facilityId] },
      { sql: ISSUED_SQL, values: [[NOBODY]] },
    ]);
  });

  it('says issued when the check names the Health ID (any status: the function reads every patient)', async () => {
    const { service } = missService({ rows: [{ health_id: KNOWN }] });
    await expect(service.issued(KNOWN, context)).resolves.toBe(true);
  });

  it.each(SIDES.flatMap((side) => [
    [side, 'another Health ID', { rows: [{ health_id: 'HID-OTHER2' }] }],
    [side, 'two rows', { rows: [{ health_id: SIDE_HEALTH_ID[side] }, { health_id: SIDE_HEALTH_ID[side] }] }],
    [side, 'a null row', { rows: [{ health_id: null }] }],
    [side, 'a database failure', new Error('connection reset')],
  ] as const))('cannot tell (undefined) for a %s Health ID at its own side on %s', async (side, _label, answer) => {
    const { service, queries } = missService(answer, FACILITY_ROWS[side]);
    await expect(service.issued(SIDE_HEALTH_ID[side], context)).resolves.toBeUndefined();
    expect(issuedAsked(queries)).toBe(true);
  });

  it('cannot tell for a malformed Health ID, without asking the database', async () => {
    const { service, queries } = missService({ rows: [] });
    await expect(service.issued('HID-OOOO11', context)).resolves.toBeUndefined();
    await expect(service.issued('HID-ZDEMOOO1', context)).resolves.toBeUndefined();
    expect(queries).toEqual([]);
  });

  describe('the seals: real, demo (0098) and QA (0123) Health IDs and facilities', () => {
    it.each([
      ['HID-QX7K2M', 'real'], ['HID-NEWPAT', 'real'], ['HID-AB2CD3EF4GH5JK6M', 'real'], ['HID-ABCD2345', 'real'],
      // Near the sealed prefixes but not them: real.
      ['HID-ZDE234', 'real'], ['HID-ZDEQAA22', 'real'], ['HID-ZQ2345', 'real'], ['HID-ZQBAAAA2', 'real'],
      // The sealed shapes (0098 D7, 0123 D7): 8 characters, ZDEM or ZQA first.
      ['HID-ZDEMAAA2', 'demo'], ['HID-ZDEMBBB9', 'demo'], [DEMO_NOBODY, 'demo'],
      ['HID-ZQAAAAA2', 'qa'], ['HID-ZQAAAAA3', 'qa'], [QA_NOBODY, 'qa'],
      // ZDEM or ZQA first but not a sealed shape (a real one issued before Q60 included): no side.
      ['HID-ZDEM27', undefined], ['HID-ZDEMAAA', undefined], ['HID-ZDEMAAA22', undefined],
      ['HID-ZDEM2345ABCD6789', undefined], ['HID-ZQA234', undefined], ['HID-ZQAAAAA', undefined],
      ['HID-ZQAAAAAA2', undefined], ['HID-ZQA2345ABCDE6789', undefined],
    ] as const)('healthIdSide(%s) is %s', (candidate, side) => {
      expect(healthIdSide(candidate)).toBe(side);
    });

    it.each(SIDES.flatMap((side) => [[side, false], [side, true]] as const))(
      'asks the issued check for a %s Health ID at a facility on the same side (issued: %s)', async (side, issued) => {
        const hid = SIDE_HEALTH_ID[side];
        const { service, queries } = missService({ rows: issued ? [{ health_id: hid }] : [] }, FACILITY_ROWS[side]);
        await expect(service.issued(hid.toLowerCase(), context)).resolves.toBe(issued);
        expect(queries).toEqual([
          { sql: FACILITY_SIDE_SQL, values: [facilityId] },
          { sql: ISSUED_SQL, values: [[hid]] },
        ]);
      });

    it.each(SIDES.flatMap((hidSide) => SIDES.filter((facilitySide) => facilitySide !== hidSide)
      .map((facilitySide) => [hidSide, facilitySide] as const)))(
      'never asks the issued check for a %s Health ID at a %s facility (undefined: today\'s 404)',
      async (hidSide, facilitySide) => {
        // Even when the check would say "not issued", it is never asked across the seals.
        const { service, queries } = missService({ rows: [] }, FACILITY_ROWS[facilitySide]);
        await expect(service.issued(SIDE_HEALTH_ID[hidSide], context)).resolves.toBeUndefined();
        expect(queries).toEqual([{ sql: FACILITY_SIDE_SQL, values: [facilityId] }]);
      });

    it.each(SIDES.flatMap((side) => ['HID-ZDEM27', 'HID-ZDEMAAA22', 'HID-ZDEM2345ABCD6789', 'HID-ZQA234',
      'HID-ZQAAAAAA2', 'HID-ZQA2345ABCDE6789'].map((hid) => [hid, side] as const)))(
      'never answers %s (ZDEM or ZQA first, not a sealed shape) at a %s facility, asking nothing', async (hid, side) => {
        const { service, queries } = missService({ rows: [] }, FACILITY_ROWS[side]);
        await expect(service.issued(hid, context)).resolves.toBeUndefined();
        expect(queries).toEqual([]);
      });

    it.each([
      ['both seals mark it', { rows: [{ demo: true, qa: true }] }],
      ['no row', { rows: [] }],
      ['two rows', { rows: [{ demo: false, qa: false }, { demo: false, qa: false }] }],
      ['nulls (a function returned null)', { rows: [{ demo: null, qa: false }] }],
      ['text, not booleans', { rows: [{ demo: 'f', qa: 'f' }] }],
      ['a missing column', { rows: [{ demo: false }] }],
      ['a database failure (0123 not installed, or no EXECUTE)', new Error('function does not exist')],
    ] as const)('cannot tell the facility\'s side when %s: undefined, the issued check never asked',
      async (_label, facility) => {
        for (const side of SIDES) {
          const { service, queries } = missService({ rows: [] }, facility);
          await expect(service.facilitySide(facilityId)).resolves.toBeUndefined();
          await expect(service.issued(SIDE_HEALTH_ID[side], context)).resolves.toBeUndefined();
          expect(issuedAsked(queries)).toBe(false);
        }
      });

    it('cannot tell the side of no facility, and asks nothing', async () => {
      const { service, queries } = missService({ rows: [] });
      await expect(service.facilitySide('')).resolves.toBeUndefined();
      await expect(service.issued(NOBODY, { ...context, facilityId: '' })).resolves.toBeUndefined();
      expect(queries).toEqual([]);
    });

    it.each(SIDES)('reads a %s facility\'s side from the two seal functions', async (side) => {
      const { service, queries } = missService({ rows: [] }, FACILITY_ROWS[side]);
      await expect(service.facilitySide(facilityId)).resolves.toBe(side);
      expect(queries).toEqual([{ sql: FACILITY_SIDE_SQL, values: [facilityId] }]);
    });
  });

  it('counts a miss in the staff account\'s HMAC bucket: 30 in 10 minutes', async () => {
    const { service, queries } = missService({ rows: [] });
    await expect(service.countMiss(context)).resolves.toBe(false);
    const bucket = service.bucket(context.actor.accountId);
    expect(bucket).toMatch(/^[0-9a-f]{64}$/);
    expect(bucket).not.toContain(context.actor.accountId);
    expect(bucket).not.toContain(membershipId);
    const insert = queries.find((query) => /insert into auth\.otp_rate_limits/.test(query.sql));
    expect(insert?.values.slice(0, 2)).toEqual(['account', bucket]);
    expect(PATIENT_LOOKUP_MISS_WINDOW).toEqual({ windowSeconds: 600, maxRequests: 30 });
  });

  it('cannot count (undefined) when the database fails, or there is no account or no membership', async () => {
    await expect(missService(new Error('down')).service.countMiss(context)).resolves.toBeUndefined();
    const { service, database } = missService({ rows: [] });
    await expect(service.countMiss({ ...context, membershipId: '' })).resolves.toBeUndefined();
    await expect(service.countMiss({ ...context, actor: { ...context.actor, accountId: '' } })).resolves.toBeUndefined();
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('keeps one limit per staff account across its facilities: changing X-Facility-ID gives no fresh 30', async () => {
    const { service } = rateLimitedMissService();
    const memberships = MEMBERSHIPS.map(([member, facility]) => atFacility(member, facility));
    const answers: (boolean | undefined)[] = [];
    for (let miss = 0; miss < PATIENT_LOOKUP_MISS_WINDOW.maxRequests; miss += 1) {
      answers.push(await service.countMiss(memberships[miss % memberships.length]!));
    }
    expect(answers).toEqual(Array(PATIENT_LOOKUP_MISS_WINDOW.maxRequests).fill(false));
    // The 31st miss is limited at every facility of the account, not only at the one that had most.
    for (const member of memberships) await expect(service.countMiss(member)).resolves.toBe(true);
    // Another staff account at the same facility keeps its own limit.
    await expect(service.countMiss({ ...context, actor: { ...context.actor, accountId: OTHER_ACCOUNT } }))
      .resolves.toBe(false);
  });
});

/** auth.otp_rate_limits in memory, as consumeRateLimit (auth/rate-limit.ts) reads and writes it. */
function rateLimitTable() {
  const rows = new Map<string, { request_count: number; window_started_at: Date; blocked_until: Date | null }>();
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    const key = `${String(values[0])}:${String(values[1])}`;
    if (/select request_count/.test(sql)) {
      const row = rows.get(key);
      return { rows: row ? [row] : [] };
    }
    if (/insert into auth\.otp_rate_limits/.test(sql)) {
      const [, , windowExpired, nextCount, blocked, windowSeconds] = values as [string, string, boolean, number, boolean, number];
      const existing = rows.get(key);
      rows.set(key, existing
        ? { request_count: nextCount, window_started_at: windowExpired ? new Date() : existing.window_started_at,
          blocked_until: blocked ? new Date(Date.now() + windowSeconds * 1000) : null }
        : { request_count: 1, window_started_at: new Date(), blocked_until: null });
    }
    return { rows: [] };
  });
  return { rows, query };
}

/** A miss service on the in-memory rate-limit table; every Health ID is unissued at a real facility. */
function rateLimitedMissService() {
  const table = rateLimitTable();
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    if (/sealed_demo_facility/.test(sql)) return FACILITY_ROWS.real;
    if (/support_health_id_matches/.test(sql)) return { rows: [] };
    return table.query(sql, values);
  });
  const database = { query, withTransaction: jest.fn(async (_c: unknown, work: (client: unknown) => unknown) =>
    work({ query })) };
  return { service: new PatientLookupMissService(database as unknown as DatabaseService), table, query };
}

/** The same fictional staff account signed in at another of its facilities (X-Facility-ID). */
const MEMBERSHIPS: readonly (readonly [string, string])[] = [
  [membershipId, facilityId],
  ['d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70', '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'],
  ['e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081', '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'],
];
const OTHER_ACCOUNT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
function atFacility(member: string, facility: string): DataAccessContext {
  return { ...context, membershipId: member, facilityId: facility,
    actor: { ...context.actor, facility: { organizationId: 'org', membershipId: member } } } as unknown as DataAccessContext;
}

describe('Q100 B: the miss limit, end to end through IdentityService and the rate-limit table', () => {
  beforeAll(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      DATABASE_SSL: 'false', CORS_ORIGINS: 'https://healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      STORAGE_MODE: 'disabled' });
    resetEnvironmentForTests();
  });
  afterAll(() => { resetEnvironmentForTests(); });

  function identityWith(found: IdentityPatient | null, decision: AuthorizationDecision) {
    const { service: misses } = rateLimitedMissService();
    const provider: IdentityProvider = { lookupExactHid: jest.fn(async () => found),
      authorize: jest.fn(async () => decision), consentStatus: jest.fn() };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new IdentityService(provider, audit as never, undefined, misses);
    return { service, provider, audit };
  }
  const answerTo = (service: IdentityService, hid: string, at: DataAccessContext) =>
    service.lookupPatient(hid, 'direct-care', at).catch((error: unknown) => error);

  it('limits an account that spreads 31 unknown Health IDs over three facilities', async () => {
    const { service, provider } = identityWith(null, allow);
    const memberships = MEMBERSHIPS.map(([member, facility]) => atFacility(member, facility));
    for (let miss = 0; miss < PATIENT_LOOKUP_MISS_WINDOW.maxRequests; miss += 1) {
      await expect(answerTo(service, NOBODY, memberships[miss % memberships.length]!))
        .resolves.toMatchObject({ status: 404, code: 'PATIENT_NOT_FOUND' });
    }
    for (const member of memberships) {
      const limited = await answerTo(service, NOBODY, member);
      expect(limited).toMatchObject({ status: 404, message: 'Patient was not found or is not available' });
      expect(limited).not.toBeInstanceOf(DomainProblem);
    }
    expect(provider.lookupExactHid).toHaveBeenCalledTimes(PATIENT_LOOKUP_MISS_WINDOW.maxRequests + memberships.length);
  });

});

describe('Q100 B over HTTP: POST /api/v1/identity/patient-lookup', () => {
  let app: INestApplication;
  const provider = { lookupExactHid: jest.fn(), authorize: jest.fn(), consentStatus: jest.fn() };
  const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn() };
  const issuedRows: { rows: { health_id: string }[] } = { rows: [] };
  // The member's bucket, as auth.otp_rate_limits holds it (blocked: limited for 10 minutes).
  const bucket: { blocked: boolean } = { blocked: false };
  // The member's facility's side of the seals (a real facility unless a test says otherwise).
  const facility: { side: LookupSide | 'unknown' } = { side: 'real' };
  const query = jest.fn(async (sql: string) => {
    if (/sealed_demo_facility/.test(sql)) {
      if (facility.side === 'unknown') throw new Error('function identity.sealed_qa_facility(uuid) does not exist');
      return FACILITY_ROWS[facility.side];
    }
    return /support_health_id_matches/.test(sql) ? issuedRows
      : /from auth\.otp_rate_limits/.test(sql) && bucket.blocked
        ? { rows: [{ request_count: 31, window_started_at: new Date(), blocked_until: new Date(Date.now() + 600_000) }] }
        : { rows: [], rowCount: 0 };
  });
  const database = { query, withTransaction: jest.fn(async (_c: unknown, work: (client: unknown) => unknown) =>
    work({ query })) };

  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      DATABASE_SSL: 'false', CORS_ORIGINS: 'https://healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      STORAGE_MODE: 'disabled' });
    resetEnvironmentForTests();
    const moduleRef = await Test.createTestingModule({
      controllers: [IdentityController],
      providers: [
        IdentityService,
        PatientLookupMissService,
        { provide: IDENTITY_PROVIDER, useValue: provider },
        { provide: WorkloadAuthService, useValue: {} },
        { provide: DatabaseService, useValue: database },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    // The security guard's request context, as a signed-in desk member has it.
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = randomUUID();
      incoming.facilityId = facilityId;
      (incoming as { actor?: unknown }).actor = context.actor;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });
  afterAll(async () => { await app?.close(); resetEnvironmentForTests(); });
  beforeEach(() => { jest.clearAllMocks(); issuedRows.rows = []; bucket.blocked = false; facility.side = 'real'; });

  const lookup = (hid: string) => request(app.getHttpServer()).post('/api/v1/identity/patient-lookup')
    .send({ hid, purpose: 'direct-care' });

  it('answers 404 PATIENT_NOT_FOUND "No patient has this Health ID." with no Health ID in the answer', async () => {
    provider.lookupExactHid.mockResolvedValue(null);
    const response = await lookup(NOBODY);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ status: 404, code: 'PATIENT_NOT_FOUND', detail: 'No patient has this Health ID.' });
    expect(JSON.stringify(response.body)).not.toContain(NOBODY);
    expect(JSON.stringify(response.body)).not.toMatch(UNVERIFIED);
    expect(query).toHaveBeenCalledWith(FACILITY_SIDE_SQL, [facilityId]);
    expect(query).toHaveBeenCalledWith(ISSUED_SQL, [[NOBODY]]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', patientId: undefined,
      details: { lookupResult: 'no_such_patient' } }));
  });

  it.each([['demo', DEMO_NOBODY], ['qa', QA_NOBODY]] as const)(
    'answers PATIENT_NOT_FOUND to a %s facility\'s member for a missing Health ID of its own tenant',
    async (side, hid) => {
      facility.side = side;
      provider.lookupExactHid.mockResolvedValue(null);
      const response = await lookup(hid);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'PATIENT_NOT_FOUND', detail: 'No patient has this Health ID.' });
      expect(query).toHaveBeenCalledWith(ISSUED_SQL, [[hid]]);
    });

  it.each(SIDES.flatMap((hidSide) => SIDES.filter((facilitySide) => facilitySide !== hidSide)
    .map((facilitySide) => [hidSide, facilitySide] as const)))(
    'answers today\'s 404 for a %s Health ID looked up at a %s facility, never asking whether it was issued',
    async (hidSide, facilitySide) => {
      facility.side = facilitySide;
      provider.lookupExactHid.mockResolvedValue(null);
      const response = await lookup(SIDE_HEALTH_ID[hidSide]);
      expect(response.status).toBe(404);
      expect(response.body.code).not.toBe('PATIENT_NOT_FOUND');
      expect(response.body.detail).toBe('Patient was not found or is not available');
      expect(query).not.toHaveBeenCalledWith(ISSUED_SQL, expect.anything());
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied',
        details: { lookupResult: 'not_available' } }));
    });

  it('answers today\'s 404 for a Health ID starting ZDEM or ZQA that is not a sealed one, asking nothing', async () => {
    provider.lookupExactHid.mockResolvedValue(null);
    for (const hid of ['HID-ZDEM27', 'HID-ZQAAAAAA2']) {
      const response = await lookup(hid);
      expect(response.status).toBe(404);
      expect(response.body.code).not.toBe('PATIENT_NOT_FOUND');
    }
    expect(query).not.toHaveBeenCalledWith(FACILITY_SIDE_SQL, expect.anything());
    expect(query).not.toHaveBeenCalledWith(ISSUED_SQL, expect.anything());
  });

  it('answers today\'s 404 when the facility\'s side cannot be read (fails closed)', async () => {
    facility.side = 'unknown';
    provider.lookupExactHid.mockResolvedValue(null);
    const response = await lookup(NOBODY);
    expect(response.status).toBe(404);
    expect(response.body.code).not.toBe('PATIENT_NOT_FOUND');
    expect(response.body.detail).toBe('Patient was not found or is not available');
    expect(query).not.toHaveBeenCalledWith(ISSUED_SQL, expect.anything());
    expect(JSON.stringify(response.body)).not.toMatch(/sealed|function/);
  });

  it('answers today\'s 404 when the issued check answers what 0109 never does (fails closed, nothing leaks)', async () => {
    provider.lookupExactHid.mockResolvedValue(null);
    issuedRows.rows = [{ health_id: 'HID-OTHER2' }];
    const response = await lookup(NOBODY);
    expect(response.status).toBe(404);
    expect(response.body.code).not.toBe('PATIENT_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('HID-OTHER2');
  });

  it('keeps today\'s answer, distinct from PATIENT_NOT_FOUND, for a Health ID that exists', async () => {
    provider.lookupExactHid.mockResolvedValue(null);
    issuedRows.rows = [{ health_id: KNOWN }];
    const response = await lookup(KNOWN);
    expect(response.status).toBe(404);
    expect(response.body.code).not.toBe('PATIENT_NOT_FOUND');
    expect(response.body.detail).toBe('Patient was not found or is not available');
  });

  it('answers a limited member with today\'s 404 and 403, never 429, so an open record still closes', async () => {
    bucket.blocked = true;
    provider.lookupExactHid.mockResolvedValue(null);
    const missing = await lookup(NOBODY);
    expect(missing.status).toBe(404);
    expect(missing.body.code).not.toBe('PATIENT_NOT_FOUND');
    expect(missing.body.detail).toBe('Patient was not found or is not available');
    expect(query).not.toHaveBeenCalledWith(expect.stringMatching(/support_health_id_matches/), expect.anything());

    provider.lookupExactHid.mockResolvedValue({ id: patientId, hidCode: KNOWN, firstName: 'Ada', lastName: 'Fictional',
      fullName: 'Ada Fictional', dateOfBirth: '1991-04-05', gender: 'female', rowVersion: 3, ninVerified: false });
    provider.authorize.mockResolvedValue({ allowed: false, patientId, facilityId, membershipId, scope: 'read_records',
      purpose: 'direct-care', breakGlass: false });
    const refused = await lookup(KNOWN);
    expect(refused.status).toBe(403);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied',
      details: { lookupResult: 'limited' } }));
  });
});
