jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { ActorContext, DataAccessContext, FacilityAssignment } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { OPEN_PATIENT_CARD_SQL, OPEN_PATIENT_READ_SQL, OPEN_PATIENT_TARGET_SQL, OpenPatientService } from './open-patient.service';

// SX-8 (0140): how Identity sets, clears and restores the open patient. The
// database's own rules (0140's guard, the CHECK of at most 8 hours, the
// foreign keys) and these statements against a real schema are exercised by
// services/ehr-api/test/database/session-open-patient.integration.sql.

const normalized = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const LIVE_STAFF_SESSION = ['session.id = $1', 'session.account_id = $2', "session.session_kind = 'staff'",
  'session.revoked_at is null', 'session.expires_at > clock_timestamp()', 'session.absolute_expires_at > clock_timestamp()'];

const here: FacilityAssignment = {
  id: 'f1401000-0000-4000-8000-000000000001', membershipId: 'f1404000-0000-4000-8000-000000000001',
  organizationId: 'f1403000-0000-4000-8000-000000000001', name: 'Fictional Alpha General', roles: ['doctor'],
  permissions: ['ehr.encounter.write'], isPrimary: true,
};
const there: FacilityAssignment = { ...here, id: 'f1401000-0000-4000-8000-000000000002',
  membershipId: 'f1404000-0000-4000-8000-000000000002', name: 'Fictional Beta Clinic', isPrimary: false };
const accountId = 'f1402000-0000-4000-8000-000000000001';
const sessionId = 'f1406000-0000-4000-8000-000000000002';
const familyId = 'f1406000-0000-4000-8000-000000000001';
const patientId = 'f1405000-0000-4000-8000-000000000001';
const request = { correlationId: 'open-patient-test', sourceIp: '203.0.113.9', userAgent: 'synthetic-browser' };
const actor = (facility: FacilityAssignment = here): ActorContext & { sessionId: string } => ({
  id: `staff:${accountId}`, subject: `staff:${accountId}`, accountId, sessionId, roles: facility.roles,
  role: facility.roles[0], permissions: facility.permissions, platformRoles: [], platformPermissions: [],
  facilityIds: [here.id, there.id], facilities: [here, there], facility, authenticationMethod: 'local',
});
const absoluteEnd = new Date('2026-11-20T20:00:00.000Z');
const keptUntil = new Date('2026-11-20T17:00:00.000Z');
const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

interface Stored { patient_id: string; purpose: string; facility_id: string; expires_at: Date; row_version: string;
  expired: boolean }

