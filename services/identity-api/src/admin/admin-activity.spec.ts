jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest, PlatformAdminContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { EmergencyContactProtector } from '../patient-safety/emergency-contact-protector';
import { AdminController } from './admin.controller';
import { AdminOperationsService } from './admin-operations.service';
import { AdminService } from './admin.service';
import type { PricingService } from './pricing.service';

const actor = {
  id: 'staff:super', subject: 'staff:super', accountId: '20000000-0000-4000-8000-000000000001',
  roles: [], permissions: [], platformRoles: ['platform_super_admin'],
  platformPermissions: ['platform.admin.access', 'platform.dashboard.read'],
  facilityIds: [], facilities: [], authenticationMethod: 'local',
};
const request = { correlationId: 'admin-activity-test', actor, header: () => undefined } as unknown as HidRequest;
const context = { correlationId: 'admin-activity-test', actor, purposeOfUse: 'healthcare-operations' } as unknown as PlatformAdminContext;

/** What 0123's identity.admin_platform_activity returns (already shortened by the database). */
const activity = {
  days: 7, generatedAt: '2026-11-11T09:00:00.000Z',
  people: { accounts: 3, verifiedPct: 50, profilesCompletePct: null, activeInPeriod: 1, sharedWithFacility: 0,
    accessPins: 0, newInPeriod: 2, prevNewInPeriod: 1 },
  care: { healthRecords: 0, visits: 1, labRequests: 0, prescriptions: 0, emergencyAccess: 0, outreachSignups: 0 },
  migrateAsk: { pagesRead: 0, recordsMoved: 0, questionsAnswered: 0, answersWithSourcesPct: null },
  daily: [{ date: '2026-11-11', signups: 2, activeAccounts: 1 }],
  recentSignups: [{ name: 'Ada O.', email: 'a***@gmail.com', healthId: 'HID-7K…M9', profilePct: 100,
    status: 'verified', createdAt: '2026-11-11T08:00:00.000Z' }],
  recentUploads: [],
};

function serviceHarness(result: Promise<unknown>) {
  const client = { query: jest.fn().mockReturnValue(result) };
  const database = { withPlatformTransaction: jest.fn(async (_context, operation) => operation(client as unknown as PoolClient)) };
  const audit = { recordWithClient: jest.fn() };
  const service = new AdminService(database as unknown as DatabaseService, audit as unknown as AuditService,
    {} as EmergencyContactProtector);
  return { service, client, database, audit };
}

function controller() {
  const admin = { activity: jest.fn().mockResolvedValue(activity) };
  const operations = { health: jest.fn(() => { throw new DomainProblem(503, 'not_configured', 'x'); }),
    errors: jest.fn(() => { throw new DomainProblem(503, 'not_configured', 'x'); }) };
  return { admin, operations, routes: new AdminController(admin as unknown as AdminService,
    operations as unknown as AdminOperationsService, {} as PricingService) };
}

