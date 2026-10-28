jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { IdentityService } from './identity.service';
import type { AuthorizationDecision, IdentityProvider } from './identity.types';
import { lagosDay, RecordAccessNoticeService } from './record-access-notice.service';

const patientId = '50000000-0000-4000-8000-000000000001';
const context = { actor: { kind: 'staff', subject: 'staff:doctor', accountId: 'a' }, facilityId: 'f1', membershipId: 'm1',
  correlationId: 'staff-correlation-01', purposeOfUse: 'direct-care' } as unknown as DataAccessContext;
const allowed = { allowed: true, patientId, facilityId: 'f1', membershipId: 'm1', scope: 'read_records',
  purpose: 'direct-care', consentGrantId: 'g1', expiresAt: 'x', breakGlass: false } as AuthorizationDecision;

function notices(answer: () => Promise<{ rows: Array<{ outcome: string }> }> = async () => ({ rows: [{ outcome: 'noted' }] })) {
  const query = jest.fn(answer);
  const database = { withTransaction: jest.fn(async (_c: DataAccessContext, work: (client: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient)) } as unknown as DatabaseService;
  return { service: new RecordAccessNoticeService(database), query, database };
}

describe('RecordAccessNoticeService (0095, D9)', () => {
  it('notes an allowed staff read with a grant, once per patient, facility and Lagos day, in the staff context', async () => {
    const { service, query, database } = notices();
    service.afterAuthorization(context, patientId, allowed);
    await service.settle();
    service.afterAuthorization(context, patientId, allowed);
    service.afterAuthorization(context, patientId, { ...allowed, consentGrantId: 'g2' });
    await service.settle();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('select identity.note_record_access($1) as outcome', ['g1']);
    expect(database.withTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    service.afterAuthorization({ ...context, facilityId: 'f2' } as DataAccessContext, patientId, allowed);
    await service.settle();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('skips break-glass, denials, decisions without a grant and patient actors', async () => {
    const { service, query } = notices();
    service.afterAuthorization(context, patientId, { ...allowed, breakGlass: true });
    service.afterAuthorization(context, patientId, { ...allowed, allowed: false });
    service.afterAuthorization(context, patientId, { ...allowed, consentGrantId: undefined });
    service.afterAuthorization({ ...context, actor: { kind: 'patient' } } as unknown as DataAccessContext, patientId, allowed);
    await service.settle();
    expect(query).not.toHaveBeenCalled();
  });

  it('never throws; logs the code only, and tries again later after a failure', async () => {
    const failing = notices(async () => { throw Object.assign(new Error('relation patients Ada Obi'), { code: '42883' }); });
    const warn = jest.spyOn((failing.service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    expect(() => failing.service.afterAuthorization(context, patientId, allowed)).not.toThrow();
    await failing.service.settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=42883'));
    expect(warn.mock.calls[0]?.[0]).not.toContain('Ada');
    failing.service.afterAuthorization(context, patientId, allowed);
    await failing.service.settle();
    expect(failing.query).toHaveBeenCalledTimes(2);
  });

  it('days are Africa/Lagos days', () => {
    expect(lagosDay(new Date('2026-10-28T22:59:59Z'))).toBe('2026-10-28');
    expect(lagosDay(new Date('2026-10-28T23:00:00Z'))).toBe('2026-10-29');
  });

  it('IdentityService.authorize and lookupPatient call it after recording the decision; consentStatus does not', async () => {
    const provider = { authorize: jest.fn().mockResolvedValue(allowed), consentStatus: jest.fn().mockResolvedValue({}),
      lookupExactHid: jest.fn().mockResolvedValue({ id: patientId, hidCode: 'HID-ABC234', rowVersion: 1 }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const hook = { afterAuthorization: jest.fn() };
    const identity = new IdentityService(provider as unknown as IdentityProvider, audit as unknown as AuditService,
      hook as unknown as RecordAccessNoticeService);
    await identity.authorize(patientId, 'read_records', 'direct-care', context);
    await identity.lookupPatient('HID-ABC234', 'direct-care', context);
    await identity.consentStatus(patientId, 'direct-care', context);
    expect(hook.afterAuthorization).toHaveBeenCalledTimes(2);
    expect(hook.afterAuthorization).toHaveBeenCalledWith(context, patientId, allowed);
    // Without the service (an older wiring) authorization is unchanged.
    await expect(new IdentityService(provider as unknown as IdentityProvider, audit as unknown as AuditService)
      .authorize(patientId, 'read_records', 'direct-care', context)).resolves.toBe(allowed);
  });
});