function harness(options: {
  known?: boolean | Error;
  allowed?: boolean | Error;
  locked?: { family_id: string; absolute_expires_at: Date }[];
  stored?: { expires_at: Date }[] | Error;
  read?: Stored[] | Error;
  card?: Record<string, unknown>[] | Error;
  cleared?: { patient_id: string }[] | Error;
  audit?: Error;
} = {}) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: normalized(sql), values });
      if (/for share/.test(sql)) {
        const locked = options.locked ?? [{ family_id: familyId, absolute_expires_at: absoluteEnd }];
        return { rows: locked, rowCount: locked.length };
      }
      if (/insert into auth\.session_open_patient/.test(sql)) {
        if (options.stored instanceof Error) throw options.stored;
        const stored = options.stored ?? [{ expires_at: keptUntil }];
        return { rows: stored, rowCount: stored.length };
      }
      if (/delete from auth\.session_open_patient/.test(sql)) {
        if (options.cleared instanceof Error) throw options.cleared;
        const cleared = options.cleared ?? [{ patient_id: patientId }];
        return { rows: cleared, rowCount: cleared.length };
      }
      if (/from identity\.patients/.test(sql)) {
        if (options.card instanceof Error) throw options.card;
        const card = options.card ?? [{ full_name: 'Amaka Okafor', sex: 'female', date_of_birth: '1990-05-01',
          health_id_last4: 'AA22', nin_verified: true }];
        return { rows: card, rowCount: card.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const contexts: DataAccessContext[] = [];
  const lookups: unknown[][] = [];
  const database = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (/session_open_patient_target_exists/.test(sql)) {
        lookups.push(values);
        if (options.known instanceof Error) throw options.known;
        return { rows: [{ known: options.known ?? true }], rowCount: 1 };
      }
      statements.push({ sql: normalized(sql), values });
      if (options.read instanceof Error) throw options.read;
      const read = options.read ?? [];
      return { rows: read, rowCount: read.length };
    }),
    withSystemTransaction: jest.fn(async (_correlation: string, operation: (client: PoolClient) => Promise<unknown>) =>
      operation(client as unknown as PoolClient)),
    withTransaction: jest.fn(async (context: DataAccessContext, operation: (client: PoolClient) => Promise<unknown>,
      transactionOptions?: { readOnly?: boolean }) => {
      contexts.push(context);
      expect(transactionOptions).toEqual({ readOnly: true });
      return operation(client as unknown as PoolClient);
    }),
  };
  const identity = {
    precheck: jest.fn(async (patient: string, scope: string, purpose: string, context: DataAccessContext) => {
      contexts.push(context);
      if (options.allowed instanceof Error) throw options.allowed;
      return { allowed: options.allowed ?? true, patientId: patient, facilityId: context.facilityId,
        membershipId: context.membershipId, scope, purpose, breakGlass: false };
    }),
  };
  const audit = {
    record: jest.fn(async () => { if (options.audit) throw options.audit; }),
    recordWithClient: jest.fn(async () => { if (options.audit) throw options.audit; }),
  };
  const service = new OpenPatientService(database as unknown as DatabaseService, identity as unknown as IdentityService,
    audit as unknown as AuditService);
  return { service, client, database, identity, audit, statements, contexts, lookups };
}

