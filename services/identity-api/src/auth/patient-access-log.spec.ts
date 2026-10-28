jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { decodeAccessLogCursor, encodeAccessLogCursor, publishAccessLog } from './patient-access-log';
import { PatientSelfController } from './patient-self.controller';
import { PatientSelfService } from './patient-self.service';
import type { WorkloadAuthService } from './workload-auth.service';

const request = { actor: { kind: 'patient', patientId: 'patient-id', accountId: 'account-id',
  subject: 'patient-subject', sessionId: 'session-id' }, correlationId: 'access-log-test', ip: '192.0.2.5',
  header: () => 'synthetic-agent' } as unknown as HidRequest;
const event = (overrides: Record<string, unknown> = {}) => ({ id: '0b6a2c0e-6a2f-4d39-9d0f-2f0a0b2d9e11',
  at: '2026-10-28T09:15:02.123Z', action: 'viewed', actorKind: 'clinician', actorName: 'Ada Doctor',
  facilityName: 'Lagos General', ...overrides });
const next = { occurredAt: '2026-10-28T09:15:02.123456Z', sequenceId: 9007 };

function setup(rows: unknown[], auditFailure = false) {
  const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows });
  const transaction = jest.fn(async (_id: string, work: (client: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient));
  const record = auditFailure ? jest.fn().mockRejectedValue(new Error('audit unavailable')) : jest.fn().mockResolvedValue(undefined);
  const service = new PatientSelfService({ withSystemTransaction: transaction } as unknown as DatabaseService,
    { recordWithClient: record } as unknown as AuditService);
  return { service, query, record, controller: new PatientSelfController(service, {} as WorkloadAuthService) };
}

describe('GET /identity/me/access-log (0093; owner decision of 2026-10-28)', () => {
  it('reads the live session\'s log newest first, audits the read and gives an opaque nextBefore', async () => {
    const s = setup([{ value: { events: [event(), event({ action: 'access_ended', actorName: null })], next } }]);
    const page = await s.controller.accessLog(request, '2');
    expect(s.query.mock.calls[0]).toEqual(["select set_config('app.actor_subject',$1,true)", ['patient-subject']]);
    expect(s.query.mock.calls[1]?.[0]).toBe(
      'select identity.patient_self_access_log($1, $2, $3, $4::timestamptz, $5::bigint) as value');
    expect(s.query.mock.calls[1]?.[1]).toEqual(['patient-subject', 'session-id', 2, null, null]);
    expect(page.events).toEqual([event(), event({ action: 'access_ended', actorName: null })]);
    expect(page.nextBefore).toBe(encodeAccessLogCursor({ occurredAt: next.occurredAt, sequenceId: '9007' }));
    expect(s.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'identity.patient.self.access-log', outcome: 'success', patientId: 'patient-id',
      actorType: 'patient', purposeOfUse: 'patient-self' }));
  });

  it('continues from nextBefore with the keyset it carries', async () => {
    const s = setup([{ value: { events: [], next: null } }]);
    const before = encodeAccessLogCursor({ occurredAt: next.occurredAt, sequenceId: '9007' });
    await expect(s.controller.accessLog(request, undefined, before)).resolves.toEqual({ events: [], nextBefore: null });
    expect(s.query.mock.calls[1]?.[1]).toEqual(['patient-subject', 'session-id', 50, next.occurredAt, '9007']);
  });

  it.each([['0'], ['101'], ['1.5'], ['ten']])('refuses the limit %s with 400', (limit) => {
    const s = setup([]);
    expect(() => s.controller.accessLog(request, limit)).toThrow(expect.objectContaining({
      status: 400, code: 'INVALID_ACCESS_LOG_LIMIT' }));
  });

  it.each([
    'not base64 !', 'x'.repeat(201),
    Buffer.from('{"t":"2026-10-28","s":"1"}').toString('base64url'),
    Buffer.from('{"t":"2026-10-28T09:15:02.123456Z","s":"0"}').toString('base64url'),
    Buffer.from('{"t":"2026-10-28T09:15:02.123456Z","s":"1","x":1}').toString('base64url'),
    Buffer.from('{"t":"2026-10-28T09:15:02.123456Z","s":1}').toString('base64url'),
    Buffer.from('[1,2]').toString('base64url'),
  ])('refuses the cursor %s with 400', (before) => {
    const s = setup([]);
    expect(() => s.controller.accessLog(request, '10', before)).toThrow(expect.objectContaining({
      status: 400, code: 'INVALID_ACCESS_LOG_CURSOR' }));
    expect(() => decodeAccessLogCursor(before)).toThrow();
  });

  it('refuses a repeated cursor parameter', () => {
    const s = setup([]);
    expect(() => s.controller.accessLog(request, '10', ['a', 'b'] as unknown as string)).toThrow(
      expect.objectContaining({ code: 'INVALID_ACCESS_LOG_CURSOR' }));
  });

  it('answers 403 and audits the denial for a revoked or another session', async () => {
    const s = setup([{ value: null }]);
    await expect(s.controller.accessLog(request)).rejects.toMatchObject({ status: 403, code: 'PATIENT_ACCESS_DENIED' });
    expect(s.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'denied' }));
  });

  it('returns nothing when the audit cannot be written', async () => {
    const s = setup([{ value: { events: [event()], next: null } }], true);
    await expect(s.controller.accessLog(request)).rejects.toThrow('audit unavailable');
  });

  it('refuses a staff session', async () => {
    const s = setup([]);
    await expect(s.controller.accessLog({ ...request, actor: { ...request.actor, kind: 'staff' } } as HidRequest))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
  });

  it('publishes only the contract\'s keys and drops anything unexpected', () => {
    const published = publishAccessLog({ events: [
      event({ extra: 'never', details: { resource: 'x' } }),
      event({ actorName: 'Ada\u0000‮ Doctor', facilityName: '  Lagos   General  ' }),
      event({ action: 'refused' }), event({ actorKind: 'robot' }), event({ id: 'not-a-uuid' }),
      event({ at: 'yesterday' }), 'junk', null,
    ], next: { occurredAt: 'bad', sequenceId: 1 } });
    expect(published).toEqual({ events: [event(), event({ actorName: 'Ada Doctor', facilityName: 'Lagos General' })],
      nextBefore: null });
    expect(publishAccessLog(null)).toEqual({ events: [], nextBefore: null });
  });
});

describe('GET /identity/me/notifications/unread-count (0093)', () => {
  it('answers { unread } for the live patient session, binding the subject, and writes no audit row', async () => {
    const s = setup([{ unread: 7 }]);
    await expect(s.controller.unreadNotificationCount(request)).resolves.toEqual({ unread: 7 });
    expect(s.query.mock.calls[0]).toEqual(["select set_config('app.actor_subject',$1,true)", ['patient-subject']]);
    expect(s.query.mock.calls[1]).toEqual(['select identity.count_my_unread_notifications($1, $2) as unread',
      ['patient-subject', 'session-id']]);
    expect(s.record).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined], [-1], [1.5], ['3']])('answers 403 when the database answers %s', async (unread) => {
    const s = setup([{ unread }]);
    await expect(s.controller.unreadNotificationCount(request))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_ACCESS_DENIED' });
  });

  it('refuses a staff session', async () => {
    const s = setup([]);
    await expect(s.controller.unreadNotificationCount({ ...request, actor: { ...request.actor, kind: 'staff' } } as HidRequest))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_SESSION_REQUIRED' });
  });
});
