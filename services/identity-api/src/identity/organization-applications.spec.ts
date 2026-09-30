import { PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import * as environment from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { TurnstileService } from '../auth/turnstile.service';
import type { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import { AdminOrganizationApplicationsController, PublicOrganizationApplicationsController } from './organization-applications.controller';
import type { SubmitOrganizationApplicationDto } from './dto/organization-application.dto';
import { OrganizationApplicationsService } from './organization-applications.service';

const applicationId = 'c4600000-0000-4000-8000-000000000002';
const input: SubmitOrganizationApplicationDto = {
  productCode: 'migrate', organizationName: 'Example Clinic', organizationType: 'clinic', cacRegistrationNumber: 'RC1234567',
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

  it('passes CAC only from restricted database intake to QoreID and stores a normalized result', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ application_id: applicationId, product_code: 'migrate',
        cac_registration_number: 'RC1234567', application_status: 'pending_verification', row_version: '1' }] })
      .mockResolvedValueOnce({ rows: [{ application_status: 'ready_for_review', row_version: '2' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn().mockResolvedValue({ state: 'verified', providerReference: 'qoreid-123' }) };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: true } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter);
    const result = await service.verify(context, applicationId, 1);
    expect(qoreid.verifyCac).toHaveBeenCalledWith('RC1234567');
    expect(result).toEqual({ status: 'ready_for_review', version: 2, state: 'verified',
      providerReference: 'qoreid-123' });
    expect(JSON.stringify(result)).not.toContain('RC1234567');
    expect(query.mock.calls[1]?.[1]).toEqual([applicationId, 1, 'verified', 'qoreid-123', null]);
  });

  it('records disabled verification and refuses approval without paired existing organization IDs', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ application_id: applicationId, product_code: 'migrate',
        cac_registration_number: 'RC1234567', application_status: 'pending_verification', row_version: '1' }] })
      .mockResolvedValueOnce({ rows: [{ application_status: 'pending_verification', row_version: '2' }] });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const qoreid = { verifyCac: jest.fn() };
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ QOREID_ENABLED: false } as environment.Environment);
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      qoreid as unknown as QoreIdVerificationAdapter);
    await expect(service.verify(context, applicationId, 1)).rejects.toMatchObject({ code: 'QOREID_DISABLED' });
    expect(qoreid.verifyCac).not.toHaveBeenCalled();
    expect(query.mock.calls[1]?.[1]).toEqual([applicationId, 1, 'disabled', null, 'disabled']);
    await expect(service.approve(context, applicationId, 2, {
      reason: 'Synthetic approval', existingOrganizationId: 'c4610000-0000-4000-8000-000000000001',
    })).rejects.toMatchObject({ code: 'ORGANIZATION_LINK_INVALID' });
    expect(database.withTransaction).toHaveBeenCalledTimes(2);
  });

  it('maps an optimistic concurrency conflict without returning SQL details', async () => {
    const database = { withTransaction: jest.fn().mockRejectedValue({ code: '40001',
      message: 'sensitive SQL diagnostics' }) };
    const service = new OrganizationApplicationsService(database as unknown as DatabaseService,
      {} as QoreIdVerificationAdapter);
    const failure = await service.reject(context, applicationId, 1, 'Synthetic rejection').catch((error) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect(failure.code).toBe('VERSION_CONFLICT');
    expect(failure.message).not.toContain('sensitive');
  });
});