describe('OpenPatientService (SX-8, 0140)', () => {
  const original = { ...process.env };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local', STAFF_OPEN_PATIENT_ENABLED: 'true',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    resetEnvironmentForTests();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  const logs = () => warn.mock.calls.map(([message]) => message);

  describe('who gets the field at all', () => {
    it('only a staff sign-in of Identity bound at a facility, and only with the setting on', () => {
      const { service } = harness();
      expect(service.reportsFor(actor())).toBe(true);
      expect(service.reportsFor({ ...actor(), sessionId: undefined })).toBe(false);
      expect(service.reportsFor({ ...actor(), facility: undefined })).toBe(false);
      expect(service.reportsFor({ ...actor(), accountOnly: true })).toBe(false);
      expect(service.reportsFor({ ...actor(), kind: 'patient' })).toBe(false);
      expect(service.reportsFor({ ...actor(), facilities: [], facilityIds: [] })).toBe(false);
      process.env.STAFF_OPEN_PATIENT_ENABLED = 'false';
      resetEnvironmentForTests();
      expect(service.reportsFor(actor())).toBe(false);
    });
  });

  describe('set', () => {
    it('checks read_records with no notice, as the member at this facility with this purpose, then stores it with its audit row',
      async () => {
        const { service, identity, statements, audit, client, contexts } = harness();
        await expect(service.set(actor(), patientId, 'direct-care', request)).resolves.toEqual({
          openPatient: { state: 'kept', patientId, expiresAt: keptUntil.toISOString() } });

        expect(identity.precheck).toHaveBeenCalledTimes(1);
        expect(identity.precheck).toHaveBeenCalledWith(patientId, 'read_records', 'direct-care', expect.any(Object));
        expect(contexts[0]).toEqual({ actor: actor(), facilityId: here.id, membershipId: here.membershipId,
          correlationId: request.correlationId, purposeOfUse: 'direct-care' });
        expect(statements).toHaveLength(2);
        // 1. The presented session, while live, locked FOR SHARE (0129's store).
        for (const clause of LIVE_STAFF_SESSION) expect(statements[0]!.sql).toContain(clause);
        expect(statements[0]!.sql).toMatch(/for share$/);
        expect(statements[0]!.values).toEqual([sessionId, accountId]);
        // 2. One row per sign-in family; the set time taken once; at most 8 hours and never past the sign-in's end.
        expect(statements[1]!.sql).toContain('insert into auth.session_open_patient (family_id, account_id, facility_id, '
          + 'membership_id, patient_id, purpose, set_at, expires_at)');
        expect(statements[1]!.sql).toContain('least(moment.at + make_interval(hours => 8), $7::timestamptz)');
        expect(statements[1]!.sql).toContain('from (select clock_timestamp() as at) moment where $7::timestamptz > moment.at');
        expect(statements[1]!.sql).toContain('on conflict (family_id) do update');
        expect(statements[1]!.sql).toContain('row_version = auth.session_open_patient.row_version + 1');
        expect(statements[1]!.values).toEqual([familyId, accountId, here.id, here.membershipId, patientId, 'direct-care',
          absoluteEnd]);
        expect(audit.record).not.toHaveBeenCalled();
        expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
        expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
          action: 'auth.open-patient.set', outcome: 'success', patientId, purposeOfUse: 'direct-care',
          actorAccountId: accountId, actorMembershipId: here.membershipId, facilityId: here.id,
          organizationId: here.organizationId, resourceType: 'session', resourceId: sessionId,
          correlationId: request.correlationId, sourceIp: request.sourceIp, userAgent: request.userAgent,
          details: { expiresAt: keptUntil.toISOString() } }));
      });

    it('keeps a break-glass opening with the emergency purpose', async () => {
      const { service, identity, statements } = harness();
      await service.set(actor(), patientId, 'emergency', request);
      expect(identity.precheck).toHaveBeenCalledWith(patientId, 'read_records', 'emergency', expect.objectContaining({
        purposeOfUse: 'emergency' }));
      expect(statements[1]!.values[5]).toBe('emergency');
    });

    it('a refused or unknown patient stores nothing and gets the same 403, with a denied audit row', async () => {
      const { service, statements, audit } = harness({ allowed: false });
      await expect(service.set(actor(), patientId, 'direct-care', request)).rejects.toMatchObject({
        status: 403, code: 'OPEN_PATIENT_NOT_ALLOWED',
        message: "You don't have access to this patient's records now. Ask for their Access PIN or send an access request." });
      expect(statements).toHaveLength(0);
      expect(audit.recordWithClient).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.open-patient.set',
        outcome: 'denied', patientId, details: { reason: 'not_allowed' } }));
    });

    it('a UUID that is no patient gets the same 403, with no access check, nothing stored, and the id in details', async () => {
      const { service, identity, statements, audit, lookups } = harness({ known: false });
      await expect(service.set(actor(), patientId, 'direct-care', request)).rejects.toMatchObject({
        status: 403, code: 'OPEN_PATIENT_NOT_ALLOWED',
        message: "You don't have access to this patient's records now. Ask for their Access PIN or send an access request." });
      expect(lookups).toEqual([[patientId]]);
      expect(identity.precheck).not.toHaveBeenCalled();
      expect(statements).toHaveLength(0);
      expect(audit.recordWithClient).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledTimes(1);
      const row = (audit.record.mock.calls as unknown as Record<string, unknown>[][])[0]![0]!;
      expect(row).toMatchObject({ action: 'auth.open-patient.set', outcome: 'denied',
        details: { reason: 'not_allowed', requestedPatientId: patientId, patientFound: false } });
      // audit.events' patient key admits only a real patient, so the id is never the row's patient.
      expect(row).not.toHaveProperty('patientId');
    });

    it('asks whether the patient exists before the access check, with 0140 D6', async () => {
      const { service, database, identity } = harness();
      await service.set(actor(), patientId, 'direct-care', request);
      expect(normalized(OPEN_PATIENT_TARGET_SQL)).toBe('select auth.session_open_patient_target_exists($1::uuid) as known');
      expect(database.query).toHaveBeenCalledWith(OPEN_PATIENT_TARGET_SQL, [patientId]);
      expect(database.query.mock.invocationCallOrder[0]).toBeLessThan(identity.precheck.mock.invocationCallOrder[0]!);
    });

    it('a failed existence check is 503 with nothing stored, and its failure row names the id in details only',
      async () => {
        const { service, identity, statements, audit } = harness({ known: new Error('down') });
        await expect(service.set(actor(), patientId, 'direct-care', request)).rejects.toMatchObject({
          status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
        expect(identity.precheck).not.toHaveBeenCalled();
        expect(statements).toHaveLength(0);
        const row = (audit.record.mock.calls as unknown as Record<string, unknown>[][])[0]![0]!;
        expect(row).toMatchObject({ outcome: 'failure', details: { reason: 'unavailable', requestedPatientId: patientId } });
        expect(row).not.toHaveProperty('patientId');
        expect(logs()).toEqual([{ event: 'auth.open_patient.unavailable', operation: 'check' }]);
      });

    it('a failed access check is 503 with nothing stored, logged with no identifier', async () => {
      const { service, statements, audit } = harness({ allowed: new Error('provider down') });
      await expect(service.set(actor(), patientId, 'direct-care', request)).rejects.toMatchObject({
        status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
      expect(statements).toHaveLength(0);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure',
        details: { reason: 'unavailable' } }));
      expect(logs()).toEqual([{ event: 'auth.open_patient.unavailable', operation: 'check' }]);
    });

    it('a sign-in that ended first is 401 with nothing stored', async () => {
      const { service, statements, audit } = harness({ locked: [] });
      await expect(service.set(actor(), patientId, 'direct-care', request)).rejects.toMatchObject({
        status: 401, code: 'AUTHENTICATION_REQUIRED' });
      expect(statements).toHaveLength(1);
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });

    it('a sign-in ending at the moment of the set stores nothing (401)', async () => {
      const { service, audit } = harness({ stored: [] });
      await expect(service.set(actor(), patientId, 'direct-care', request)).rejects.toMatchObject({ status: 401 });
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });

    it("0140's guard refusal (membership or facility ended after the request was authorized) is 403 FACILITY_ACCESS_DENIED",
      async () => {
        const { service, audit } = harness({ stored: databaseError('23514', 'SESSION_OPEN_PATIENT_INVALID') });
        await expect(service.set(actor(), patientId, 'direct-care', request)).rejects.toMatchObject({
          status: 403, code: 'FACILITY_ACCESS_DENIED' });
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.open-patient.set',
          outcome: 'denied', details: { reason: 'facility_access_denied' } }));
      });

    it.each([
      ['another CHECK', databaseError('23514', 'session_open_patient_check')],
      ['a foreign key', databaseError('23503', 'insert or update violates foreign key constraint')],
      ['a lost connection', new Error('Connection terminated unexpectedly')],
    ])('any other store failure (%s) is 503 with nothing stored, logged with no identifier', async (_label, error) => {
      const { service } = harness({ stored: error });
      await expect(service.set(actor(), patientId, 'direct-care', request)).rejects.toMatchObject({
        status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
      expect(logs()).toEqual([{ event: 'auth.open_patient.unavailable', operation: 'store' }]);
    });

    it('a failed audit row stores nothing (the transaction rolls back): 503', async () => {
      const { service } = harness({ audit: new Error('audit down') });
      await expect(service.set(actor(), patientId, 'direct-care', request)).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('clear', () => {
    it('deletes this sign-in family\'s row through the presented session of the account, with its audit row', async () => {
      const { service, statements, audit, client } = harness();
      await expect(service.clear(actor(), request)).resolves.toEqual({ openPatient: null });
      expect(statements).toHaveLength(1);
      expect(statements[0]!.sql).toBe('delete from auth.session_open_patient open_patient using auth.sessions session '
        + 'where session.id = $1 and session.account_id = $2 and open_patient.family_id = session.family_id '
        + 'and open_patient.account_id = session.account_id returning open_patient.patient_id::text');
      expect(statements[0]!.values).toEqual([sessionId, accountId]);
      expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
        action: 'auth.open-patient.clear', outcome: 'success', patientId, details: { cleared: true } }));
    });

    it('is safe to repeat: nothing to clear still answers null, audited as cleared false with no patient', async () => {
      const { service, audit } = harness({ cleared: [] });
      await expect(service.clear(actor(), request)).resolves.toEqual({ openPatient: null });
      const event = (audit.recordWithClient.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
      expect(event).toMatchObject({ action: 'auth.open-patient.clear', details: { cleared: false } });
      expect(event).not.toHaveProperty('patientId');
      expect(event).not.toHaveProperty('purposeOfUse');
    });

    it('a failure is 503, logged with no identifier', async () => {
      const { service } = harness({ cleared: new Error('down') });
      await expect(service.clear(actor(), request)).rejects.toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
      expect(logs()).toEqual([{ event: 'auth.open_patient.unavailable', operation: 'clear' }]);
    });
  });

  describe('restore (GET /auth/session)', () => {
    const stored = (overrides: Partial<Stored> = {}): Stored => ({ patient_id: patientId, purpose: 'direct-care',
      facility_id: here.id, expires_at: keptUntil, row_version: '3', expired: false, ...overrides });

    it('reads the row only through a live staff session of the account, on the pool', async () => {
      const { service, database } = harness();
      await expect(service.restore(actor(), request)).resolves.toBeUndefined();
      expect(database.query).toHaveBeenCalledWith(OPEN_PATIENT_READ_SQL, [sessionId, accountId]);
      const sql = normalized(OPEN_PATIENT_READ_SQL);
      for (const clause of LIVE_STAFF_SESSION) expect(sql).toContain(clause);
      expect(sql).toContain('on open_patient.family_id = session.family_id and open_patient.account_id = session.account_id');
      expect(sql).toContain('open_patient.expires_at <= clock_timestamp() as expired');
    });

    it('nothing stored: the field is absent, with no check and no audit row', async () => {
      const { service, identity, audit } = harness({ read: [] });
      await expect(service.restore(actor(), request)).resolves.toBeUndefined();
      expect(identity.precheck).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('kept at another facility: the field is absent and the row is kept (no check, no clear, no audit)', async () => {
      const { service, identity, audit, statements } = harness({ read: [stored({ facility_id: there.id })] });
      await expect(service.restore(actor(), request)).resolves.toBeUndefined();
      expect(identity.precheck).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(statements).toHaveLength(1);
    });

    it('restored: checks again with the stored purpose, reads the card as the member, audits, sends no full Health ID',
      async () => {
        const { service, identity, audit, statements, contexts } = harness({ read: [stored({ purpose: 'emergency' })] });
        const answer = await service.restore(actor(), request);
        expect(answer).toEqual({ state: 'restored', patientId, purpose: 'emergency', expiresAt: keptUntil.toISOString(),
          card: { fullName: 'Amaka Okafor', sex: 'female', dateOfBirth: '1990-05-01', healthIdLast4: 'AA22',
            ninStatus: 'verified' } });
        expect(identity.precheck).toHaveBeenCalledWith(patientId, 'read_records', 'emergency', expect.any(Object));
        // Both the check and the card read run as the member at the reported facility with the stored purpose.
        expect(contexts).toHaveLength(2);
        for (const context of contexts) {
          expect(context).toMatchObject({ facilityId: here.id, membershipId: here.membershipId, purposeOfUse: 'emergency' });
        }
        expect(statements[1]).toEqual({ sql: normalized(OPEN_PATIENT_CARD_SQL), values: [patientId] });
        expect(statements[1]!.sql).toContain("right(patient_row.hid_code, 4) as health_id_last4");
        expect(statements[1]!.sql).toContain("patient_row.status = 'active'");
        // The card only under the grant the access check allows, not 0011's registration read alone.
        expect(statements[1]!.sql).toContain('and identity.has_active_consent_grant(patient_row.id, '
          + 'platform.current_actor_subject(), platform.current_membership_id(), platform.current_facility_id(), '
          + "'read_records', platform.current_purpose_of_use(), clock_timestamp())");
        expect(statements[1]!.sql).not.toMatch(/hid_code(?!, 4)/);
        expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.open-patient.restore',
          outcome: 'success', patientId, purposeOfUse: 'emergency', details: { state: 'restored' } }));
        // Exactly these fields: no full Health ID, no matchRef, no NIN.
        expect(Object.keys(answer!).sort()).toEqual(['card', 'expiresAt', 'patientId', 'purpose', 'state']);
        expect(Object.keys((answer as { card: object }).card).sort())
          .toEqual(['dateOfBirth', 'fullName', 'healthIdLast4', 'ninStatus', 'sex']);
      });

    it('a card with no checked NIN says not_verified', async () => {
      const { service } = harness({ read: [stored()], card: [{ full_name: 'Bola Ade', sex: null, date_of_birth: null,
        health_id_last4: 'QQ71', nin_verified: false }] });
      await expect(service.restore(actor(), request)).resolves.toMatchObject({ state: 'restored',
        card: { fullName: 'Bola Ade', sex: null, dateOfBirth: null, healthIdLast4: 'QQ71', ninStatus: 'not_verified' } });
    });

    it('expired: no check, no card; the row read is cleared (that version only) with its audit row', async () => {
      const { service, identity, statements, audit, client } = harness({ read: [stored({ expired: true })] });
      await expect(service.restore(actor(), request)).resolves.toEqual({ state: 'expired' });
      expect(identity.precheck).not.toHaveBeenCalled();
      expect(statements[1]!.sql).toContain('and open_patient.row_version = $3::bigint');
      expect(statements[1]!.values).toEqual([sessionId, accountId, '3']);
      expect(audit.recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
        action: 'auth.open-patient.restore', patientId, details: { state: 'expired' } }));
    });

    it('ended: the check no longer allows it; no card is read or sent, and the row read is cleared', async () => {
      const { service, statements, audit } = harness({ read: [stored()], allowed: false });
      await expect(service.restore(actor(), request)).resolves.toEqual({ state: 'ended' });
      expect(statements.some(({ sql }) => /identity\.patients/.test(sql))).toBe(false);
      expect(statements[1]!.sql).toMatch(/^delete from auth\.session_open_patient/);
      expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'auth.open-patient.restore', details: { state: 'ended' } }));
    });

    it('ended: a patient no longer active has no card', async () => {
      const { service } = harness({ read: [stored()], card: [] });
      await expect(service.restore(actor(), request)).resolves.toEqual({ state: 'ended' });
    });

    it.each([
      ['the read', { read: new Error('down') }, 'read'],
      ['the check', { read: [stored()], allowed: new Error('down') }, 'check'],
      ['the card read', { read: [stored()], card: new Error('down') }, 'check'],
      ['the audit row', { read: [stored()], audit: new Error('down') }, 'audit'],
      ['the clear of an expired row', { read: [stored({ expired: true })], cleared: new Error('down') }, 'clear'],
    ] as const)('a failure of %s answers unavailable with no card, never an error', async (_label, options, operation) => {
      const { service } = harness(options as Parameters<typeof harness>[0]);
      await expect(service.restore(actor(), request)).resolves.toEqual({ state: 'unavailable' });
      expect(logs()).toContainEqual({ event: 'auth.open_patient.unavailable', operation });
    });

    it('an unknown stored purpose is ignored (the field is absent)', async () => {
      const { service, identity } = harness({ read: [stored({ purpose: 'healthcare-operations' })] });
      await expect(service.restore(actor(), request)).resolves.toBeUndefined();
      expect(identity.precheck).not.toHaveBeenCalled();
    });
  });
});