describe('Admin dashboard activity (0123)', () => {
  it('calls the database read with the days, in a writable transaction (the read audits itself)', async () => {
    const { service, client, database, audit } = serviceHarness(Promise.resolve({ rows: [{ activity }] }));
    await expect(service.activity(context, 7)).resolves.toEqual(activity);
    expect(client.query).toHaveBeenCalledWith('select identity.admin_platform_activity($1) as activity', [7]);
    expect(database.withPlatformTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    expect(database.withPlatformTransaction.mock.calls[0]).toHaveLength(2);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it.each([
    ['ADMIN_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['ADMIN_INVALID_DAYS', 400, 'ADMIN_COMMAND_INVALID'],
    ['connection reset', 503, 'ADMIN_COMMAND_UNAVAILABLE'],
  ])('maps the database refusal %s to %i', async (message, status, code) => {
    const { service } = serviceHarness(Promise.reject(Object.assign(new Error(message), { code: '42501' })));
    await expect(service.activity(context, 30)).rejects.toMatchObject({ status, code });
  });

  it('refuses an empty answer as unavailable', async () => {
    const { service } = serviceHarness(Promise.resolve({ rows: [{ activity: null }] }));
    await expect(service.activity(context, 90)).rejects.toMatchObject({ status: 503, code: 'ADMIN_DATA_UNAVAILABLE' });
  });

  it.each([['7', 7], ['30', 30], ['90', 90], [undefined, 30]])('accepts days=%s', async (days, expected) => {
    const { admin, routes } = controller();
    await expect(routes.activity(days, request)).resolves.toEqual(activity);
    expect(admin.activity).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'admin-activity-test' }), expected);
  });

  it.each(['14', '0', '-7', '7.0', ' 7', 'abc', '', '0007', ['7', '30']])('refuses days=%j with 400', (days) => {
    const { admin, routes } = controller();
    expect(() => routes.activity(days, request)).toThrow(expect.objectContaining({ status: 400, code: 'ADMIN_INVALID_DAYS' }));
    expect(admin.activity).not.toHaveBeenCalled();
  });

  it('needs platform administration authority before the service is reached', () => {
    const { admin, routes } = controller();
    const noAdmin = { ...request, actor: { ...actor, platformPermissions: ['platform.dashboard.read'] } } as unknown as HidRequest;
    expect(() => routes.activity('7', noAdmin)).toThrow(expect.objectContaining({ status: 403 }));
    expect(admin.activity).not.toHaveBeenCalled();
  });

  it.each([
    ['activity', 'admin.overview.activity.read.request'],
    ['operationsHealth', 'admin.operations.health.request'],
    ['operationsErrors', 'admin.operations.errors.request'],
  ] as const)('%s requires platform.dashboard.read (the super admin only) and is audited', (method, action) => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, AdminController.prototype[method])).toEqual(['platform.dashboard.read']);
    expect(Reflect.getMetadata(AUDIT_ACTION, AdminController.prototype[method])).toBe(action);
  });
});

describe('Admin dashboard System health and Errors (not set up yet)', () => {
  const base = {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    CORS_ORIGINS: 'http://localhost:3000', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
  };
  const arn = 'arn:aws:secretsmanager:eu-west-2:123456789012:secret:hid/sentry-read-AbCdEf';
  beforeEach(() => { Object.assign(process.env, base); delete process.env.SENTRY_READ_TOKEN_SECRET_ARN; resetEnvironmentForTests(); });
  afterEach(() => { delete process.env.SENTRY_READ_TOKEN_SECRET_ARN; resetEnvironmentForTests(); });

  it('answers 503 not_configured for system health', () => {
    expect(() => new AdminOperationsService().health()).toThrow(expect.objectContaining({ status: 503, code: 'not_configured' }));
  });

  it('answers 503 not_configured for errors without the Sentry secret ARN', () => {
    expect(() => new AdminOperationsService().errors()).toThrow(expect.objectContaining({ status: 503, code: 'not_configured' }));
  });

  it('still answers 503 not_configured with the ARN, and never echoes it', () => {
    process.env.SENTRY_READ_TOKEN_SECRET_ARN = arn;
    resetEnvironmentForTests();
    let thrown: unknown;
    try { new AdminOperationsService().errors(); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ status: 503, code: 'not_configured' });
    expect(JSON.stringify((thrown as DomainProblem).getResponse())).not.toContain('secretsmanager');
  });

  it('refuses a value that is not a Secrets Manager ARN', () => {
    process.env.SENTRY_READ_TOKEN_SECRET_ARN = 'plain-text-not-an-arn';
    resetEnvironmentForTests();
    expect(() => new AdminOperationsService()).toThrow();
  });

  it('routes the two cards through the operations service', () => {
    const { operations, routes } = controller();
    expect(() => routes.operationsHealth(request)).toThrow(expect.objectContaining({ status: 503, code: 'not_configured' }));
    expect(() => routes.operationsErrors(request)).toThrow(expect.objectContaining({ status: 503, code: 'not_configured' }));
    expect(operations.health).toHaveBeenCalledTimes(1);
    expect(operations.errors).toHaveBeenCalledTimes(1);
  });
});
