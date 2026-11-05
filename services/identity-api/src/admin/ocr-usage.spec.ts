import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { ValidationPipe } from '@nestjs/common';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { ActorContext, HidRequest, PlatformAdminContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { OcrPageLimitCommandDto, OcrUsageQueryDto } from './dto/ocr-usage.dto';
import { AdminOcrUsageController } from './ocr-usage.controller';
import { estimateOcrCostUsd, MODEL_PRICES_USD, TEXTRACT_USD_PER_PAGE } from './ocr-usage.pricing';
import { AdminOcrUsageService, lagosMonth } from './ocr-usage.service';

// Fictional ids only.
const facilityId = '7c3a0000-0000-4000-8000-000000000110';
const actor = (platformRoles: string[]): ActorContext => ({ id: 'platform-account', subject: 'standalone:test-admin',
  accountId: '20000000-0000-4000-8000-000000000110', roles: [], permissions: [], platformRoles,
  platformPermissions: ['platform.admin.access'], facilityIds: [], facilities: [], authenticationMethod: 'local' });
const context = (platformRoles = ['platform_admin']): PlatformAdminContext => ({ actor: actor(platformRoles),
  correlationId: 'ocr-usage-test', purposeOfUse: 'healthcare-operations' });
const NOW = new Date('2026-11-03T09:00:00Z');

const allowance = { pages_used: 120, pages_limit: 500, resets_on: '2026-12-01', paused: false };
const usageRows = [
  { model: 'claude-opus-5-5', requests: '3', input_tokens: '30000', output_tokens: '6000', cache_read_tokens: '0',
    cache_write_tokens: '0', pages: '0' },
  { model: 'claude-sonnet-5-5', requests: '120', input_tokens: '1000000', output_tokens: '200000',
    cache_read_tokens: '2000000', cache_write_tokens: '40000', pages: '0' },
  { model: 'textract', requests: '0', input_tokens: '0', output_tokens: '0', cache_read_tokens: '0',
    cache_write_tokens: '0', pages: '120' },
];

function database(rows: { allowance?: unknown[]; usage?: unknown[] } = {}, failure?: unknown) {
  const query = jest.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (failure) throw failure;
    if (/ocr\.facility_page_allowance/.test(sql)) return { rows: rows.allowance ?? [allowance] };
    if (/ocr\.facility_ocr_usage/.test(sql)) return { rows: rows.usage ?? usageRows };
    return { rows: [] };
  });
  const withPlatformTransaction = jest.fn(async (_context: PlatformAdminContext,
    work: (client: { query: typeof query }) => Promise<unknown>) => work({ query }));
  return { query, withPlatformTransaction,
    service: new AdminOcrUsageService({ withPlatformTransaction } as unknown as DatabaseService) };
}

describe('OCR usage admin routes: guards and audit', () => {
  const meta = (key: unknown, target: object) => Reflect.getMetadata(key, target) as unknown;
  const routes = AdminOcrUsageController.prototype;

  it('follows the admin organization-application guards: facility optional, failures audited, never public', () => {
    expect(meta(FACILITY_OPTIONAL, AdminOcrUsageController)).toBe(true);
    expect(meta(AUDIT_FAILURES_ONLY, AdminOcrUsageController)).toBe(true);
    expect(meta(PUBLIC_ROUTE, AdminOcrUsageController)).toBeUndefined();
    expect(meta(PUBLIC_ROUTE, routes.read)).toBeUndefined();
    expect(meta(REQUIRED_PERMISSIONS, routes.read)).toEqual(['platform.admin.access']);
    expect(meta(REQUIRED_PERMISSIONS, routes.setPageLimit)).toEqual(['platform.admin.access']);
    // A standalone administrator's audit row is a platform row only for admin.* actions.
    expect(meta(AUDIT_ACTION, routes.read)).toBe('admin.ocr.usage.read');
    expect(meta(AUDIT_ACTION, routes.setPageLimit)).toBe('admin.ocr.page-limit.set');
    expect(meta(HTTP_CODE_METADATA, routes.setPageLimit)).toBe(204);
  });

  it('refuses a session without platform administration before the service', () => {
    const service = { usage: jest.fn(), setPageLimit: jest.fn() };
    const controller = new AdminOcrUsageController(service as unknown as AdminOcrUsageService);
    const request = { actor: { ...actor([]), platformPermissions: [] }, correlationId: 'ocr-usage-test',
      header: () => undefined } as unknown as HidRequest;
    expect(() => controller.read(facilityId, {}, request)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(service.usage).not.toHaveBeenCalled();
  });

  it('answers the PUT with no body', async () => {
    const service = { setPageLimit: jest.fn().mockResolvedValue(undefined) };
    const controller = new AdminOcrUsageController(service as unknown as AdminOcrUsageService);
    const request = { actor: actor(['platform_super_admin']), correlationId: 'ocr-usage-test',
      header: () => undefined } as unknown as HidRequest;
    await expect(controller.setPageLimit(facilityId, { pagesLimit: 800, reason: 'Test clinic backlog' }, request))
      .resolves.toBeUndefined();
    expect(service.setPageLimit).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'ocr-usage-test' }),
      facilityId, { pagesLimit: 800, reason: 'Test clinic backlog' });
  });
});

