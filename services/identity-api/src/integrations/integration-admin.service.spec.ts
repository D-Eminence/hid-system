import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { PlatformAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { QoreIdVerificationAdapter } from '../identity/qoreid-verification.adapter';
import { IntegrationAdminService } from './integration-admin.service';
import type { IntegrationRuntimeService } from './integration-runtime.service';

const context: PlatformAccessContext = {
  scope: 'platform', correlationId: 'integration-admin-test', facilityId: null, membershipId: null,
  purposeOfUse: 'healthcare-operations',
  actor: {
    id: 'staff:admin', subject: 'staff:admin',
    accountId: '20000000-0000-4000-8000-000000000001', roles: [], permissions: [],
    platformRoles: ['platform_super_admin'], platformPermissions: ['platform.integration.read',
      'platform.integration.manage', 'platform.integration.test'],
    facilityIds: [], facilities: [], authenticationMethod: 'local',
  },
};

const qoreidRow = {
  provider: 'qoreid', display_name: 'QoreID', enabled: true, runtime_control: true,
  configuration: {}, credential_source: 'aws-secret', last_test_status: null,
  last_tested_at: null, last_successful_test_at: null, last_failed_test_at: null,
  row_version: '3', capabilities: ['patient_nin', 'provider_cac'],
};

function harness(queryResult: (sql: string, values?: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>) {
  const client = { query: jest.fn(queryResult) };
  const database = { withTransaction: jest.fn(async (_context, operation) =>
    operation(client as unknown as PoolClient)) };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const qoreid = { testConnection: jest.fn().mockResolvedValue(undefined) };
  const runtime = { consumeQuota: jest.fn().mockResolvedValue(undefined) };
  const service = new IntegrationAdminService(database as unknown as DatabaseService,
    audit as unknown as AuditService, qoreid as unknown as QoreIdVerificationAdapter,
    runtime as unknown as IntegrationRuntimeService);
  return { service, client, database, audit, qoreid, runtime };
}

function listRows(sql: string): { rows: unknown[] } {
  if (sql.includes('admin_list_integration_providers')) return { rows: [qoreidRow] };
  if (sql.includes('admin_list_integration_routes')) return { rows: [] };
  return { rows: [] };
}

describe('IntegrationAdminService', () => {
  const originalEnv = { NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL,
    CORS_ORIGINS: process.env.CORS_ORIGINS, AUTH_MODE: process.env.AUTH_MODE,
    AUTH_SIGNING_SECRET: process.env.AUTH_SIGNING_SECRET,
    AUTH_LOGIN_PEPPER: process.env.AUTH_LOGIN_PEPPER,
    QOREID_ENABLED: process.env.QOREID_ENABLED, QOREID_CLIENT_ID: process.env.QOREID_CLIENT_ID,
    QOREID_CLIENT_SECRET: process.env.QOREID_CLIENT_SECRET,
    QOREID_NIN_ONLY_ENROLLMENT_ENABLED: process.env.QOREID_NIN_ONLY_ENROLLMENT_ENABLED };

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      CORS_ORIGINS: 'http://localhost:3000', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      QOREID_ENABLED: 'true', QOREID_CLIENT_ID: 'test-client-id',
      QOREID_CLIENT_SECRET: 'test-client-secret',
      QOREID_NIN_ONLY_ENROLLMENT_ENABLED: 'false',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvironmentForTests();
  });

  it('returns capability state and masked credential metadata without exposing deployment secrets', async () => {
    const { service, database } = harness(listRows);
    const result = await service.list(context);
    expect(result.items).toEqual([expect.objectContaining({
      provider: 'qoreid', enabled: true, managementMode: 'runtime', activeCapabilities: ['provider_cac'],
      operationGates: [
        expect.objectContaining({ operation: 'existing_patient_nin', state: 'open' }),
        expect.objectContaining({ operation: 'patient_nin_enrollment', state: 'closed' }),
        expect.objectContaining({ operation: 'provider_cac', state: 'open' }),
      ],
      credential: { state: 'configured', masked: '••••', rotationSupported: false },
      availableActions: expect.arrayContaining(['audit', 'pause', 'test']),
    })]);
    expect(JSON.stringify(result)).not.toMatch(/test-client-secret|deployment-secret/);
    expect(database.withTransaction).toHaveBeenCalledWith(context, expect.any(Function), { readOnly: true });
  });

  it('projects only validated non-secret settings from database rows into the API catalog', async () => {
    const termii = { ...qoreidRow, provider: 'termii', display_name: 'Termii',
      capabilities: ['sms'], configuration: { senderId: 'HID', channel: 'generic',
        apiKey: 'synthetic-secret-never-returned', baseUrl: 'https://example.test' } };
    const { service } = harness((sql) => sql.includes('admin_list_integration_providers')
      ? { rows: [termii] } : { rows: [] });
    const result = await service.list(context);
    expect(result.items[0]?.configuration).toEqual({ senderId: 'HID', channel: 'generic' });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret-never-returned|example\.test/);
  });

  it('shows the NIN-only gate separately from configured CAC Basic V2', async () => {
    process.env.QOREID_NIN_ONLY_ENROLLMENT_ENABLED = 'true';
    resetEnvironmentForTests();
    const { service } = harness(listRows);
    const result = await service.list(context);
    expect(result.items[0]).toMatchObject({
      activeCapabilities: ['patient_nin', 'provider_cac'],
      operationGates: [
        { operation: 'existing_patient_nin', state: 'open' },
        { operation: 'patient_nin_enrollment', state: 'open' },
        { operation: 'provider_cac', state: 'open' },
      ],
    });
  });

  it('distinguishes configured credentials from a closed deployment gate', async () => {
    process.env.QOREID_ENABLED = 'false';
    resetEnvironmentForTests();
    const { service } = harness((sql) => sql.includes('admin_list_integration_providers')
      ? { rows: [{ ...qoreidRow, enabled: false }] } : { rows: [] });
    const result = await service.list(context);
    expect(result.items[0]).toMatchObject({ activeCapabilities: [],
      credential: { state: 'configured' },
      operationGates: [
        { operation: 'existing_patient_nin', state: 'closed' },
        { operation: 'patient_nin_enrollment', state: 'closed' },
        { operation: 'provider_cac', state: 'closed' },
      ] });
    expect(result.items[0]?.availableActions).not.toContain('test');
    expect(result.items[0]?.availableActions).not.toContain('enable');
  });

  it('does not offer a connection test or active QoreID capability while paused', async () => {
    const paused = { ...qoreidRow, enabled: false };
    const { service, qoreid, runtime } = harness((sql) => sql.includes('admin_list_integration_providers')
      ? { rows: [paused] } : { rows: [] });
    const result = await service.list(context);
    expect(result.items[0]).toMatchObject({ activeCapabilities: [],
      operationGates: [
        { operation: 'existing_patient_nin', state: 'closed' },
        { operation: 'patient_nin_enrollment', state: 'closed' },
        { operation: 'provider_cac', state: 'closed' },
      ] });
    expect(result.items[0]?.availableActions).not.toContain('test');
    await expect(service.test(context, 'qoreid', 3, 'Routine connection check', 'qoreid-test-0001'))
      .rejects.toMatchObject({ code: 'INTEGRATION_PAUSED', status: 503 });
    expect(qoreid.testConnection).not.toHaveBeenCalled();
    expect(runtime.consumeQuota).not.toHaveBeenCalled();
  });

  it('maps a database permission denial to a safe forbidden response', async () => {
    const { service } = harness(async () => { throw new Error('ADMIN_PERMISSION_DENIED private role detail'); });
    await expect(service.list(context)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED', status: 403,
    });
  });

  it('records and audits a provider pause once, skipping audit on replay', async () => {
    let replayed = false;
    const { service, audit, client } = harness((sql) => {
      if (sql.includes('admin_set_integration_provider')) return { rows: [{
        provider: 'qoreid', enabled: false, configuration: {}, row_version: '4', replayed,
      }] };
      return listRows(sql);
    });
    await expect(service.changeProvider(context, 'qoreid', 3, 'pause', 'Provider maintenance', undefined,
      'pause-qoreid-0001')).resolves.toEqual({ provider: 'qoreid', enabled: false,
      configuration: {}, version: 4, replayed: false });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('admin_set_integration_provider'),
      expect.arrayContaining(['qoreid', 3, false, 'pause', 'Provider maintenance', 'pause-qoreid-0001']));
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.integration.pause', reason: 'Provider maintenance',
      details: { enabled: false, version: 4 },
    }));
    replayed = true;
    await service.changeProvider(context, 'qoreid', 3, 'pause', 'Provider maintenance', undefined,
      'pause-qoreid-0001');
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
  });

  it('does not enable QoreID while deployment credentials are unavailable', async () => {
    process.env.QOREID_ENABLED = 'false';
    delete process.env.QOREID_CLIENT_SECRET;
    resetEnvironmentForTests();
    const { service, client } = harness(listRows);
    await expect(service.changeProvider(context, 'qoreid', 3, 'enable', 'Resume service', undefined,
      'enable-qoreid-0001')).rejects.toMatchObject({
      code: 'INTEGRATION_CREDENTIAL_UNAVAILABLE', status: 409,
    });
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('admin_set_integration_provider'), expect.anything());
  });

  it('enables a paused QoreID provider only through the governed command', async () => {
    const paused = { ...qoreidRow, enabled: false, row_version: '4' };
    const { service, client, audit } = harness((sql) => {
      if (sql.includes('admin_list_integration_providers')) return { rows: [paused] };
      if (sql.includes('admin_set_integration_provider')) return { rows: [{
        provider: 'qoreid', enabled: true, configuration: {}, row_version: '5', replayed: false,
      }] };
      return { rows: [] };
    });
    await expect(service.changeProvider(context, 'qoreid', 4, 'enable', 'Service restored', undefined,
      'enable-qoreid-0001')).resolves.toEqual({ provider: 'qoreid', enabled: true,
      configuration: {}, version: 5, replayed: false });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('admin_set_integration_provider'),
      expect.arrayContaining(['qoreid', 4, true, 'enable', 'Service restored']));
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.integration.enable', details: { enabled: true, version: 5 },
    }));
  });

  it('serializes and records an OAuth-only connection test after validating the row version', async () => {
    const order: string[] = [];
    const { service, qoreid, audit, client, runtime } = harness((sql) => {
      if (sql.includes('pg_advisory_xact_lock')) { order.push('lock'); return { rows: [{}] }; }
      if (sql.includes('admin_integration_test_replay')) { order.push('replay'); return { rows: [{ response: null }] }; }
      if (sql.includes('admin_list_integration_providers')) { order.push('read'); return { rows: [qoreidRow] }; }
      if (sql.includes('admin_record_integration_test')) { order.push('record'); return { rows: [{
        provider: 'qoreid', last_test_status: 'healthy', row_version: '4', replayed: false,
      }] }; }
      return { rows: [] };
    });
    runtime.consumeQuota.mockImplementation(async () => { order.push('quota'); });
    qoreid.testConnection.mockImplementation(async () => { order.push('probe'); });
    await expect(service.test(context, 'qoreid', 3, 'Routine connection check', 'qoreid-test-0001'))
      .resolves.toEqual({ provider: 'qoreid', status: 'healthy', version: 4, replayed: false });
    expect(order).toEqual(['replay', 'read', 'quota', 'lock', 'replay', 'read', 'probe', 'record']);
    expect(runtime.consumeQuota).toHaveBeenCalledWith(context, 'connection_test', null,
      expect.stringMatching(/^[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('admin_record_integration_test'),
      expect.arrayContaining(['qoreid', 3, 'healthy', 'Routine connection check', 'qoreid-test-0001']));
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.integration.test', details: { status: 'healthy', version: 4 },
    }));
  });

  it('replays a prior connection result without contacting QoreID', async () => {
    const { service, qoreid, audit, client, runtime } = harness((sql) => sql.includes('admin_integration_test_replay')
      ? { rows: [{ response: { provider: 'qoreid', status: 'degraded', version: 5 } }] }
      : { rows: [{}] });
    await expect(service.test(context, 'qoreid', 3, 'Routine connection check', 'qoreid-test-0001'))
      .resolves.toEqual({ provider: 'qoreid', status: 'degraded', version: 5, replayed: true });
    expect(qoreid.testConnection).not.toHaveBeenCalled();
    expect(runtime.consumeQuota).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('admin_record_integration_test'), expect.anything());
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('rejects a stale connection test before making an external request', async () => {
    const { service, qoreid, runtime } = harness((sql) => {
      if (sql.includes('admin_integration_test_replay')) return { rows: [{ response: null }] };
      return listRows(sql);
    });
    await expect(service.test(context, 'qoreid', 2, 'Routine connection check', 'qoreid-test-0001'))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    expect(qoreid.testConnection).not.toHaveBeenCalled();
    expect(runtime.consumeQuota).not.toHaveBeenCalled();
  });

  it('returns 429 before the OAuth probe when the shared quota is exhausted', async () => {
    const { service, qoreid, runtime, audit, client } = harness((sql) => {
      if (sql.includes('admin_integration_test_replay')) return { rows: [{ response: null }] };
      return listRows(sql);
    });
    runtime.consumeQuota.mockRejectedValue(new DomainProblem(429, 'VERIFICATION_QUOTA_EXCEEDED',
      'Verification request limit reached; try again later'));
    await expect(service.test(context, 'qoreid', 3, 'Routine connection check', 'qoreid-test-0001'))
      .rejects.toMatchObject({ code: 'VERIFICATION_QUOTA_EXCEEDED', status: 429 });
    expect(qoreid.testConnection).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('admin_record_integration_test'),
      expect.anything());
  });

  it('checks test permission before making an external request', async () => {
    const { service, qoreid } = harness((sql) => {
      if (sql.includes('admin_integration_test_replay')) {
        throw new Error('ADMIN_PERMISSION_DENIED internal account detail');
      }
      return { rows: [{}] };
    });
    await expect(service.test(context, 'qoreid', 3, 'Routine connection check', 'qoreid-test-0001'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    expect(qoreid.testConnection).not.toHaveBeenCalled();
  });

  it.each([
    ['QOREID_TIMEOUT', 'degraded'],
    ['QOREID_AUTHENTICATION_FAILED', 'failed'],
  ])('records %s as %s without exposing provider error text', async (code, expectedStatus) => {
    const { service, qoreid, client } = harness((sql) => {
      if (sql.includes('admin_integration_test_replay')) return { rows: [{ response: null }] };
      if (sql.includes('admin_record_integration_test')) return { rows: [{
        provider: 'qoreid', last_test_status: expectedStatus, row_version: '4', replayed: false,
      }] };
      return listRows(sql);
    });
    qoreid.testConnection.mockRejectedValue(new DomainProblem(503, code, 'secret provider detail'));
    const result = await service.test(context, 'qoreid', 3, 'Routine connection check', 'qoreid-test-0001');
    expect(result.status).toBe(expectedStatus);
    expect(JSON.stringify(result)).not.toContain('secret provider detail');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('admin_record_integration_test'),
      expect.arrayContaining([expectedStatus]));
  });
});
