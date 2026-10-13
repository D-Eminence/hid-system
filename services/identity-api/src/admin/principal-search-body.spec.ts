jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { RequestMethod, type ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AuditService } from '../audit/audit.service';
import type { TokenService } from '../auth/token.service';
import { SecurityGuard } from '../auth/security.guard';
import { HIGH_RISK_ACTION, PLATFORM_SCOPE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { assuranceResult, isAssuranceQuery, platformActor, useTestEnvironment } from '../testing/platform-assurance';
import { AdminController } from './admin.controller';
import type { AdminOperationsService } from './admin-operations.service';
import type { AdminService } from './admin.service';
import { platformActionPolicy } from './high-risk-policy';
import type { PricingService } from './pricing.service';

// A24: the principal search sent names and email addresses, and the export
// sent those and its audit reason, in GET query strings, which request-line
// access logs keep. The searches move to POST bodies; the GET forms stay for
// one deprecation release so the Health-id admin console keeps working.

useTestEnvironment();

type Handler = (...args: never[]) => unknown;
interface Route { name: string; handler: Handler; method: RequestMethod; path: string }

function routes(): Route[] {
  return Object.getOwnPropertyNames(AdminController.prototype).flatMap((name) => {
    const handler = (AdminController.prototype as unknown as Record<string, Handler>)[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    if (method === undefined) return [];
    return [{ name, handler, method, path: String(Reflect.getMetadata(PATH_METADATA, handler)) }];
  });
}

function route(method: RequestMethod, path: string): Route {
  const found = routes().find((candidate) => candidate.method === method && candidate.path === path);
  expect(found).toBeDefined();
  return found!;
}

/** The handler's @Body() parameter index, if it has one (Nest route argument metadata). */
function bodyParameter(found: Route): boolean {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminController, found.name) as Record<string, unknown> | undefined;
  return Object.keys(args ?? {}).some((key) => key.startsWith('3:'));
}

function controller() {
  const admin = { listPrincipals: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 }),
    exportPrincipals: jest.fn().mockResolvedValue({ csv: 'account_id\r\n', rowCount: 0, truncated: false }) };
  const subject = new AdminController(admin as unknown as AdminService, {} as AdminOperationsService, {} as PricingService);
  return { admin, subject };
}

const adminRequest = () => ({ correlationId: 'principal-search-body', accessScope: 'platform',
  actor: platformActor({ facility: undefined }), header: () => undefined } as unknown as HidRequest);

describe('POST /admin/principals/search (A24)', () => {
  it('is a platform route with the read permission, its own standard policy and a 200 answer', () => {
    const search = route(RequestMethod.POST, 'principals/search');
    expect(Reflect.getMetadata(PLATFORM_SCOPE, AdminController)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, search.handler)).toEqual(['platform.principal.read']);
    expect(Reflect.getMetadata(HIGH_RISK_ACTION, search.handler)).toBe('platform.principals.search');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, search.handler)).toBe(200);
    expect(bodyParameter(search)).toBe(true);
    expect(platformActionPolicy('platform.principals.search')).toEqual({ tier: 'standard',
      permissions: ['platform.principal.read'], stepUp: false, reason: false, ifMatch: false, idempotencyKey: false,
      approval: 'none' });
  });

  it('searches with the body, as GET /admin/principals does with the query', async () => {
    const { admin, subject } = controller();
    const search = route(RequestMethod.POST, 'principals/search');
    const input = { query: 'ada@example.invalid', status: 'active', page: 2, pageSize: 10 };
    await (search.handler as unknown as (this: AdminController, body: unknown, request: HidRequest) => Promise<unknown>)
      .call(subject, input, adminRequest());
    expect(admin.listPrincipals).toHaveBeenCalledWith(expect.objectContaining({ scope: 'platform' }), input);
  });

  it('keeps GET /admin/principals for the Health-id 82b474e admin console', () => {
    const list = route(RequestMethod.GET, 'principals');
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, list.handler)).toEqual(['platform.principal.read']);
  });
});

describe('POST /admin/principals/export (A24)', () => {
  it('takes the reason in the body, with the export permission and policy', () => {
    const exported = route(RequestMethod.POST, 'principals/export');
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, exported.handler)).toEqual(['platform.principal.export']);
    expect(Reflect.getMetadata(HIGH_RISK_ACTION, exported.handler)).toBe('platform.principals.export');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, exported.handler)).toBe(200);
    expect(bodyParameter(exported)).toBe(true);
    expect(route(RequestMethod.GET, 'principals/export')).toBeDefined();
  });

  it('sends the same CSV and export headers as the GET form', async () => {
    const { admin, subject } = controller();
    const exported = route(RequestMethod.POST, 'principals/export');
    const response = { status: jest.fn().mockReturnThis(), setHeader: jest.fn().mockReturnThis(), send: jest.fn() };
    const input = { query: 'ada', status: 'active', reason: 'Quarterly access review' };
    await (exported.handler as unknown as (this: AdminController, body: unknown, request: HidRequest,
      response: Response) => Promise<unknown>).call(subject, input, adminRequest(), response as unknown as Response);
    expect(admin.exportPrincipals).toHaveBeenCalledWith(expect.objectContaining({ scope: 'platform' }), input);
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8; header=present');
    expect(response.setHeader).toHaveBeenCalledWith('X-HID-Export-Row-Count', '0');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.send).toHaveBeenCalledWith('account_id\r\n');
  });

  function guard() {
    const database = { query: jest.fn(async (sql: string) => isAssuranceQuery(sql) ? assuranceResult({ stepUpFresh: true })
      : { rows: [{ enabled: true }], rowCount: 1 }) };
    const tokens = { verify: jest.fn().mockResolvedValue({ actor: platformActor(), claims: {}, mfaAssured: true }),
      verifyCsrf: jest.fn(() => true) };
    return new SecurityGuard(new Reflector(), tokens as unknown as TokenService,
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService, database as unknown as DatabaseService);
  }
  function exportContext(body: unknown, query: Record<string, string> = {}): ExecutionContext {
    const headers: Record<string, string> = { authorization: 'Bearer signed' };
    const request = { method: 'POST', correlationId: 'principal-export-body', ip: '127.0.0.1', body, query, cookies: {},
      route: { path: '/admin/principals/export' }, header: (name: string) => headers[name.toLowerCase()] };
    return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
      getHandler: () => route(RequestMethod.POST, 'principals/export').handler, getClass: () => AdminController,
    } as unknown as ExecutionContext;
  }

  it('has the guard read the export reason from the POST body, not the query string', async () => {
    await expect(guard().canActivate(exportContext({ reason: 'Quarterly access review' }))).resolves.toBe(true);
    const refused = await guard().canActivate(exportContext({}, { reason: 'Quarterly access review' }))
      .then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(DomainProblem);
    expect((refused as DomainProblem).code).toBe('REASON_REQUIRED');
  });
});
