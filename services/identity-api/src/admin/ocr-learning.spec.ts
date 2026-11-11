import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { ValidationPipe } from '@nestjs/common';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { ActorContext, PlatformAdminContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { OcrLearningSwitchCommandDto, OcrQualitySummaryQueryDto } from './dto/ocr-learning.dto';
import { AdminOcrLearningController } from './ocr-learning.controller';
import { AdminOcrLearningService, summaryGroups, summaryRange } from './ocr-learning.service';

// Fictional ids only.
const facilityId = '7c3a0000-0000-4000-8000-000000000119';
const actor = (platformRoles: string[]): ActorContext => ({ id: 'platform-account', subject: 'standalone:test-admin',
  accountId: '20000000-0000-4000-8000-000000000119', roles: [], permissions: [], platformRoles,
  platformPermissions: ['platform.admin.access', 'platform.operations.read'], facilityIds: [], facilities: [],
  authenticationMethod: 'local' });
const context = (platformRoles = ['platform_admin']): PlatformAdminContext => ({ actor: actor(platformRoles),
  facilityId, membershipId: '40000000-0000-4000-8000-000000000119', correlationId: 'ocr-learning-test',
  purposeOfUse: 'healthcare-operations' });
const NOW = new Date('2026-11-11T09:00:00Z');

function database(rows: unknown[] = [], failure?: unknown) {
  const query = jest.fn(async (_sql: string, _values?: readonly unknown[]) => {
    if (failure) throw failure;
    return { rows };
  });
  const withPlatformTransaction = jest.fn(async (_context: PlatformAdminContext,
    work: (client: { query: typeof query }) => Promise<unknown>) => work({ query }));
  return { query, withPlatformTransaction,
    service: new AdminOcrLearningService({ withPlatformTransaction } as unknown as DatabaseService) };
}

describe('OCR learning admin routes', () => {
  const meta = (key: unknown, target: object) => Reflect.getMetadata(key, target) as unknown;
  const routes = AdminOcrLearningController.prototype;

  it('uses the admin guards: facility optional, failures audited, the right permissions, never public', () => {
    expect(meta(FACILITY_OPTIONAL, AdminOcrLearningController)).toBe(true);
    expect(meta(AUDIT_FAILURES_ONLY, AdminOcrLearningController)).toBe(true);
    expect(meta(PUBLIC_ROUTE, AdminOcrLearningController)).toBeUndefined();
    expect(meta(REQUIRED_PERMISSIONS, routes.qualitySummary)).toEqual(['platform.admin.access', 'platform.operations.read']);
    expect(meta(REQUIRED_PERMISSIONS, routes.overview)).toEqual(['platform.admin.access']);
    expect(meta(REQUIRED_PERMISSIONS, routes.setSwitch)).toEqual(['platform.admin.access']);
    expect(meta(AUDIT_ACTION, routes.qualitySummary)).toBe('admin.ocr.quality-summary.read');
    expect(meta(AUDIT_ACTION, routes.setSwitch)).toBe('admin.ocr.learning-switch.set');
    expect(meta(HTTP_CODE_METADATA, routes.setSwitch)).toBe(204);
  });

  it('widens the range to whole ISO weeks and refuses more than 92 days', () => {
    expect(summaryRange('2026-11-04', '2026-11-10', NOW)).toEqual({ from: '2026-11-02', to: '2026-11-15' });
    expect(summaryRange(undefined, undefined, NOW)).toEqual({ from: '2026-10-12', to: '2026-11-15' });
    expect(() => summaryRange('2026-01-01', '2026-12-31', NOW)).toThrow(expect.objectContaining({
      code: 'OCR_QUALITY_RANGE_INVALID' }));
    expect(() => summaryRange('2026-02-30', '2026-03-01', NOW)).toThrow(expect.objectContaining({
      code: 'OCR_QUALITY_RANGE_INVALID' }));
  });

  it('reads the platform summary in a platform session (no facility, no membership) and groups the rows', async () => {
    const { service, query, withPlatformTransaction } = database([
      { group_type: 'item', week: '2026-W45', facility_id: facilityId, kind: 'medicine', prompt_version: 'p13',
        measure: 'kept_unchanged', value: '24' },
      { group_type: 'item', week: '2026-W45', facility_id: facilityId, kind: 'other', prompt_version: 'p13',
        measure: 'suppressed', value: '0' },
      { group_type: 'review', week: '2026-W45', facility_id: facilityId, kind: null, prompt_version: 'p13',
        measure: 'reviews', value: '25' },
    ]);
    const answer = await service.qualitySummary(context(), { from: '2026-11-04', to: '2026-11-10' });
    const [platform] = withPlatformTransaction.mock.calls[0] as unknown as [PlatformAdminContext];
    expect(platform).not.toHaveProperty('facilityId');
    expect(platform).not.toHaveProperty('membershipId');
    expect(query.mock.calls[0]?.[1]).toEqual(['2026-11-02', '2026-11-15']);
    expect(answer).toMatchObject({ scope: 'platform', from: '2026-11-02', to: '2026-11-15', minGroupSize: 20,
      itemGroups: [{ kind: 'medicine', decisions: { kept_unchanged: 24 } }, { kind: 'other', suppressed: true }],
      reviewGroups: [{ counts: { reviews: 25 } }] });
  });

  it('maps database refusals to problems', async () => {
    await expect(database([], { code: '42501' }).service.qualitySummary(context(), {}, NOW))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(database([], { code: '22023' }).service.overview(context()))
      .rejects.toMatchObject({ code: 'OCR_LEARNING_REQUEST_INVALID' });
    await expect(database([], new Error('down')).service.overview(context()))
      .rejects.toMatchObject({ code: 'OCR_LEARNING_UNAVAILABLE' });
  });

  it('gives the overview counts per rule set', async () => {
    const { service } = database([{ scope: 'platform', facility_id: null, enabled: true, active_rules: 2,
      retired_rules: 1, showings_180d: 30, rejected_180d: 4 }]);
    expect(await service.overview(context())).toEqual({ ruleSets: [{ scope: 'platform', facilityId: null, enabled: true,
      activeRules: 2, retiredRules: 1, showingsLast180Days: 30, notTakenLast180Days: 4 }] });
  });

  it('lets only a platform super admin switch a rule set, in a platform session', async () => {
    const refused = database();
    await expect(refused.service.setSwitch(context(['platform_admin']),
      { scope: 'platform', enabled: false, reason: 'Fictional pause' })).rejects.toMatchObject({
      code: 'PLATFORM_SUPER_ADMIN_REQUIRED' });
    expect(refused.withPlatformTransaction).not.toHaveBeenCalled();
    const allowed = database();
    await allowed.service.setSwitch(context(['platform_super_admin']),
      { scope: 'facility', facilityId, enabled: false, reason: 'Fictional pause' });
    expect(allowed.query).toHaveBeenCalledWith('select ocr.set_learning_switch($1, $2, $3, $4)',
      ['facility', facilityId, false, 'Fictional pause']);
    await expect(allowed.service.setSwitch(context(['platform_super_admin']),
      { scope: 'platform', facilityId, enabled: true, reason: 'x' })).rejects.toMatchObject({
      code: 'OCR_LEARNING_SWITCH_INVALID' });
  });

  it('validates the switch body and the summary query', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const body = (value: unknown) => pipe.transform(value, { type: 'body', metatype: OcrLearningSwitchCommandDto });
    await expect(body({ scope: 'platform', enabled: false, reason: ' Fictional pause ' })).resolves.toMatchObject({
      reason: 'Fictional pause' });
    await expect(body({ scope: 'facility', enabled: false, reason: 'x' })).rejects.toBeDefined();
    await expect(body({ scope: 'everywhere', enabled: false, reason: 'x' })).rejects.toBeDefined();
    await expect(body({ scope: 'platform', enabled: 'no', reason: 'x' })).rejects.toBeDefined();
    await expect(body({ scope: 'platform', enabled: true, reason: 'line\nbreak' })).rejects.toBeDefined();
    const query = (value: unknown) => pipe.transform(value, { type: 'query', metatype: OcrQualitySummaryQueryDto });
    await expect(query({ from: '2026-11-01' })).resolves.toBeDefined();
    await expect(query({ from: '1 Nov' })).rejects.toBeDefined();
  });

  it('groups summary rows without carrying anything but codes and counts', () => {
    const groups = summaryGroups([{ group_type: 'review', week: '2026-W45', facility_id: facilityId, kind: null,
      prompt_version: null, measure: 'suppressed', value: 0 }]);
    expect(groups).toEqual({ itemGroups: [], reviewGroups: [{ week: '2026-W45', facilityId, promptVersion: null,
      suppressed: true }] });
  });
});
