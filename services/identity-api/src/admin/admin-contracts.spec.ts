// PlatformSecurityService imports TokenService, whose ESM-only JOSE dependency these tests never use.
jest.mock('jose', () => ({}));

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { TokenService } from '../auth/token.service';
import { DemoRequestsService } from '../commercial/demo-requests.service';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { DomainProblem } from '../common/problem';
import type { PlatformAccessContext } from '../common/request-context';
import { CORS_EXPOSED_HEADERS, corsOptions, EXPORT_RESPONSE_HEADERS } from '../config/cors';
import type { DatabaseService } from '../database/database.service';
import { platformActor, useTestEnvironment } from '../testing/platform-assurance';
import { AdminService } from './admin.service';
import { ListPlatformAuditDto } from './dto/admin-list.dto';
import { ListApprovalsDto } from './dto/platform-security.dto';
import { PlatformSecurityService } from './platform-security.service';

/** Stage 4A platform administration contracts. */
const context: PlatformAccessContext = {
  scope: 'platform', correlationId: 'admin-contracts-correlation', facilityId: null, membershipId: null,
  purposeOfUse: 'healthcare-operations', actor: platformActor(),
};

function database(rows: (sql: string, parameters: unknown[]) => Record<string, unknown>[]) {
  const query = jest.fn(async (sql: string, parameters: unknown[] = []) => {
    const result = rows(sql, parameters);
    return { rows: result, rowCount: result.length };
  });
  const client = { query } as unknown as PoolClient;
  return { query, database: { withTransaction: jest.fn(async (_context, operation) => operation(client)) } as unknown as DatabaseService };
}
const audit = () => ({ recordWithClient: jest.fn().mockResolvedValue(undefined) }) as unknown as AuditService;
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n: number) => `2026-10-0${n % 9 + 1}T08:00:00.${String(n).padStart(6, '0')}Z`;

async function refusal(promise: Promise<unknown> | (() => unknown)): Promise<DomainProblem> {
  const error = typeof promise === 'function'
    ? (() => { try { promise(); return undefined; } catch (failure) { return failure; } })()
    : await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

useTestEnvironment();

describe('opaque list cursors', () => {
  const filters = { status: 'pending' };
  const valid = encodeCursor('admin.approvals', filters, { at: '2026-10-09T08:00:00.123456Z', id: uuid(1) });

  it('round-trips a position for the same list and filters', () => {
    expect(decodeCursor(valid, 'admin.approvals', filters)).toEqual({ at: '2026-10-09T08:00:00.123456Z', id: uuid(1) });
    expect(valid).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  const reencode = (fields: Record<string, unknown>) =>
    Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(valid, 'base64url').toString('utf8')), ...fields }), 'utf8')
      .toString('base64url');

  it.each([
    ['a flipped character', `${valid.slice(0, 10)}${valid[10] === 'A' ? 'B' : 'A'}${valid.slice(11)}`],
    ['a truncated value', valid.slice(0, -4)],
    ['padding', `${valid}=`],
    ['non-base64url characters', `${valid.slice(0, -1)}+`],
    ['an oversized value', 'A'.repeat(513)],
    ['plain JSON', '{"v":1}'],
    ['another version', reencode({ v: 2 })],
    ['another list', reencode({ l: 'admin.demo-requests' })],
    ['another filter binding', reencode({ f: 'AAAAAAAAAAAAAAAAAAAAAA' })],
    ['an impossible date', reencode({ t: '2026-02-30T08:00:00.000000Z' })],
    ['year zero, which Postgres does not have', reencode({ t: '0000-01-01T00:00:00.000000Z' })],
    ['millisecond precision', reencode({ t: '2026-10-09T08:00:00.123Z' })],
    ['an upper-case id', reencode({ i: uuid(1).toUpperCase() })],
    ['an injected id', reencode({ i: `${uuid(1)}' or 1=1 --` })],
    ['an extra field', reencode({ x: 1 })],
  ])('refuses %s with 400 ADMIN_INVALID_CURSOR', async (_label, cursor) => {
    const problem = await refusal(() => decodeCursor(cursor, 'admin.approvals', filters));
    expect([problem.getStatus(), problem.code]).toEqual([400, 'ADMIN_INVALID_CURSOR']);
  });

  it('refuses a cursor issued for other filters', async () => {
    const problem = await refusal(() => decodeCursor(valid, 'admin.approvals', { status: 'approved' }));
    expect(problem.code).toBe('ADMIN_INVALID_CURSOR');
  });
});

