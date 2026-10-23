jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { AUDIT_ACTION, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { AdminController } from './admin.controller';
import type { AdminOperationsService } from './admin-operations.service';
import type { AdminService } from './admin.service';
import { ListPrincipalsDto } from './dto/admin-list.dto';
import type { PricingService } from './pricing.service';

// main A24: a principal search sends a name or an email address, which a GET
// query string puts in every request line an access log keeps. POST
// principals/search takes the same search in its body; GET principals stays.

type Handler = (...args: never[]) => unknown;
interface Route { name: string; handler: Handler; method: RequestMethod; path: string }

function route(method: RequestMethod, path: string): Route {
  const found = Object.getOwnPropertyNames(AdminController.prototype).flatMap((name) => {
    const handler = (AdminController.prototype as unknown as Record<string, Handler>)[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const routeMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    if (routeMethod === undefined) return [];
    return [{ name, handler, method: routeMethod, path: String(Reflect.getMetadata(PATH_METADATA, handler)) }];
  }).find((candidate) => candidate.method === method && candidate.path === path);
  expect(found).toBeDefined();
  return found!;
}

/** Whether the handler takes a @Body() parameter (Nest route argument type 3). */
function takesBody(found: Route): boolean {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminController, found.name) as Record<string, unknown> | undefined;
  return Object.keys(args ?? {}).some((key) => key.startsWith('3:'));
}

const adminRequest = () => ({ correlationId: 'principal-search-body',
  actor: { kind: 'staff', subject: 'standalone:administrator', platformPermissions: ['platform.admin.access', 'platform.principal.read'] },
  header: () => undefined } as unknown as HidRequest);

/** The global pipe from main.ts. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true,
  transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false });
const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: ListPrincipalsDto });

describe('POST /admin/principals/search (main A24)', () => {
  it('has the read permission, the list audit action and a 200 answer, and takes a body', () => {
    const search = route(RequestMethod.POST, 'principals/search');
    const list = route(RequestMethod.GET, 'principals');
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, search.handler)).toEqual(['platform.principal.read']);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, list.handler)).toEqual(['platform.principal.read']);
    expect(Reflect.getMetadata(AUDIT_ACTION, search.handler)).toBe(Reflect.getMetadata(AUDIT_ACTION, list.handler));
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, search.handler)).toBe(200);
    expect(takesBody(search)).toBe(true);
  });

  it('searches with the body, as GET /admin/principals does with the query', async () => {
    const admin = { listPrincipals: jest.fn().mockResolvedValue({ items: [], page: 2, pageSize: 10, total: 0 }) };
    const subject = new AdminController(admin as unknown as AdminService, {} as AdminOperationsService, {} as PricingService);
    const input = await validate({ query: 'ada@example.invalid', status: 'active', page: 2, pageSize: 10 });
    await expect(subject.searchPrincipals(input, adminRequest())).resolves.toEqual({ items: [], page: 2, pageSize: 10, total: 0 });
    expect(admin.listPrincipals).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'principal-search-body' }),
      expect.objectContaining({ query: 'ada@example.invalid', status: 'active', page: 2, pageSize: 10 }));
  });

  it('takes the body the production console sends, with the list defaults', async () => {
    await expect(validate({ query: 'ada', page: 1, pageSize: 25 })).resolves.toMatchObject({ query: 'ada', page: 1, pageSize: 25 });
    await expect(validate({ query: 'ada' })).resolves.toMatchObject({ page: 1, pageSize: 25 });
  });

  it.each([
    ['a one-character search', { query: 'a' }],
    ['no search', { page: 1 }],
    ['an unknown status', { query: 'ada', status: 'banned' }],
    ['a page size over 100', { query: 'ada', pageSize: 101 }],
    ['an unknown field', { query: 'ada', reason: 'not part of a search' }],
  ])('refuses %s', async (_case, body) => {
    await expect(validate(body)).rejects.toBeDefined();
  });
});
