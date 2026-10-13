import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdentityApiClient } from '@hid/api-client';
import { REQUIRED_PERMISSIONS } from '../common/decorators';
import { resetEnvironmentForTests } from '../config/environment';
import { OutreachController } from '../outreach/outreach.controller';
import { OutreachSecurityGuard } from './outreach-security.guard';
import type { DatabaseService } from '../database/database.service';

const ORIGIN = 'https://staging.healthidentitydirectory.com';
const facilityId = '123e4567-e89b-42d3-a456-426614174001';
const cookie = 'hid_access=opaque; hid_access_csrf=csrf';

function execution(headers: Record<string, string | undefined>, method?: string): ExecutionContext {
  const request = { correlationId: 'correlation-12345678', ...(method ? { method } : {}),
    header: jest.fn((name: string) => headers[name.toLowerCase()]) };
  return { getHandler: () => null, getClass: () => null,
    switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function guard(permission: string) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValueOnce(false)
    .mockReturnValueOnce([permission]) } as unknown as Reflector;
  const workload = { headers: jest.fn().mockResolvedValue({ 'x-hid-service-token': 'unused-in-this-test' }) };
  // Runtime controls: not in maintenance, Outreach portal enabled.
  const database = { query: jest.fn(async (_sql: string, parameters: unknown[]) =>
    ({ rows: [{ enabled: parameters[0] !== 'maintenance_mode' }] })) } as unknown as DatabaseService;
  return new OutreachSecurityGuard(reflector, workload as never, database);
}

function identityAuthorizes(permission: string) {
  return jest.spyOn(IdentityApiClient.prototype, 'authorizeOutreachPermission').mockResolvedValue({
    id: 'staff:doctor', subject: 'staff:doctor', accountId: '123e4567-e89b-42d3-a456-426614174009', kind: 'staff',
    roles: ['doctor'], permissions: [permission], platformRoles: [], platformPermissions: [],
    facilityIds: [facilityId], authenticationMethod: 'local',
    facilities: [{ id: facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174008',
      organizationId: '123e4567-e89b-42d3-a456-426614174007', name: 'Facility A', roles: ['doctor'],
      permissions: [permission], isPrimary: true }],
  } as never);
}

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: ORIGIN, OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
    OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: 'outreach-test-workload-token-0123456789abcdef' });
  resetEnvironmentForTests();
});
afterEach(() => jest.restoreAllMocks());