describe('OCR usage admin routes: validation', () => {
  // The global pipe's options (main.ts).
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false });
  const body = (value: unknown) => pipe.transform(value, { type: 'body', metatype: OcrPageLimitCommandDto });
  const query = (value: unknown) => pipe.transform(value, { type: 'query', metatype: OcrUsageQueryDto });

  it('accepts a whole page limit of 1 to 100000 with a trimmed reason of 1 to 240 characters', async () => {
    await expect(body({ pagesLimit: 1, reason: '  Test clinic backlog  ' }))
      .resolves.toEqual({ pagesLimit: 1, reason: 'Test clinic backlog' });
    await expect(body({ pagesLimit: 100_000, reason: 'r'.repeat(240) })).resolves.toMatchObject({ pagesLimit: 100_000 });
  });

  it.each([
    [{ pagesLimit: 0, reason: 'Test' }], [{ pagesLimit: 100_001, reason: 'Test' }], [{ pagesLimit: 12.5, reason: 'Test' }],
    [{ pagesLimit: '800', reason: 'Test' }], [{ pagesLimit: null, reason: 'Test' }], [{ reason: 'Test' }],
    [{ pagesLimit: 800 }], [{ pagesLimit: 800, reason: '' }], [{ pagesLimit: 800, reason: '    ' }],
    [{ pagesLimit: 800, reason: 'r'.repeat(241) }], [{ pagesLimit: 800, reason: 'line\nbreak' }],
    [{ pagesLimit: 800, reason: 7 }], [{ pagesLimit: 800, reason: 'Test', facilityId }],
  ])('refuses the page-limit body %p with a plain message', async (value) => {
    await expect(body(value)).rejects.toMatchObject({ status: 400 });
  });

  it('takes an optional month written as YYYY-MM', async () => {
    await expect(query({})).resolves.toEqual({});
    await expect(query({ month: '2026-11' })).resolves.toEqual({ month: '2026-11' });
    for (const month of ['2026-13', '2026-1', '2026-11-01', 'November', '', '1999-12']) {
      await expect(query({ month })).rejects.toMatchObject({ status: 400 });
    }
  });

  it('states the plain message for an out-of-range limit', async () => {
    const error = await body({ pagesLimit: 0, reason: 'Test' }).catch((caught: { getResponse(): unknown }) => caught);
    expect(JSON.stringify((error as { getResponse(): unknown }).getResponse())).toContain('pagesLimit must be at least 1 page');
  });
});