describe('GET /admin/approvals pages with a cursor', () => {
  const approval = (n: number) => ({ id: uuid(n), action: 'mfa.reset', roleCode: null, targetAccountId: uuid(90),
    targetEmail: null, targetDisplayName: null, reason: 'Lost authenticator', status: 'pending', requestedBy: uuid(91),
    requestedAt: new Date(at(n)), expiresAt: new Date(), decidedBy: null, decidedAt: null, decisionReason: null,
    executedAt: null, version: '1', cursorAt: at(n) });
  const service = (rows: Record<string, unknown>[]) => {
    const fake = database(() => rows);
    return { ...fake, service: new PlatformSecurityService(fake.database, audit(), {} as TokenService) };
  };

  it('returns one page and an opaque cursor for the next, newest first', async () => {
    const { service: security, query } = service([approval(3), approval(2), approval(1)]);
    const page = await security.listApprovals(context, { status: 'pending', limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual([uuid(3), uuid(2)]);
    expect(page.items[0]).not.toHaveProperty('cursorAt');
    expect(page.nextCursor).toEqual(expect.any(String));
    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('order by request.requested_at desc, request.id');
    expect(sql).not.toMatch(/limit 200/);
    expect(parameters).toEqual(['pending', null, null, 3]);

    const next = service([approval(1)]);
    const second = await next.service.listApprovals(context, { status: 'pending', limit: 2, cursor: page.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual([uuid(1)]);
    expect(second.nextCursor).toBeNull();
    expect((next.query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual(['pending', at(2), uuid(2), 3]);
  });

  it('refuses a tampered cursor or one from another filter before reading anything', async () => {
    const first = service([approval(3), approval(2), approval(1)]);
    const { nextCursor } = await first.service.listApprovals(context, { status: 'pending', limit: 2 });
    const other = service([]);
    expect((await refusal(other.service.listApprovals(context, { status: 'approved', limit: 2, cursor: nextCursor! })))
      .code).toBe('ADMIN_INVALID_CURSOR');
    expect((await refusal(other.service.listApprovals(context, { limit: 2, cursor: `${nextCursor}x` }))).code)
      .toBe('ADMIN_INVALID_CURSOR');
    expect(other.query).not.toHaveBeenCalled();
  });

  it('keeps the permission check ahead of the cursor', async () => {
    const { service: security, query } = service([]);
    const limited = { ...context, actor: platformActor({ platformPermissions: ['platform.admin.access'] }) };
    expect((await refusal(security.listApprovals(limited, { cursor: 'not-a-cursor' }))).code).toBe('PERMISSION_DENIED');
    expect(query).not.toHaveBeenCalled();
  });

  it('bounds the page size between 1 and 100, defaulting to 50', async () => {
    const parse = async (query: Record<string, unknown>) => {
      const dto = plainToInstance(ListApprovalsDto, query);
      return { dto, errors: await validate(dto) };
    };
    expect((await parse({})).dto.limit).toBe(50);
    expect((await parse({ limit: '100' })).errors).toHaveLength(0);
    expect((await parse({ limit: '101' })).errors).not.toHaveLength(0);
    expect((await parse({ limit: '0' })).errors).not.toHaveLength(0);
    expect((await parse({ cursor: 'x'.repeat(513) })).errors).not.toHaveLength(0);
  });
});

describe('GET /admin/demo-requests pages with a cursor', () => {
  const demo = (n: number) => ({ id: uuid(n), contactName: 'Ada', contactEmail: 'ada@example.invalid', contactPhone: null,
    contactRole: null, organizationName: null, organizationType: null, productCode: 'ehr', message: null, sourcePage: null,
    sourceSection: null, ctaLabel: null, status: 'new', version: '1', createdAt: new Date(at(n)),
    updatedAt: new Date(at(n)), cursorAt: at(n) });

  it('pages newest first beyond the former 100-row cap and binds the cursor to the filters', async () => {
    const first = database(() => [demo(5), demo(4), demo(3)]);
    const service = new DemoRequestsService(first.database, audit());
    const page = await service.list(context, { status: 'new', productCode: 'ehr', limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual([uuid(5), uuid(4)]);
    expect(page.items[0]).not.toHaveProperty('cursorAt');
    const [sql, parameters] = first.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('order by created_at desc, id desc');
    expect(parameters).toEqual(['new', 'ehr', null, null, 3]);

    const second = database(() => [demo(3)]);
    const next = await new DemoRequestsService(second.database, audit())
      .list(context, { status: 'new', productCode: 'ehr', limit: 2, cursor: page.nextCursor! });
    expect(next.nextCursor).toBeNull();
    expect((second.query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual(['new', 'ehr', at(4), uuid(4), 3]);

    const other = database(() => []);
    expect((await refusal(new DemoRequestsService(other.database, audit())
      .list(context, { status: 'closed', productCode: 'ehr', limit: 2, cursor: page.nextCursor! }))).code)
      .toBe('ADMIN_INVALID_CURSOR');
    expect(other.query).not.toHaveBeenCalled();
  });
});

describe('GET /admin/audit/events target filter', () => {
  it('passes the resource type and id to the database reader', async () => {
    const fake = database(() => []);
    await new AdminService(fake.database, audit()).listAudit(context,
      Object.assign(new ListPlatformAuditDto(), { resourceType: 'facility', resourceId: uuid(7) }));
    const [sql, parameters] = fake.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('audit.list_platform_events($1, $2::bigint, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11)');
    expect(parameters.slice(9)).toEqual(['facility', uuid(7)]);
  });

  it.each([
    [{ resourceType: 'facility', resourceId: uuid(7) }, true],
    [{ resourceType: 'authentication-account' }, true],
    [{ resourceType: 'platform-control', resourceId: 'outreach_portal_enabled' }, true],
    [{ resourceId: uuid(7) }, false],
    [{ resourceType: 'Facility' }, false],
    [{ resourceType: 'facility account' }, false],
    [{ resourceType: 'a'.repeat(81) }, false],
    [{ resourceType: 'facility', resourceId: '' }, false],
    [{ resourceType: 'facility', resourceId: '../etc' }, false],
    [{ resourceType: 'facility', resourceId: 'a b' }, false],
    [{ resourceType: 'facility', resourceId: 'a'.repeat(256) }, false],
    [{ resourceType: null }, false],
  ])('validates %j', async (query, valid) => {
    const errors = await validate(plainToInstance(ListPlatformAuditDto, query));
    expect(errors.length === 0).toBe(valid);
  });
});

describe('GET /admin/principals MFA enrolment', () => {
  it('returns a boolean for an active authenticator and no factor detail', async () => {
    const principal = (n: number, enrolled: boolean) => ({ id: uuid(n), subject: `synthetic:${n}`, email: null,
      displayName: null, status: 'active', version: '1', createdAt: new Date(), activeSessionCount: '0',
      memberships: [], platformRoles: [], mfaEnrolled: enrolled });
    const total = (sql: string) => sql.trimStart().startsWith('select count(*)::text');
    const fake = database((sql) => total(sql) ? [{ count: '2' }] : [principal(1, true), principal(2, false)]);
    const page = await new AdminService(fake.database, audit()).listPrincipals(context,
      { query: 'synthetic', page: 1, pageSize: 25 } as never);
    expect(page.items.map((item) => item.mfaEnrolled)).toEqual([true, false]);
    const listSql = String(fake.query.mock.calls.find(([sql]) => !total(String(sql)))?.[0]);
    expect(listSql).toMatch(/from auth\.mfa_factors factor where factor\.account_id = account\.id\s+and factor\.status = 'active'/);
    expect(listSql).not.toMatch(/secret_ciphertext|last_used_step|recovery/);
  });
});

describe('Identity CORS policy', () => {
  it('lets an allowed cross-origin console read every principal export header', () => {
    const exposed = corsOptions('https://admin.example.invalid').exposedHeaders as string[];
    for (const header of Object.values(EXPORT_RESPONSE_HEADERS)) expect(exposed).toContain(header.toLowerCase());
    expect(exposed).toEqual(expect.arrayContaining(['etag', 'location', 'x-correlation-id', 'x-csrf-token']));
    expect(exposed).toEqual([...CORS_EXPOSED_HEADERS]);
  });

  it('still allows only the configured origins and methods', () => {
    const options = corsOptions('https://admin.example.invalid, https://www.example.invalid');
    const origin = options.origin as (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => void;
    const decide = (value: string | undefined) => new Promise((resolve) => origin(value, (error, allow) => resolve(error ? 'denied' : allow)));
    return Promise.all([decide('https://admin.example.invalid'), decide('https://www.example.invalid'),
      decide('https://evil.example.invalid'), decide(undefined)]).then((answers) => {
      expect(answers).toEqual([true, true, 'denied', true]);
      // Stage 5: PATCH and DELETE for the organization profile completion and access PIN routes.
      expect(options.methods).toEqual(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);
      expect(options.credentials).toBe(true);
    });
  });
});