describe('OutreachSecurityGuard', () => {
  it('requires Identity user authentication independently of workload credentials', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValueOnce(false)
      .mockReturnValueOnce(['outreach.registration.read']) } as unknown as Reflector;
    const workload = { headers: jest.fn() };
    const database = { query: jest.fn().mockResolvedValue({ rows: [{ enabled: true }] }) } as unknown as DatabaseService;
    await expect(new OutreachSecurityGuard(reflector, workload as never, database).canActivate(execution({
      'x-facility-id': facilityId,
    }, 'GET'))).rejects.toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(workload.headers).not.toHaveBeenCalled();
  });

  it('requires origin and CSRF evidence for a cookie-authenticated request whose method is not a read', async () => {
    const identity = identityAuthorizes('outreach.registration.write');
    await expect(guard('outreach.registration.write').canActivate(execution({
      'x-facility-id': facilityId, cookie: 'hid_session=opaque',
    }))).rejects.toMatchObject({ status: 403, code: 'CSRF_VALIDATION_FAILED' });
    expect(identity).not.toHaveBeenCalled();
  });

  // A same-origin browser GET carries the cookie but neither Origin nor
  // X-CSRF-Token, so Outreach must not demand them for a read. It reports the
  // method to Identity, which then skips its browser-write check (ADR-043).
  it.each(['GET', 'HEAD'])('authorizes a same-origin cookie %s with no Origin or CSRF, reporting the method to Identity',
    async (method) => {
      const identity = identityAuthorizes('outreach.registration.read');
      await expect(guard('outreach.registration.read').canActivate(execution({
        'x-facility-id': facilityId, cookie,
      }, method))).resolves.toBe(true);
      expect(identity).toHaveBeenCalledTimes(1);
      expect(identity).toHaveBeenCalledWith('outreach.registration.read', expect.objectContaining({
        requestMethod: method, cookie, facilityId, origin: undefined, csrfToken: undefined }));
    });

  it('authorizes a cookie read that names an allowed Origin', async () => {
    const identity = identityAuthorizes('outreach.campaign.read');
    await expect(guard('outreach.campaign.read').canActivate(execution({
      'x-facility-id': facilityId, cookie, origin: ORIGIN,
    }, 'GET'))).resolves.toBe(true);
    expect(identity).toHaveBeenCalledWith('outreach.campaign.read',
      expect.objectContaining({ requestMethod: 'GET', origin: ORIGIN }));
  });

  it('refuses a cookie read from a disallowed Origin before contacting Identity', async () => {
    const identity = identityAuthorizes('outreach.registration.read');
    await expect(guard('outreach.registration.read').canActivate(execution({
      'x-facility-id': facilityId, cookie, origin: 'https://attacker.example',
    }, 'GET'))).rejects.toMatchObject({ status: 403, code: 'ORIGIN_DENIED' });
    expect(identity).not.toHaveBeenCalled();
  });

  it('still refuses a cookie write without a CSRF token or without an allowed Origin', async () => {
    const identity = identityAuthorizes('outreach.registration.write');
    await expect(guard('outreach.registration.write').canActivate(execution({
      'x-facility-id': facilityId, cookie, origin: ORIGIN,
    }, 'POST'))).rejects.toMatchObject({ status: 403, code: 'CSRF_VALIDATION_FAILED' });
    await expect(guard('outreach.registration.write').canActivate(execution({
      'x-facility-id': facilityId, cookie, 'x-csrf-token': 'csrf',
    }, 'POST'))).rejects.toMatchObject({ status: 403, code: 'CSRF_VALIDATION_FAILED' });
    await expect(guard('outreach.registration.write').canActivate(execution({
      'x-facility-id': facilityId, cookie, 'x-csrf-token': 'csrf', origin: 'https://attacker.example',
    }, 'POST'))).rejects.toMatchObject({ status: 403, code: 'CSRF_VALIDATION_FAILED' });
    expect(identity).not.toHaveBeenCalled();
  });

  it('passes a cookie write with Origin and CSRF to Identity as a POST, with its evidence', async () => {
    const identity = identityAuthorizes('outreach.registration.write');
    await expect(guard('outreach.registration.write').canActivate(execution({
      'x-facility-id': facilityId, cookie, origin: ORIGIN, 'x-csrf-token': 'csrf',
    }, 'POST'))).resolves.toBe(true);
    expect(identity).toHaveBeenCalledWith('outreach.registration.write', expect.objectContaining({
      requestMethod: 'POST', origin: ORIGIN, csrfToken: 'csrf', cookie }));
  });

  it('fails closed when a read method is mapped to a permission that is not a read', async () => {
    const identity = identityAuthorizes('outreach.registration.write');
    await expect(guard('outreach.registration.write').canActivate(execution({
      'x-facility-id': facilityId, cookie,
    }, 'GET'))).rejects.toMatchObject({ status: 500, code: 'OUTREACH_POLICY_INVALID' });
    expect(identity).not.toHaveBeenCalled();
  });
});

