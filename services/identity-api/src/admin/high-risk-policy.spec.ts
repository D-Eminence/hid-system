jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PlatformAuthController } from '../auth/platform-auth.controller';
import { AdminDemoRequestsController } from '../commercial/demo-requests.controller';
import { HIGH_RISK_ACTION, PLATFORM_SCOPE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { AdminOrganizationApplicationsController } from '../identity/organization-applications.controller';
import { IntegrationAdminController } from '../integrations/integration-admin.controller';
import { AdminController } from './admin.controller';
import { PLATFORM_ACTION_POLICIES, platformActionPolicy, requiresTwoPersonApproval, type PlatformAction } from './high-risk-policy';
import { PlatformSecurityController } from './platform-security.controller';
import { WorkforceAdminController } from './workforce-admin.controller';

interface PlatformRoute { controller: string; handler: string; method: RequestMethod; path: string;
  action?: string; permissions: readonly string[] }

const controllers = [AdminController, PlatformSecurityController, IntegrationAdminController,
  AdminOrganizationApplicationsController, AdminDemoRequestsController, PlatformAuthController,
  WorkforceAdminController];

function platformRoutes(): PlatformRoute[] {
  const routes: PlatformRoute[] = [];
  for (const controller of controllers) {
    const classPlatform = Reflect.getMetadata(PLATFORM_SCOPE, controller) === true;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      if (!classPlatform && Reflect.getMetadata(PLATFORM_SCOPE, handler) !== true) continue;
      routes.push({ controller: controller.name, handler: name, method,
        path: `${Reflect.getMetadata(PATH_METADATA, controller)}/${Reflect.getMetadata(PATH_METADATA, handler)}`,
        action: Reflect.getMetadata(HIGH_RISK_ACTION, handler) as string | undefined,
        permissions: (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as string[] | undefined) ?? [] });
    }
  }
  return routes;
}

describe('central high-risk platform policy', () => {
  const routes = platformRoutes();
  const mutations = routes.filter((route) => route.method !== RequestMethod.GET);

  it('finds the platform administration surface', () => {
    expect(mutations.length).toBeGreaterThanOrEqual(25);
  });

  it('gives every platform mutation exactly one registered action', () => {
    const missing = mutations.filter((route) => !route.action || !platformActionPolicy(route.action))
      .map((route) => `${route.controller}.${route.handler}`);
    expect(missing).toEqual([]);
  });

  it('keeps each route permission check aligned with its policy', () => {
    const drift = routes.filter((route) => route.action).flatMap((route) => {
      const policy = platformActionPolicy(route.action!)!;
      return policy.permissions.filter((permission) => !route.permissions.includes(permission)
        && permission !== 'platform.admin.access').map((permission) => `${route.handler}:${permission}`);
    });
    expect(drift).toEqual([]);
  });

  it('uses every registered action on some route', () => {
    const used = new Set(routes.map((route) => route.action).filter(Boolean));
    expect(Object.keys(PLATFORM_ACTION_POLICIES).filter((action) => !used.has(action))).toEqual([]);
  });

  it('protects the principal export with the restricted permission and step-up', () => {
    const exportRoute = routes.find((route) => route.path === 'admin/principals/export');
    expect(exportRoute).toMatchObject({ method: RequestMethod.GET, action: 'platform.principals.export',
      permissions: ['platform.principal.export'] });
  });

  it.each([
    ['platform.role.change', 'critical'], ['platform.role.super-admin.request', 'critical'],
    ['platform.approval.decide', 'critical'], ['platform.account.status', 'critical'],
    ['platform.sessions.revoke-all', 'critical'], ['platform.session.revoke-other', 'critical'],
    ['platform.mfa.reset.request', 'critical'], ['platform.control.change', 'critical'],
    ['platform.integration.enable', 'critical'], ['platform.integration.pause', 'critical'],
    ['platform.integration.selection', 'critical'], ['platform.integration.fallback', 'critical'],
    ['platform.integration.credential-reference', 'critical'], ['platform.principals.export', 'critical'],
    ['platform.workforce.attach', 'critical'], ['platform.workforce.attest', 'critical'],
    ['platform.workforce.role.change', 'critical'], ['platform.workforce.membership.end', 'critical'],
    ['platform.facility.status', 'high'], ['platform.pricing.product', 'high'], ['platform.pricing.price', 'high'],
    ['platform.integration.configure', 'high'], ['platform.integration.test', 'high'],
    ['platform.organization-application.verify-cac', 'high'], ['platform.organization-application.approve', 'high'],
    ['platform.organization-application.reject', 'high'], ['platform.mfa.recovery-codes.regenerate', 'high'],
    ['platform.demo-request.status', 'standard'], ['platform.mfa.step-up', 'standard'],
    ['platform.session.revoke-own', 'standard'], ['platform.session.logout', 'standard'],
  ] as [PlatformAction, string][])('classifies %s as %s', (action, tier) => {
    const policy = PLATFORM_ACTION_POLICIES[action];
    expect(policy.tier).toBe(tier);
    // Critical and high actions always need a recent TOTP step-up.
    expect(policy.stepUp).toBe(tier !== 'standard');
    if (tier === 'critical') expect(policy.reason).toBe(true);
  });

  it('guards every workforce command with the workforce permission, a reason, a version and a key (D14)', () => {
    const workforce = routes.filter((route) => route.path.startsWith('admin/workforce/'));
    expect(workforce.map((route) => `${route.method === RequestMethod.GET ? 'GET' : 'POST'} ${route.path}`).sort())
      .toEqual(['GET admin/workforce/accounts/:accountId', 'POST admin/workforce/accounts/:accountId/attestations',
        'POST admin/workforce/memberships', 'POST admin/workforce/memberships/:membershipId/end',
        'POST admin/workforce/memberships/:membershipId/roles'].sort());
    for (const route of workforce) expect(route.permissions).toEqual(['platform.workforce.manage']);
    for (const action of ['platform.workforce.attach', 'platform.workforce.attest', 'platform.workforce.role.change',
      'platform.workforce.membership.end'] as const) {
      const policy = PLATFORM_ACTION_POLICIES[action];
      expect(policy).toMatchObject({ permissions: ['platform.workforce.manage'], stepUp: true, reason: true,
        idempotencyKey: true });
      expect(policy.ifMatch).toBe(action !== 'platform.workforce.attach');
    }
    // A role grant is one step for the granter; its second person is the
    // attestation reviewer, which the SQL command enforces.
    expect(PLATFORM_ACTION_POLICIES['platform.workforce.role.change'].approval).toBe('independent-attestation');
    expect(requiresTwoPersonApproval('platform.workforce.role.change')).toBe(false);
  });

  it('requires two-person approval for Super Admin grants and MFA resets only', () => {
    expect(requiresTwoPersonApproval('platform.role.change', { roleCode: 'platform_super_admin', action: 'grant' })).toBe(true);
    expect(requiresTwoPersonApproval('platform.role.change', { roleCode: 'platform_super_admin', action: 'revoke' })).toBe(false);
    expect(requiresTwoPersonApproval('platform.role.change', { roleCode: 'support_admin', action: 'grant' })).toBe(false);
    expect(requiresTwoPersonApproval('platform.role.super-admin.request')).toBe(true);
    expect(requiresTwoPersonApproval('platform.mfa.reset.request')).toBe(true);
    expect(requiresTwoPersonApproval('platform.account.status')).toBe(false);
  });
});
