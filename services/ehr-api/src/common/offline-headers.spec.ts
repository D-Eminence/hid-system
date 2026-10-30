import type { AuditEventInput, AuditService } from '../audit/audit.service';
import type { DatabaseService } from '../database/database.service';
import { DocumentService } from '../documents/document.service';
import { ClinicalRepository } from '../ehr/shared/clinical.repository';
import type { IdentityApiService } from '../integrations/identity-api.service';
import type { StorageProvider } from '../storage/storage.types';
import { parseOfflineHeaders, requireRequestContext, type DataAccessContext, type HidRequest } from './request-context';

// C3 (§2.10): a replayed offline write may carry X-HID-Offline-Command,
// X-HID-Captured-At and X-HID-Clock. They are recorded in the write's audit
// as details.offline; an invalid one is ignored and none ever refuses.

const NOW = Date.parse('2026-10-29T10:42:00.000Z');
const COMMAND = 'off1.0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6';
const facilityId = '10000000-0000-4000-8000-000000000002';
const patientId = '60000000-0000-4000-8000-000000000001';
const actor = { id: 'staff:nurse', subject: 'staff:nurse', accountId: '20000000-0000-4000-8000-000000000001',
  roles: ['nurse'], permissions: ['ehr.vital.write'], facilityIds: [facilityId], authenticationMethod: 'local' as const,
  facilities: [], facility: { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: facilityId, name: 'Demo Hospital', roles: ['nurse'], permissions: ['ehr.vital.write'], isPrimary: true } };

const headers = (values: Record<string, string>) => {
  const lower = Object.fromEntries(Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]));
  return { header: (name: string) => lower[name.toLowerCase()] } as Pick<HidRequest, 'header'>;
};

function request(values: Record<string, string>): HidRequest {
  return { method: 'POST', correlationId: 'correlation-offline-c3-0001', actor, facilityId,
    ...headers({ 'X-Purpose-Of-Use': 'direct-care', ...values }) } as unknown as HidRequest;
}

describe('parseOfflineHeaders', () => {
  it('records valid headers', () => {
    expect(parseOfflineHeaders(headers({ 'X-HID-Offline-Command': COMMAND, 'X-HID-Captured-At': '2026-10-29T09:12:03.120Z',
      'X-HID-Clock': 'anchored' }), NOW)).toEqual({ commandId: COMMAND, capturedAt: '2026-10-29T09:12:03.120Z',
      clock: 'anchored', capturedClamped: false });
  });

  it('is absent on an online write and when every header is invalid', () => {
    expect(parseOfflineHeaders(headers({}), NOW)).toBeUndefined();
    expect(parseOfflineHeaders(headers({ 'X-HID-Offline-Command': 'off1.not-a-uuid', 'X-HID-Captured-At': 'yesterday',
      'X-HID-Clock': 'atomic' }), NOW)).toBeUndefined();
  });

  it.each([
    ['command without the off1. prefix', { 'X-HID-Offline-Command': '0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6' }],
    ['command with trailing text', { 'X-HID-Offline-Command': `${COMMAND}x` }],
    ['two commands', { 'X-HID-Offline-Command': `${COMMAND}, ${COMMAND}` }],
    ['captured time with an offset', { 'X-HID-Captured-At': '2026-10-29T10:12:03+01:00' }],
    ['captured time that is not a date', { 'X-HID-Captured-At': '2026-13-45T99:99:99Z' }],
    ['clock in another case', { 'X-HID-Clock': 'Anchored' }],
    ['captured time on 31 September', { 'X-HID-Captured-At': '2026-09-31T10:00:00Z' }],
    ['captured time at hour 24', { 'X-HID-Captured-At': '2026-10-28T24:00:00.000Z' }],
  ])('ignores %s and keeps the valid headers', (_case, invalid) => {
    const parsed = parseOfflineHeaders(headers({ 'X-HID-Clock': 'wall', 'X-HID-Offline-Command': COMMAND, ...invalid }), NOW);
    expect(parsed).toBeDefined();
    for (const [name, field] of [['X-HID-Offline-Command', 'commandId'], ['X-HID-Captured-At', 'capturedAt'],
      ['X-HID-Clock', 'clock']] as const) {
      if (name in invalid) expect(parsed?.[field]).toBeNull();
    }
  });

  it('clamps a capture time outside [now - 24 h, now + 5 min] and flags it', () => {
    const at = (value: string) => parseOfflineHeaders(headers({ 'X-HID-Captured-At': value }), NOW);
    expect(at('2026-10-29T10:47:00.000Z')).toMatchObject({ capturedAt: '2026-10-29T10:47:00.000Z', capturedClamped: false });
    expect(at('2026-10-29T12:00:00.000Z')).toMatchObject({ capturedAt: '2026-10-29T10:47:00.000Z', capturedClamped: true });
    expect(at('2026-10-27T10:00:00.000Z')).toMatchObject({ capturedAt: '2026-10-28T10:42:00.000Z', capturedClamped: true });
  });

  it('keeps the device capture time as deviceCapturedAt only when it was clamped (contract A10)', () => {
    const at = (value: string) => parseOfflineHeaders(headers({ 'X-HID-Captured-At': value }), NOW);
    expect(at('2026-10-27T10:00:00.000Z')).toEqual({ commandId: null, capturedAt: '2026-10-28T10:42:00.000Z', clock: null,
      capturedClamped: true, deviceCapturedAt: '2026-10-27T10:00:00.000Z' });
    expect(at('2026-10-29T09:00:00.000Z')).not.toHaveProperty('deviceCapturedAt');
  });
});