describe('OCR cost estimate', () => {
  it('uses the documented price table', () => {
    expect(TEXTRACT_USD_PER_PAGE).toBe(0.0015);
    expect(MODEL_PRICES_USD['claude-sonnet-5-5']).toEqual({ inputPerMillion: 2, outputPerMillion: 10,
      cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 });
    expect(MODEL_PRICES_USD['claude-opus-5-5']).toEqual({ inputPerMillion: 4, outputPerMillion: 20,
      cacheReadPerMillion: 0.2, cacheWritePerMillion: 5 });
    expect(estimateOcrCostUsd(1_000, [])).toBe(1.5);
    expect(estimateOcrCostUsd(0, [{ model: 'claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }])).toBe(12.2);
    expect(estimateOcrCostUsd(0, [{ model: 'claude-opus-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }])).toBe(29.2);
  });

  it('gives no estimate when a model is not in the table', () => {
    expect(estimateOcrCostUsd(10, [{ model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
      cacheWriteTokens: 0 }, { model: 'claude-future-9', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
      cacheWriteTokens: 0 }])).toBeNull();
    expect(estimateOcrCostUsd(10, [{ model: 'constructor', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
      cacheWriteTokens: 0 }])).toBeNull();
  });
});

describe('AdminOcrUsageService', () => {
  it('reads the allowance and the month per model in one read-only platform transaction', async () => {
    const { service, query, withPlatformTransaction } = database();
    const answer = await service.usage({ ...context(), facilityId: 'f', membershipId: 'm' }, facilityId, undefined, NOW);
    expect(withPlatformTransaction).toHaveBeenCalledTimes(1);
    const [scoped, , options] = withPlatformTransaction.mock.calls[0] as unknown as [PlatformAdminContext, unknown, unknown];
    // The 0107 reads want a platform-scoped session.
    expect(scoped.facilityId).toBeUndefined();
    expect(scoped.membershipId).toBeUndefined();
    expect(options).toEqual({ readOnly: true });
    expect(query.mock.calls[0]).toEqual([expect.stringMatching(/from ocr\.facility_page_allowance\(\$1\)/), [facilityId]]);
    expect(query.mock.calls[1]).toEqual([expect.stringMatching(/from ocr\.facility_ocr_usage\(\$1, \$2::date\)/),
      [facilityId, '2026-11-01']]);
    expect(answer).toEqual({ month: '2026-11', pagesUsed: 120, pagesLimit: 500, resetsOn: '2026-12-01', paused: false,
      byModel: [
        { model: 'claude-opus-5-5', requests: 3, inputTokens: 30_000, outputTokens: 6_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { model: 'claude-sonnet-5-5', requests: 120, inputTokens: 1_000_000, outputTokens: 200_000,
          cacheReadTokens: 2_000_000, cacheWriteTokens: 40_000 }],
      textractPages: 120,
      // 120 pages x $0.0015 + opus (0.12 + 0.12) + sonnet (2 + 2 + 0.4 + 0.1)
      estimatedCostUsd: 4.92 });
  });

  it('reports an earlier month by the pages counted then, with the current limit', async () => {
    const { service, query } = database({ usage: [{ ...usageRows[2], pages: '480' }] });
    const answer = await service.usage(context(), facilityId, '2026-09', NOW);
    expect(query.mock.calls[1]?.[1]).toEqual([facilityId, '2026-09-01']);
    expect(answer).toMatchObject({ month: '2026-09', pagesUsed: 480, textractPages: 480, byModel: [],
      pagesLimit: 500, estimatedCostUsd: 0.72 });
  });

  it('gives a null estimate for a model with no known price', async () => {
    const { service } = database({ usage: [{ ...usageRows[1], model: 'claude-unpriced-1' }] });
    await expect(service.usage(context(), facilityId, undefined, NOW)).resolves.toMatchObject({
      estimatedCostUsd: null, byModel: [expect.objectContaining({ model: 'claude-unpriced-1' })] });
  });

  it.each([
    [Object.assign(new Error('denied'), { code: '42501' }), 403, 'PERMISSION_DENIED'],
    [Object.assign(new Error('missing'), { code: 'P0002' }), 404, 'FACILITY_NOT_FOUND'],
    [Object.assign(new Error('bad'), { code: '22023' }), 400, 'OCR_USAGE_REQUEST_INVALID'],
    [new Error('connection detail'), 503, 'OCR_USAGE_UNAVAILABLE'],
  ])('maps a database refusal to a plain problem (%#)', async (failure, status, code) => {
    const { service } = database({}, failure);
    await expect(service.usage(context(), facilityId, undefined, NOW)).rejects.toMatchObject({ status, code });
  });

  it('lets only a platform super admin set the limit; a platform admin is refused before the database', async () => {
    for (const roles of [['platform_admin'], ['support_admin'], ['platform_operations_admin'], []]) {
      const { service, withPlatformTransaction } = database();
      const refusal = await service.setPageLimit(context(roles), facilityId, { pagesLimit: 800, reason: 'Test' })
        .catch((caught: unknown) => caught);
      expect(refusal).toMatchObject({ status: 403, code: 'PLATFORM_SUPER_ADMIN_REQUIRED' });
      expect((refusal as Error).message).toBe("Only a platform super admin can change a facility's monthly page limit");
      expect(withPlatformTransaction).not.toHaveBeenCalled();
    }
  });

  it('sets the limit through ocr.set_facility_page_limit in a platform-scoped transaction', async () => {
    const { service, query, withPlatformTransaction } = database();
    await expect(service.setPageLimit({ ...context(['platform_super_admin']), facilityId: 'f' }, facilityId,
      { pagesLimit: 800, reason: 'Test clinic backlog' })).resolves.toBeUndefined();
    expect((withPlatformTransaction.mock.calls[0] as unknown as [PlatformAdminContext])[0].facilityId).toBeUndefined();
    expect(query).toHaveBeenCalledWith('select ocr.set_facility_page_limit($1, $2, $3)',
      [facilityId, 800, 'Test clinic backlog']);
  });

  it('maps the command\'s refusals plainly', async () => {
    for (const [code, status] of [['42501', 403], ['P0002', 404], ['22023', 400]] as const) {
      const { service } = database({}, Object.assign(new Error('detail'), { code }));
      await expect(service.setPageLimit(context(['platform_super_admin']), facilityId, { pagesLimit: 800, reason: 'Test' }))
        .rejects.toMatchObject({ status });
    }
  });
});

describe('lagosMonth', () => {
  it('is the Africa/Lagos calendar month (UTC+1)', () => {
    expect(lagosMonth(new Date('2026-10-31T22:59:59Z'))).toBe('2026-10');
    expect(lagosMonth(new Date('2026-10-31T23:00:00Z'))).toBe('2026-11');
  });
});
