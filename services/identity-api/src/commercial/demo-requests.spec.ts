import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_PERMISSIONS, PUBLIC_ROUTE } from '../common/decorators';
import type { HidRequest, PlatformAdminContext } from '../common/request-context';
import * as environment from '../config/environment';
import { AdminDemoRequestsController, PublicDemoRequestsController } from './demo-requests.controller';
import type { CreateDemoRequestDto } from './demo-request.dto';
import { DemoRequestsService } from './demo-requests.service';

const input: CreateDemoRequestDto = {
  contactName: 'Ada Example', contactEmail: 'Ada@Example.Invalid',
  organizationName: 'Example Clinic', productCode: 'ehr',
  turnstileAction: 'book-demo', turnstileToken: 'opaque-proof',
};
const request = {
  correlationId: 'demo-correlation-0001', ip: '203.0.113.1',
  header: jest.fn((name: string) => name === 'origin' ? 'https://www.healthidentitydirectory.com' : undefined),
} as unknown as HidRequest;

describe('commercial demo intake boundary', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requires an allowed origin and a completed Turnstile check before storing a public request', async () => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com',
    } as environment.Environment);
    const submit = jest.fn().mockResolvedValue({ accepted: true, replayed: false });
    const verify = jest.fn().mockResolvedValue(undefined);
    const controller = new PublicDemoRequestsController(
      { submit } as unknown as DemoRequestsService, { verify } as never);
    await expect(controller.submit(input, 'public-demo-key-0001', request)).resolves.toEqual({
      accepted: true, replayed: false,
    });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      action: 'book-demo', origin: 'https://www.healthidentitydirectory.com',
    }));
    expect(submit).toHaveBeenCalledTimes(1);

    const denied = { ...request, header: () => 'https://untrusted.example' } as unknown as HidRequest;
    await expect(controller.submit(input, 'public-demo-key-0002', denied)).rejects.toMatchObject({
      code: 'ORIGIN_DENIED',
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('keeps admin list and state changes behind explicit platform permissions', () => {
    expect(Reflect.getMetadata(PUBLIC_ROUTE, PublicDemoRequestsController.prototype.submit)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, AdminDemoRequestsController.prototype.list))
      .toEqual(['platform.demo.read']);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, AdminDemoRequestsController.prototype.transition))
      .toEqual(['platform.demo.manage']);
  });

  it('deduplicates a public retry and never writes contact details to semantic audit', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    const database = { withSystemTransaction: jest.fn(async (_id, operation) => operation({ query })) };
    const audit = { recordWithClient: jest.fn() };
    const service = new DemoRequestsService(database as never, audit as never);
    await expect(service.submit(input, 'public-demo-key-0001', request)).resolves.toEqual({
      accepted: true, replayed: false,
    });
    await expect(service.submit(input, 'public-demo-key-0001', request)).resolves.toEqual({
      accepted: true, replayed: true,
    });
    expect(query.mock.calls[0]?.[1]?.[3]).toBe('ada@example.invalid');
    expect(query.mock.calls[0]?.[1]?.[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    const event = audit.recordWithClient.mock.calls[0]?.[1];
    expect(JSON.stringify(event)).not.toContain('Ada@Example.Invalid');
    expect(JSON.stringify(event)).not.toContain('Example Clinic');
  });

  // Migration 0064 (audit_platform_scope_ck) accepts a platform actor's audit row only when its action starts with
  // 'admin.' or 'api.admin.' and it names no facility, membership or organization. A row outside that shape fails the
  // insert, which rolled back the whole list and answered the Overview with a 500.
  it('writes platform administrators\' demo-request audit rows in the shape the platform audit constraint accepts', async () => {
    const migration = readFileSync(join(__dirname, '../../../ehr-api/database/migrations/0064_standalone_platform_administration.sql'), 'utf8');
    const constraint = migration.slice(migration.indexOf('audit_platform_scope_ck'));
    expect(constraint).toMatch(/action like 'admin\.%' or action like 'api\.admin\.%'/);
    const accepted = (event: Record<string, unknown>) => event.actorType !== 'platform' || (
      typeof event.action === 'string' && (event.action.startsWith('admin.') || event.action.startsWith('api.admin.'))
      && event.facilityId == null && event.actorMembershipId == null && event.organizationId == null
      && event.patientId == null && event.purposeOfUse === 'healthcare-operations'
      && Boolean(event.actorAccountId) && Boolean(event.actorSubject));

    const row = { id: '7f1c2c1e-6a43-4c8e-9a8f-1d0f7a3b9c11', contactName: 'Ada Example', contactEmail: 'ada@example.invalid',
      contactPhone: null, contactRole: null, organizationName: null, organizationType: null, productCode: 'ehr',
      message: null, sourcePage: null, sourceSection: null, ctaLabel: null, status: 'new', version: '1',
      createdAt: new Date('2026-11-02T08:00:00Z'), updatedAt: new Date('2026-11-02T08:00:00Z') };
    const query = jest.fn(async (sql: string) => ({ rows: [sql.trimStart().startsWith('update')
      ? { ...row, status: 'contacted', version: '2' } : row], rowCount: 1 }));
    const database = { withPlatformTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    const audit = { recordWithClient: jest.fn() };
    const service = new DemoRequestsService(database as never, audit as never);
    const context: PlatformAdminContext = {
      actor: { kind: 'staff', subject: 'admin-subject', accountId: '0b1f6c9e-2d4a-4c1b-8e7f-3a2b1c0d9e8f',
        platformPermissions: ['platform.admin.access', 'platform.demo.read', 'platform.demo.manage'] },
      correlationId: 'admin-demo-correlation', purposeOfUse: 'healthcare-operations',
    } as unknown as PlatformAdminContext;

    await expect(service.list(context, { status: 'new', limit: 100 })).resolves.toMatchObject({ items: [{ id: row.id }] });
    await expect(service.transition(context, row.id, 1, { status: 'contacted', reason: 'Called the clinic back' }))
      .resolves.toMatchObject({ status: 'contacted', replayed: false });
    const events = audit.recordWithClient.mock.calls.map(([, event]) => event as Record<string, unknown>);
    expect(events.map((event) => event.action)).toEqual(['admin.demo-requests.list', 'admin.demo-request.status']);
    for (const event of events) {
      expect(event.actorType).toBe('platform');
      expect(accepted(event)).toBe(true);
    }
  });
});
