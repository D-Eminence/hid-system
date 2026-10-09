/**
 * Central policy for platform administration actions (Phase 4 Stage 2A).
 *
 * Every state-changing platform route declares exactly one action from this
 * registry with @HighRiskAction(). The SecurityGuard refuses a platform
 * mutation that declares none, and checks the declared controls before the
 * handler runs. Each service command repeats the session and step-up check in
 * its own transaction (requirePlatformAssurance), so calling a service
 * directly cannot skip it. SQL commands keep their own permission, version,
 * reason and idempotency checks.
 *
 * Every platform route already requires an MFA-verified platform session; the
 * tiers add:
 *
 * | Tier     | Step-up (TOTP, last 5 min) | Reason | If-Match / Idempotency-Key | Two-person approval |
 * |----------|----------------------------|--------|----------------------------|---------------------|
 * | critical | required                   | required | where the command is versioned / replayable | where marked |
 * | high     | required                   | where the command takes one | same | none |
 * | standard | not required               | where the command takes one | same | none |
 */
export type PlatformRiskTier = 'critical' | 'high' | 'standard';

export interface PlatformActionPolicy {
  readonly tier: PlatformRiskTier;
  /** Platform permissions the route requires (mirrors @RequirePermissions). */
  readonly permissions: readonly string[];
  readonly stepUp: boolean;
  /** A body `reason` (query `reason` for GET) of 8 to 500 characters. */
  readonly reason: boolean;
  readonly ifMatch: boolean;
  readonly idempotencyKey: boolean;
  /** Two-person approval: the one-step command is refused for this case. */
  readonly approval: 'none' | 'two-person' | 'two-person-for-super-admin-grant';
}

const critical = { tier: 'critical', stepUp: true, reason: true } as const;
const high = { tier: 'high', stepUp: true } as const;
const standard = { tier: 'standard', stepUp: false } as const;

export const PLATFORM_ACTION_POLICIES = {
  // Roles, accounts, sessions and MFA administration.
  'platform.role.change': { ...critical, permissions: ['platform.role.manage'], ifMatch: true,
    idempotencyKey: true, approval: 'two-person-for-super-admin-grant' },
  'platform.role.super-admin.request': { ...critical, permissions: ['platform.role.manage'], ifMatch: false,
    idempotencyKey: true, approval: 'two-person' },
  'platform.mfa.reset.request': { ...critical, permissions: ['platform.mfa.reset'], ifMatch: false,
    idempotencyKey: true, approval: 'two-person' },
  'platform.approval.decide': { ...critical, permissions: ['platform.admin.access'], ifMatch: true,
    idempotencyKey: true, approval: 'none' },
  'platform.account.status': { ...critical, permissions: ['platform.principal.manage'], ifMatch: true,
    idempotencyKey: true, approval: 'none' },
  'platform.sessions.revoke-all': { ...critical, permissions: ['platform.session.revoke'], ifMatch: false,
    idempotencyKey: true, approval: 'none' },
  'platform.session.revoke-other': { ...critical, permissions: ['platform.session.revoke'], ifMatch: false,
    idempotencyKey: true, approval: 'none' },
  // Platform controls are the kill switches (maintenance, portals).
  'platform.control.change': { ...critical, permissions: ['platform.control.manage'], ifMatch: true,
    idempotencyKey: false, approval: 'none' },
  // Integrations: switching providers or routes on or off is critical;
  // configuration and connectivity tests are high.
  'platform.integration.enable': { ...critical, permissions: ['platform.integration.manage'], ifMatch: true,
    idempotencyKey: true, approval: 'none' },
  'platform.integration.pause': { ...critical, permissions: ['platform.integration.manage'], ifMatch: true,
    idempotencyKey: true, approval: 'none' },
  'platform.integration.selection': { ...critical, permissions: ['platform.integration.manage'], ifMatch: true,
    idempotencyKey: true, approval: 'none' },
  'platform.integration.fallback': { ...critical, permissions: ['platform.integration.manage'], ifMatch: true,
    idempotencyKey: true, approval: 'none' },
  'platform.integration.credential-reference': { ...critical, permissions: ['platform.integration.manage'],
    ifMatch: true, idempotencyKey: true, approval: 'none' },
  'platform.integration.configure': { ...high, permissions: ['platform.integration.manage'], reason: true,
    ifMatch: true, idempotencyKey: true, approval: 'none' },
  'platform.integration.test': { ...high, permissions: ['platform.integration.test'], reason: true,
    ifMatch: true, idempotencyKey: true, approval: 'none' },
  // Exports leave the platform's control once downloaded.
  'platform.principals.export': { ...critical, permissions: ['platform.principal.export'], ifMatch: false,
    idempotencyKey: false, approval: 'none' },
  // Facility, provider onboarding and pricing.
  'platform.facility.status': { ...high, permissions: ['platform.facility.manage'], reason: true, ifMatch: true,
    idempotencyKey: true, approval: 'none' },
  'platform.organization-application.verify-cac': { ...high, permissions: ['platform.facility.manage'],
    reason: false, ifMatch: true, idempotencyKey: false, approval: 'none' },
  'platform.organization-application.approve': { ...high,
    permissions: ['platform.facility.manage', 'platform.principal.manage', 'platform.role.manage'],
    reason: true, ifMatch: true, idempotencyKey: false, approval: 'none' },
  'platform.organization-application.reject': { ...high, permissions: ['platform.facility.manage'],
    reason: true, ifMatch: true, idempotencyKey: false, approval: 'none' },
  'platform.pricing.product': { ...high, permissions: ['platform.pricing.manage'], reason: true, ifMatch: true,
    idempotencyKey: true, approval: 'none' },
  'platform.pricing.price': { ...high, permissions: ['platform.pricing.manage'], reason: true, ifMatch: true,
    idempotencyKey: true, approval: 'none' },
  // Own MFA and own sessions.
  'platform.mfa.recovery-codes.regenerate': { ...high, permissions: ['platform.admin.access'], reason: false,
    ifMatch: false, idempotencyKey: false, approval: 'none' },
  'platform.mfa.step-up': { ...standard, permissions: ['platform.admin.access'], reason: false, ifMatch: false,
    idempotencyKey: false, approval: 'none' },
  'platform.session.revoke-own': { ...standard, permissions: ['platform.admin.access'], reason: false,
    ifMatch: false, idempotencyKey: false, approval: 'none' },
  'platform.session.logout': { ...standard, permissions: [], reason: false, ifMatch: false,
    idempotencyKey: false, approval: 'none' },
  // Low-impact sales workflow.
  'platform.demo-request.status': { ...standard, permissions: ['platform.demo.manage'], reason: true,
    ifMatch: true, idempotencyKey: false, approval: 'none' },
} as const satisfies Record<string, PlatformActionPolicy>;

export type PlatformAction = keyof typeof PLATFORM_ACTION_POLICIES;

export function platformActionPolicy(action: string): PlatformActionPolicy | undefined {
  return Object.prototype.hasOwnProperty.call(PLATFORM_ACTION_POLICIES, action)
    ? PLATFORM_ACTION_POLICIES[action as PlatformAction]
    : undefined;
}

/** Granting platform_super_admin is never a one-step command. */
export function requiresTwoPersonApproval(action: PlatformAction,
  input: { roleCode?: string; action?: string } = {}): boolean {
  const policy: PlatformActionPolicy = PLATFORM_ACTION_POLICIES[action];
  if (policy.approval === 'two-person') return true;
  return policy.approval === 'two-person-for-super-admin-grant'
    && input.roleCode === 'platform_super_admin' && input.action === 'grant';
}
