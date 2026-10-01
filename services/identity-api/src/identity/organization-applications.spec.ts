import { PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import * as environment from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import type { TurnstileService } from '../auth/turnstile.service';
import type { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import { AdminOrganizationApplicationsController, PublicOrganizationApplicationsController } from './organization-applications.controller';
import type { SubmitOrganizationApplicationDto } from './dto/organization-application.dto';
import { OrganizationApplicationsService, verifiedCacBinding } from './organization-applications.service';

const applicationId = 'c4600000-0000-4000-8000-000000000002';
const input: SubmitOrganizationApplicationDto = {
  productCode: 'migrate', organizationType: 'clinic', cacRegistrationNumber: 'RC1234567',
  administratorName: 'Ada Admin', administratorEmail: 'ada@example.invalid',
  turnstileAction: 'organization-application', turnstileToken: 'opaque-proof',
};
const request = {
  correlationId: 'organization-application-test', ip: '203.0.113.1',
  header: (key: string) => key === 'origin' ? 'https://www.healthidentitydirectory.com' : undefined,
} as unknown as HidRequest;
const context = { correlationId: request.correlationId } as DataAccessContext;

describe('organization onboarding boundary', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requires an allowed origin and Turnstile before public intake, and returns no identifier', async () => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com',
    } as environment.Environment);
    const submit = jest.fn().mockResolvedValue({ accepted: true });
    const verify = jest.fn().mockResolvedValue(undefined);
    const controller = new PublicOrganizationApplicationsController(
      { submit } as unknown as OrganizationApplicationsService,
      { verify } as unknown as TurnstileService);
    await expect(controller.submit(input, request)).resolves.toEqual({ accepted: true });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ action: 'organization-application' }));
    expect(submit).toHaveBeenCalledTimes(1);
    await expect(controller.submit(input, { ...request, header: () => 'https://untrusted.invalid' } as unknown as HidRequest))
      .rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(Reflect.getMetadata(PUBLIC_ROUTE, PublicOrganizationApplicationsController.prototype.submit)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, AdminOrganizationApplicationsController.prototype.approve))
      .toEqual(['platform.facility.manage', 'platform.principal.manage', 'platform.role.manage']);
  });

  it('uses only a keyed network digest for the public intake quota before storing an application', async () => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NODE_ENV: 'test',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64') } as environment.Environment);
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const database = { withSystemTransaction: jest.fn(async (_correlation, work) => work({ query })) };
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      {} as QoreIdVerificationAdapter, {} as IntegrationRuntimeService);
    await expect(service.submit(input, request)).resolves.toEqual({ accepted: true });
    expect(query.mock.calls[0]?.[0]).toContain('consume_public_application_quota');
    expect(query.mock.calls[0]?.[1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(JSON.stringify(query.mock.calls[0])).not.toContain(request.ip);
    expect(JSON.stringify(query.mock.calls[0])).not.toContain(input.cacRegistrationNumber);
    expect(query.mock.calls[1]?.[0]).toContain('submit_organization_application');
    expect(query.mock.calls[1]?.[1]).toEqual(['migrate', 'clinic', 'RC1234567',
      'Ada Admin', 'ada@example.invalid']);
  });

  it('returns 429 before public application persistence when a network bucket is exhausted', async () => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NODE_ENV: 'test',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64') } as environment.Environment);
    const query = jest.fn().mockRejectedValue({ code: 'P4290', message: 'internal quota detail' });
    const database = { withSystemTransaction: jest.fn(async (_correlation, work) => work({ query })) };
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      {} as QoreIdVerificationAdapter, {} as IntegrationRuntimeService);
    await expect(service.submit(input, request)).rejects.toMatchObject({
      status: 429, code: 'APPLICATION_RATE_LIMITED',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('binds a normalized CAC Basic V2 result to restricted CAC intake', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ application_id: applicationId, product_code: 'migrate',
        cac_registration_number: 'RC1234567', application_status: 'pending_verification', row_version: '1' }] })
      .mockResolvedValueOnce({ rows: [{ application_status: 'ready_for_review', row_version: '2' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn().mockResolvedValue({ state: 'verified', providerReference: 'qoreid-123',
      cacBinding: { registrationNumber: 'RC1234567', providerRegistrationNumber: '1234567',
        companyName: 'Verified Legal Clinic Limited',
        entityType: 'Private Company Limited by Shares', registrationDate: '2014-05-26',
        address: '10 Test Avenue, Lagos', registryStatus: 'Active' } }) };
    const integrations = { assertAvailable: jest.fn().mockResolvedValue(undefined),
      consumeQuota: jest.fn().mockResolvedValue(undefined) };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: true } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter,
      integrations as unknown as IntegrationRuntimeService);
    const result = await service.verify(context, applicationId, 1);
    expect(qoreid.verifyCac).toHaveBeenCalledWith('RC1234567');
    expect(integrations.assertAvailable).toHaveBeenCalledWith('qoreid', 'provider_cac');
    expect(integrations.consumeQuota).toHaveBeenCalledWith(context, 'application_cac', applicationId);
    expect(result).toEqual({ status: 'ready_for_review', version: 2, state: 'verified',
      providerReference: 'qoreid-123' });
    expect(JSON.stringify(result)).not.toContain('RC1234567');
    expect(query.mock.calls[1]?.[1]).toEqual([applicationId, 1, 'verified', 'qoreid-123', null,
      'RC1234567', 'Verified Legal Clinic Limited', 'Private Company Limited by Shares',
      '2014-05-26', '10 Test Avenue, Lagos', 'active']);
  });

  it('keeps an application unchanged when verification is disabled and refuses an incomplete approval link', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ application_id: applicationId, product_code: 'migrate',
        cac_registration_number: 'RC1234567', application_status: 'pending_verification', row_version: '1' }] })
      .mockResolvedValueOnce({ rows: [{ application_status: 'pending_verification', row_version: '2' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn() };
    const integrations = { assertAvailable: jest.fn(), consumeQuota: jest.fn() };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: false } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter,
      integrations as unknown as IntegrationRuntimeService);
    await expect(service.verify(context, applicationId, 1)).rejects.toMatchObject({ code: 'QOREID_DISABLED' });
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(integrations.assertAvailable).not.toHaveBeenCalled();
    expect(integrations.consumeQuota).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('admin_record_organization_cac_result'))).toBe(false);
    await expect(service.approve(context, applicationId, 1, {
      reason: 'Synthetic approval', existingOrganizationId: 'c4610000-0000-4000-8000-000000000001',
    })).rejects.toMatchObject({ code: 'ORGANIZATION_LINK_INVALID' });
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
  });

  it('maps an optimistic concurrency conflict without returning SQL details', async () => {
    const database = { withTransaction: jest.fn().mockRejectedValue({ code: '40001',
      message: 'sensitive SQL diagnostics' }) };
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      {} as QoreIdVerificationAdapter, {} as IntegrationRuntimeService);
    const failure = await service.reject(context, applicationId, 1, 'Synthetic rejection').catch((error) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect(failure.code).toBe('VERSION_CONFLICT');
    expect(failure.message).not.toContain('sensitive');
  });

  it('refuses a status-only or mismatched CAC result and records a denied review state', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ application_id: applicationId, product_code: 'ehr',
        cac_registration_number: 'RC1234567', application_status: 'pending_verification', row_version: '1' }] })
      .mockResolvedValueOnce({ rows: [{ application_status: 'pending_verification', row_version: '2' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn().mockResolvedValue({ state: 'verified', providerReference: '123',
      cacBinding: { registrationNumber: 'RC9999999', providerRegistrationNumber: '9999999',
        companyName: 'Other Company',
        entityType: 'Private Company Limited by Shares', registrationDate: '2014-05-26',
        address: '10 Test Avenue, Lagos', registryStatus: 'Active' } }) };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: true } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter,
      { assertAvailable: jest.fn(), consumeQuota: jest.fn() } as unknown as IntegrationRuntimeService);
    await expect(service.verify(context, applicationId, 1)).rejects.toMatchObject({ code: 'CAC_IDENTITY_MISMATCH' });
    expect(query.mock.calls[1]?.[1]).toEqual([applicationId, 1, 'not_verified', '123', 'not_verified',
      null, null, null, null, null, null]);
  });

  it.each(['pending_verification', 'ready_for_review'])
  ('blocks %s CAC provider calls when the integration is paused', async (status) => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ application_id: applicationId, product_code: 'ehr',
        cac_registration_number: 'RC1234567', application_status: status, row_version: '1' }] })
      .mockResolvedValueOnce({ rows: [{ application_status: 'pending_verification', row_version: '2' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn() };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: true } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter,
      { assertAvailable: jest.fn().mockRejectedValue(new DomainProblem(503, 'INTEGRATION_PAUSED', 'Verification unavailable')),
        consumeQuota: jest.fn() } as unknown as IntegrationRuntimeService);
    await expect(service.verify(context, applicationId, 1)).rejects.toMatchObject({ code: 'INTEGRATION_PAUSED' });
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('admin_record_organization_cac_result'))).toBe(false);
  });

  it('preserves a review-ready application and verified legal fields when QoreID is disabled', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ application_id: applicationId, product_code: 'ehr',
      cac_registration_number: 'RC1234567', application_status: 'ready_for_review', row_version: '2' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn() };
    const integrations = { assertAvailable: jest.fn(), consumeQuota: jest.fn() };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: false } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter,
      integrations as unknown as IntegrationRuntimeService);
    await expect(service.verify(context, applicationId, 2)).rejects.toMatchObject({ code: 'QOREID_DISABLED' });
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(integrations.assertAvailable).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('admin_record_organization_cac_result'))).toBe(false);
  });

  it('preserves a review-ready application when the normalized provider fails', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ application_id: applicationId, product_code: 'ehr',
      cac_registration_number: 'RC1234567', application_status: 'ready_for_review', row_version: '2' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn().mockRejectedValue(
      new DomainProblem(504, 'QOREID_TIMEOUT', 'External verification timed out')) };
    const integrations = { assertAvailable: jest.fn(), consumeQuota: jest.fn() };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: true } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter,
      integrations as unknown as IntegrationRuntimeService);
    await expect(service.verify(context, applicationId, 2)).rejects.toMatchObject({ code: 'QOREID_TIMEOUT' });
    expect(qoreid.verifyCac).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => sql.includes('admin_record_organization_cac_result'))).toBe(false);
  });

  it('does not record a provider result or change application version when CAC quota is exhausted', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ application_id: applicationId,
      product_code: 'ehr', cac_registration_number: 'RC1234567',
      application_status: 'pending_verification', row_version: '1' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn() };
    const integrations = { assertAvailable: jest.fn(), consumeQuota: jest.fn().mockRejectedValue(
      new DomainProblem(429, 'VERIFICATION_QUOTA_EXCEEDED', 'Verification limit reached')) };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: true } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter,
      integrations as unknown as IntegrationRuntimeService);
    await expect(service.verify(context, applicationId, 1)).rejects.toMatchObject({
      status: 429, code: 'VERIFICATION_QUOTA_EXCEEDED',
    });
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('admin_record_organization_cac_result'))).toBe(false);
  });

  it('preserves a review-ready CAC result when the quota gate is unavailable', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ application_id: applicationId,
      product_code: 'ehr', cac_registration_number: 'RC1234567',
      application_status: 'ready_for_review', row_version: '2' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn() };
    const integrations = { assertAvailable: jest.fn(), consumeQuota: jest.fn().mockRejectedValue(
      new DomainProblem(503, 'VERIFICATION_QUOTA_UNAVAILABLE', 'Quota gate unavailable')) };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: true } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter,
      integrations as unknown as IntegrationRuntimeService);
    await expect(service.verify(context, applicationId, 2)).rejects.toMatchObject({
      status: 503, code: 'VERIFICATION_QUOTA_UNAVAILABLE',
    });
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes('admin_record_organization_cac_result'))).toBe(false);
  });

  it('requires an exact prefixed CAC number, active registry state, and legal name', () => {
    const base = { provider: 'qoreid' as const, state: 'verified' as const,
      providerReference: 'qoreid-123', respondedAt: new Date().toISOString(),
      cacBinding: { registrationNumber: 'RC1234567', providerRegistrationNumber: '1234567',
        companyName: 'Legal Company Ltd',
        entityType: 'Private Company Limited by Shares', registrationDate: '2014-05-26',
        address: '10 Test Avenue, Lagos', registryStatus: 'Active' } };
    expect(verifiedCacBinding('RC1234567', base)).toEqual({ registrationNumber: 'RC1234567',
      companyName: 'Legal Company Ltd', entityType: 'Private Company Limited by Shares',
      registrationDate: '2014-05-26', address: '10 Test Avenue, Lagos', registryStatus: 'active' });
    expect(verifiedCacBinding('RC1234567', { ...base, providerReference: undefined })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: undefined })).toBeNull();
    for (const prefix of ['BN', 'IT']) {
      expect(verifiedCacBinding(`${prefix}1234567`, { ...base,
        cacBinding: { ...base.cacBinding, registrationNumber: `${prefix}1234567` } }))
        .toMatchObject({ registrationNumber: `${prefix}1234567` });
    }
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: {
      ...base.cacBinding, providerRegistrationNumber: 'BN1234567' } })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: {
      ...base.cacBinding, providerRegistrationNumber: '7654321' } })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: { ...base.cacBinding, registrationNumber: '1234567' } })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: { ...base.cacBinding, registrationNumber: 'RC-1234567' } })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: { ...base.cacBinding, registrationNumber: 'rc1234567' } })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: { ...base.cacBinding, registryStatus: 'Inactive' } })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: { ...base.cacBinding, companyName: ' ' } })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: { ...base.cacBinding, entityType: '' } })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: { ...base.cacBinding, registrationDate: '2024-02-30' } })).toBeNull();
    expect(verifiedCacBinding('RC1234567', { ...base, cacBinding: { ...base.cacBinding, address: '' } })).toBeNull();
  });
});