describe('Outreach route permissions', () => {
  const reflector = new Reflector();
  const handlers = Object.getOwnPropertyNames(OutreachController.prototype).filter((name) => name !== 'constructor')
    .map((name) => ({ name, handler: (OutreachController.prototype as unknown as Record<string, () => unknown>)[name] as () => unknown }));
  // Nest's RequestMethod: 0 is GET, 1 is POST.
  const method = (handler: () => unknown) => Reflect.getMetadata('method', handler) as number;

  it('maps every GET route to exactly one read permission and every POST route to exactly one write permission', () => {
    expect(handlers.length).toBeGreaterThan(0);
    for (const { name, handler } of handlers) {
      const permissions = reflector.get<string[]>(REQUIRED_PERMISSIONS, handler);
      expect({ name, permissions }).toEqual({ name, permissions: [expect.any(String)] });
      const suffix = method(handler) === 0 ? '.read' : '.write';
      expect({ name, permission: permissions[0]?.endsWith(suffix) }).toEqual({ name, permission: true });
    }
  });

  it('requires only permissions that Identity\'s Outreach authorization accepts, except the closed campaign writes', () => {
    const dto = readFileSync(join(__dirname, '../../../identity-api/src/identity/dto/authorize-outreach.dto.ts'), 'utf8');
    const accepted = new Set([...(dto.match(/OUTREACH_PERMISSIONS = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)]
      .map((match) => match[1]));
    expect(dto).toContain('@IsIn(OUTREACH_PERMISSIONS)');
    // Identity refuses outreach.campaign.write until campaigns have their own
    // governance (ADR-045), so exactly these routes stay closed.
    const refused = handlers.filter(({ handler }) =>
      !accepted.has(reflector.get<string[]>(REQUIRED_PERMISSIONS, handler)[0] ?? ''));
    expect(refused.map(({ name }) => name).sort()).toEqual(['addCampaignMember', 'createCampaign', 'updateCampaignStatus']);
    for (const { handler } of refused) {
      expect(reflector.get<string[]>(REQUIRED_PERMISSIONS, handler)).toEqual(['outreach.campaign.write']);
    }
  });
});

// A4: a runtime-control fault other than a disabled control (a timeout, a lost
// connection, a missing grant) escaped the guard as a raw error and answered
// 500. A16: a platform administration grant exempted that person's staff
// session from maintenance mode and from outreach_portal_enabled, the D17
// control that keeps Outreach off.
describe('OutreachSecurityGuard runtime controls (A4, A16)', () => {
  function guardWith(query: (sql: string, parameters: unknown[]) => Promise<unknown>) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValueOnce(false)
      .mockReturnValueOnce(['outreach.registration.read']) } as unknown as Reflector;
    const workload = { headers: jest.fn().mockResolvedValue({ 'x-hid-service-token': 'unused-in-this-test' }) };
    return new OutreachSecurityGuard(reflector, workload as never, { query: jest.fn(query) } as unknown as DatabaseService);
  }
  function administratorAuthorized() {
    return jest.spyOn(IdentityApiClient.prototype, 'authorizeOutreachPermission').mockResolvedValue({
      id: 'staff:admin', subject: 'staff:admin', accountId: '123e4567-e89b-42d3-a456-426614174019', kind: 'staff',
      roles: ['doctor'], permissions: ['outreach.registration.read'], platformRoles: ['platform_super_admin'],
      platformPermissions: ['platform.admin.access'], facilityIds: [facilityId], authenticationMethod: 'local',
      facilities: [{ id: facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174018',
        organizationId: '123e4567-e89b-42d3-a456-426614174007', name: 'Facility A', roles: ['doctor'],
        permissions: ['outreach.registration.read'], isPrimary: true }],
    } as never);
  }
  const read = () => execution({ 'x-facility-id': facilityId, cookie }, 'GET');

  it.each([
    ['a statement timeout', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['a pool timeout', new Error('timeout exceeded when trying to connect')],
  ])('answers %s reading the controls with 503 PLATFORM_CONTROL_UNAVAILABLE, not 500', async (_label, fault) => {
    identityAuthorizes('outreach.registration.read');
    await expect(guardWith(async () => { throw fault; }).canActivate(read()))
      .rejects.toMatchObject({ status: 503, code: 'PLATFORM_CONTROL_UNAVAILABLE' });
  });

  it('answers a platform administrator\'s staff session 503 PLATFORM_MAINTENANCE in maintenance mode', async () => {
    administratorAuthorized();
    await expect(guardWith(async () => ({ rows: [{ enabled: true }] })).canActivate(read()))
      .rejects.toMatchObject({ status: 503, code: 'PLATFORM_MAINTENANCE' });
  });

  it('answers it 423 PLATFORM_PORTAL_DISABLED while outreach_portal_enabled is off', async () => {
    administratorAuthorized();
    await expect(guardWith(async () => ({ rows: [{ enabled: false }] })).canActivate(read()))
      .rejects.toMatchObject({ status: 423, code: 'PLATFORM_PORTAL_DISABLED' });
  });
});
