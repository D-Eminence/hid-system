import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { REQUIRED_PERMISSIONS } from '../common/decorators';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { ListRegistrationCasesDto } from './dto/list-registration-cases.dto';
import type { HidCodeGenerator } from './hid-code-generator.service';
import { NinRegistrationController } from './nin-registration.controller';
import { NinRegistrationService } from './nin-registration.service';
import type { NinIdentifierProtector } from './nin-identifier-protector';
import type { NinVerificationProvider } from './nin.types';

const facilityId = '10000000-0000-4000-8000-000000000001';
const caseIds = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
];
const context = {
  correlationId: 'case-list-test', facilityId,
  membershipId: '30000000-0000-4000-8000-000000000001',
  purposeOfUse: 'direct-care',
  actor: {
    subject: 'staff:case-reviewer', accountId: '40000000-0000-4000-8000-000000000001',
    facility: { organizationId: '50000000-0000-4000-8000-000000000001' },
  },
} as DataAccessContext;

function fixture() {
  const client = { query: jest.fn() } as unknown as PoolClient;
  const database = {
    withTransaction: jest.fn(async (_context, operation) => operation(client)),
  } as unknown as DatabaseService;
  const audit = { recordWithClient: jest.fn(async () => undefined) } as unknown as AuditService;
  const service = new NinRegistrationService(database, audit,
    {} as NinIdentifierProtector, {} as HidCodeGenerator, {} as NinVerificationProvider);
  return { client, database, audit, service };
}

describe('registration case continuity', () => {
  it('lists only the selected facility under the registration permission, with a bounded cursor and account state', async () => {
    const { client, database, audit, service } = fixture();
    const rows = caseIds.map((id, index) => ({
      id, status: 'approved_new_identity', row_version: '2',
      resolved_patient_id: '60000000-0000-4000-8000-000000000001',
      resolved_hid_code: 'HID-TEST', candidate_count: '0',
      account_enrollment_started: index === 0,
    }));
    jest.spyOn(client, 'query').mockResolvedValue({ rows } as never);
    const input = plainToInstance(ListRegistrationCasesDto,
      { status: 'approved_new_identity', limit: '2', beforeCaseId: caseIds[2] });

    const result = await service.listCases(input, context);

    expect(result.items).toHaveLength(2);
    expect(result.nextBeforeCaseId).toBe(caseIds[1]);
    expect(result.items[0]).toEqual({
      caseId: caseIds[0], status: 'approved_new_identity', version: 2,
      candidateCount: 0, accountEnrollmentStarted: true,
      patient: { patientId: rows[0]?.resolved_patient_id, hid: 'HID-TEST' },
    });
    const [sql, parameters] = jest.mocked(client.query).mock.calls[0] ?? [];
    expect(String(sql)).toContain('registration.facility_id = platform.current_facility_id()');
    expect(String(sql)).toContain('previous.facility_id = platform.current_facility_id()');
    expect(parameters).toEqual(['approved_new_identity', caseIds[2], 3]);
    expect(database.withTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    expect(audit.recordWithClient).toHaveBeenCalledWith(client,
      expect.objectContaining({ action: 'identity.registration-cases.list',
        facilityId, outcome: 'success' }));
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS,
      NinRegistrationController.prototype.listCases)).toEqual(['identity.registration.write']);
  });

  it('does not disclose a case when it is absent from the authorized facility', async () => {
    const { client, audit, service } = fixture();
    jest.spyOn(client, 'query').mockResolvedValue({ rows: [] } as never);
    await expect(service.getCase(caseIds[0]!, context)).rejects.toMatchObject({
      code: 'REGISTRATION_CASE_NOT_FOUND',
    });
    expect(String(jest.mocked(client.query).mock.calls[0]?.[0]))
      .toContain('registration.facility_id = platform.current_facility_id()');
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('rejects unbounded, malformed or unknown list filters', async () => {
    const invalid = plainToInstance(ListRegistrationCasesDto,
      { status: 'all', limit: '1000', beforeCaseId: 'not-a-uuid' });
    expect((await validate(invalid)).map((error) => error.property).sort())
      .toEqual(['beforeCaseId', 'limit', 'status']);
  });
});