describe('requireRequestContext and the offline headers', () => {
  it('adds valid headers to DataAccessContext.offline and never refuses for an invalid one', () => {
    expect(requireRequestContext(request({ 'X-HID-Offline-Command': COMMAND, 'X-HID-Clock': 'suspect' })).offline)
      .toEqual({ commandId: COMMAND, capturedAt: null, clock: 'suspect', capturedClamped: false });
    const ignored = requireRequestContext(request({ 'X-HID-Offline-Command': 'nonsense', 'X-HID-Clock': '' }));
    expect(ignored).toMatchObject({ facilityId, purposeOfUse: 'direct-care' });
    expect(ignored).not.toHaveProperty('offline');
  });
});

describe('audits of replayed writes', () => {
  const offline = { commandId: COMMAND, capturedAt: '2026-10-29T09:12:03.120Z', clock: 'anchored' as const,
    capturedClamped: false };
  const context = (withOffline: boolean) => ({ correlationId: 'correlation-offline-c3-0001', actor, facilityId,
    membershipId: actor.facility.membershipId, purposeOfUse: 'direct-care',
    ...(withOffline ? { offline } : {}) }) as DataAccessContext;

  async function clinicalAudit(withOffline: boolean): Promise<AuditEventInput[]> {
    const recorded: AuditEventInput[] = [];
    const repository = new ClinicalRepository(
      { withTransaction: async (_context: unknown, operation: (client: unknown) => Promise<unknown>) => operation({}) } as unknown as DatabaseService,
      { recordWithClient: async (_client: unknown, event: AuditEventInput) => { recorded.push(event); },
        record: async (event: AuditEventInput) => { recorded.push(event); } } as unknown as AuditService,
      { authorize: async () => ({ allowed: true, breakGlass: false }) } as unknown as IdentityApiService,
    );
    await repository.run(context(withOffline), patientId, 'write_records',
      { action: 'ehr.vital.create', resourceType: 'vital', details: { idempotentReplay: false } },
      async () => ({ value: { id: 'vital-1' }, resourceId: 'vital-1' }));
    return recorded;
  }

  it('merges details.offline into the clinical write audit', async () => {
    expect(await clinicalAudit(true)).toEqual([expect.objectContaining({ action: 'ehr.vital.create', outcome: 'success',
      details: { idempotentReplay: false, offline } })]);
  });

  it('leaves an online clinical write audit as it was', async () => {
    const [event] = await clinicalAudit(false);
    expect(event?.details).toEqual({ idempotentReplay: false });
  });

  it('merges details.offline into the document audit', () => {
    const documents = new DocumentService({} as DatabaseService, {} as IdentityApiService, {} as AuditService,
      {} as StorageProvider);
    const audit = (withOffline: boolean) => documents['auditEvent'](context(withOffline), 'ehr.document.upload-intent.create',
      'success', patientId, 'document-1');
    expect(audit(true)).toMatchObject({ action: 'ehr.document.upload-intent.create', resourceType: 'document',
      details: { offline } });
    expect(audit(false).details).toEqual({});
  });
});
