import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { ConsentService } from './consent.service';

const context: DataAccessContext = {
  correlationId: 'consent-service-test-correlation',
  facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '20000000-0000-4000-8000-000000000001',
  purposeOfUse: 'direct-care',
  actor: {
    id: '30000000-0000-4000-8000-000000000001',
    subject: 'staff:test',
    accountId: '30000000-0000-4000-8000-000000000001',
    roles: ['doctor'],
    permissions: ['identity.consent.write'],
    facilityIds: ['10000000-0000-4000-8000-000000000001'],
    facilities: [],
    authenticationMethod: 'local',
  },
};

describe('ConsentService', () => {
  const query = jest.fn();
  const client = { query } as unknown as PoolClient;
  const withTransaction = jest.fn(
    async (_context: DataAccessContext, operation: (transactionClient: PoolClient) => Promise<unknown>) =>
      operation(client),
  );
  const database = { withTransaction } as unknown as DatabaseService;
  const service = new ConsentService(database);

  beforeEach(() => {
    query.mockReset();
    withTransaction.mockClear();
  });

  it('returns the governed access-request result without patient demographics', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        accessRequestId: '40000000-0000-4000-8000-000000000001',
        patientId: '50000000-0000-4000-8000-000000000001',
        status: 'pending',
        scope: 'read_records',
        purpose: 'direct-care',
        durationMinutes: 60,
        requestedAt: new Date('2026-08-06T00:00:00.000Z'),
        existingRequest: false,
      }],
    });

    const result = await service.createAccessRequest(context, {
      hid: 'HID-ABCDEFGH',
      scope: 'read_records',
      reason: 'Direct treatment request',
      durationMinutes: 60,
    });

    expect(result).toMatchObject({
      status: 'pending',
      scope: 'read_records',
      existingRequest: false,
    });
    expect(result).not.toHaveProperty('firstName');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.create_access_request'),
      ['HID-ABCDEFGH', 'read_records', 'Direct treatment request', 60],
    );
  });

  it('maps unavailable exact-HID targets to a safe not-found problem', async () => {
    query.mockRejectedValueOnce({ code: 'P0002' });

    await expect(service.createAccessRequest(context, {
      hid: 'HID-ABCDEFGH',
      scope: 'read_records',
      reason: 'Direct treatment request',
      durationMinutes: 60,
    })).rejects.toMatchObject<Partial<DomainProblem>>({
      code: 'CONSENT_RESOURCE_NOT_FOUND',
    });
  });

  it('maps invalid state transitions to a conflict without leaking database details', async () => {
    query.mockRejectedValueOnce({ code: '55000', detail: 'sensitive database detail' });

    await expect(service.closeOwnGrant(
      context,
      '60000000-0000-4000-8000-000000000001',
      'Treatment relationship ended',
    )).rejects.toMatchObject<Partial<DomainProblem>>({
      code: 'CONSENT_COMMAND_CONFLICT',
    });
  });
});
