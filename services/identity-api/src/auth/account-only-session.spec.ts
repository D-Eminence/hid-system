jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { of, lastValueFrom } from 'rxjs';
import { AuditInterceptor } from '../audit/audit.interceptor';
import type { AuditService } from '../audit/audit.service';
import { ACCOUNT_ONLY_ALLOWED, PUBLIC_ROUTE } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { SecurityGuard } from './security.guard';
import type { TokenService } from './token.service';

// Q88-2: a verified staff login with no membership, signed in on outreach.,
// gets an account-only session that reaches "Start an outreach group" and the
// session routes that page needs, and nothing else. This walks every route of
// every controller in identity-api through the real SecurityGuard.

const accountOnly: ActorContext = {
  kind: 'staff', id: 'staff:no-membership', subject: 'staff:no-membership',
  accountId: '20000000-0000-4000-8000-000000000099', sessionId: '90000000-0000-4000-8000-000000000099',
  roles: [], permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [],
  authenticationMethod: 'local', accountOnly: true,
};

/** The routes an account-only session may use, as "<Controller>.<method>". */
const ALLOWED = [
  'AuthController.session',
  'AuthController.logout',
  // Product sign-out while single sign-on is on (0125): today's sign-out, then the provider's end-session
  // address, so an account-only session on outreach. can sign out there as it does today.
  'AuthController.ssoLogout',
  'OutreachOrganiserAccountController.availability',
  'OutreachOrganiserAccountController.start',
].sort();

type Handler = (...args: never[]) => unknown;
interface Route { label: string; owner: object; handler: Handler; method: string; isPublic: boolean }

function controllerFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

function allRoutes(): Route[] {
  const reflector = new Reflector();
  const routes: Route[] = [];
  const source = join(__dirname, '..');
  for (const file of controllerFiles(source)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function' || Reflect.getMetadata(PATH_METADATA, value) === undefined) continue;
      const owner = value as (abstract new (...args: never[]) => unknown) & { prototype: Record<string, unknown> };
      for (const name of Object.getOwnPropertyNames(owner.prototype)) {
        const handler = owner.prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (method === undefined) continue;
        const isPublic = reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [handler as Handler, owner]) === true;
        routes.push({ label: `${owner.name}.${name} (${relative(source, file)})`, owner, handler: handler as Handler,
          method: HTTP_METHODS[method] ?? 'GET', isPublic });
      }
    }
  }
  return routes;
}

function guard() {
  const audit = { record: jest.fn(async () => undefined) };
  // Both portals on and maintenance mode off.
  const database = { query: jest.fn(async (_sql: string, parameters: unknown[]) =>
    ({ rows: [{ enabled: parameters[0] !== 'maintenance_mode' }], rowCount: 1 })) };
  const tokens = { verify: jest.fn(async () => ({ actor: accountOnly, claims: {} })), verifyCsrf: jest.fn(() => true) };
  return { guard: new SecurityGuard(new Reflector(), tokens as unknown as TokenService, audit as unknown as AuditService,
    database as unknown as DatabaseService), audit };
}

function httpRequest(method: string): HidRequest {
  const headers: Record<string, string> = { authorization: 'Bearer signed',
    origin: 'https://outreach.healthidentitydirectory.com' };
  return { method, correlationId: 'account-only-spec', ip: '127.0.0.1', route: { path: '/route' }, query: {}, params: {},
    cookies: {}, header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
}

function context(request: HidRequest, route: Route): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
    getHandler: () => route.handler, getClass: () => route.owner } as unknown as ExecutionContext;
}

const original = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'https://outreach.healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
});
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  resetEnvironmentForTests();
});

const ROUTES = allRoutes();
const signedIn = ROUTES.filter((route) => !route.isPublic);
const key = (route: Route) => route.label.split(' ')[0]!;

describe('an account-only session reaches "Start an outreach group" and nothing else (Q88-2)', () => {
  it('finds the controllers (a sanity check on the walk)', () => {
    expect(ROUTES.length).toBeGreaterThan(100);
    expect(signedIn.map(key)).toEqual(expect.arrayContaining(ALLOWED));
  });

  it('marks exactly the allowed routes', () => {
    const reflector = new Reflector();
    expect(signedIn.filter((route) => reflector.getAllAndOverride<boolean>(ACCOUNT_ONLY_ALLOWED,
      [route.handler, route.owner as never]) === true).map(key).sort()).toEqual(ALLOWED);
  });

  it.each(signedIn.filter((route) => ALLOWED.includes(key(route))).map((route) => [route.label, route] as const))(
    '%s: admitted', async (_label, route) => {
      const { guard: securityGuard } = guard();
      await expect(securityGuard.canActivate(context(httpRequest(route.method), route))).resolves.toBe(true);
    });

  it.each(signedIn.filter((route) => !ALLOWED.includes(key(route))).map((route) => [route.label, route] as const))(
    '%s: refused before the handler', async (_label, route) => {
      const { guard: securityGuard, audit } = guard();
      const request = httpRequest(route.method);
      const error = await securityGuard.canActivate(context(request, route)).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(DomainProblem);
      const problem = error as DomainProblem;
      expect(problem.getStatus()).toBe(403);
      // A patient-only route refuses every staff session first, in its own words (A9).
      expect(['NO_ACTIVE_FACILITY_MEMBERSHIP', 'PATIENT_SESSION_REQUIRED']).toContain(problem.code);
      expect(request.facilityId).toBeUndefined();
      // The refusal is audited as an authentication denial with no facility, which the audit layer accepts.
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'staff',
        action: 'auth.authorization.denied', resourceType: 'authentication', outcome: 'denied' }));
    });

  it('refuses the delegated service session, so EHR, Lab, Pharmacy, OCR and Outreach refuse it too', async () => {
    const route = signedIn.find((candidate) => key(candidate) === 'AuthController.validateServiceMutation')!;
    const { guard: securityGuard } = guard();
    await expect(securityGuard.canActivate(context(httpRequest('POST'), route)))
      .rejects.toMatchObject({ code: 'NO_ACTIVE_FACILITY_MEMBERSHIP', status: 403 });
  });
});

describe('"Start an outreach group" answers an account-only session without an interceptor row', () => {
  // With no X-Facility-ID, an interceptor row would be a staff row with no
  // facility, which the audit layer refuses (503); the start command writes
  // its own row at the new group (identity.create_outreach_group, 0115).
  it.each(['availability', 'start'])('%s is not audited by the interceptor', async (name) => {
    const route = signedIn.find((candidate) => key(candidate) === `OutreachOrganiserAccountController.${name}`)!;
    const audit = { record: jest.fn(async () => { throw new Error('a staff row with no facility'); }) };
    const interceptor = new AuditInterceptor(new Reflector(), audit as unknown as AuditService);
    const request = { ...httpRequest(route.method), actor: accountOnly } as HidRequest;
    await expect(lastValueFrom(interceptor.intercept(context(request, route), { handle: () => of({ open: true }) })))
      .resolves.toEqual({ open: true });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
