import type { ActorContext, HidRequest } from '../common/request-context';
import { requireAdminContext } from './admin-context';

const facility = {
  id: '10000000-0000-4000-8000-000000000001',
  membershipId: '20000000-0000-4000-8000-000000000001',
  organizationId: '30000000-0000-4000-8000-000000000001',
  name: 'Test Facility', roles: ['facility_admin'], permissions: [], isPrimary: true,
};

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    id: 'staff:platform-admin', subject: 'staff:platform-admin',
    accountId: '40000000-0000-4000-8000-000000000001',
    authenticationMethod: 'local', roles: [], permissions: [],
    platformRoles: ['platform_super_admin'], platformPermissions: ['platform.admin.access'],
    facilityIds: [], facilities: [],
    ...overrides,
  };
}

function request(subject?: ActorContext): HidRequest {
  return {
    correlationId: 'platform-admin-context-test-0001', actor: subject,
    header: (name: string) => name === 'authorization' ? 'Bearer signed-access-token' : undefined,
  } as unknown as HidRequest;
}

describe('requireAdminContext', () => {
  it('builds a platform administration context without inventing a facility membership', () => {
    const context = requireAdminContext(request(actor()));
    expect(context).toMatchObject({
      actor: expect.objectContaining({ accountId: '40000000-0000-4000-8000-000000000001' }),
      correlationId: 'platform-admin-context-test-0001',
      purposeOfUse: 'healthcare-operations',
    });
    expect(context.facilityId).toBeUndefined();
    expect(context.membershipId).toBeUndefined();
  });

  it('keeps a resolved facility membership when the administrator has one', () => {
    const context = requireAdminContext(request(actor({
      facility, facilityIds: [facility.id], facilities: [facility],
    })));
    expect(context.facilityId).toBe(facility.id);
    expect(context.membershipId).toBe(facility.membershipId);
  });

  it('rejects a normal staff account that has no active facility membership', () => {
    expect(() => requireAdminContext(request(actor({
      platformRoles: [], platformPermissions: [],
    })))).toThrow('Valid administrator authentication is required');
  });
});
