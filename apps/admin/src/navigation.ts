import type { AdminActor } from './types';

export const navigation = [
  { path: '/', label: 'Overview', permission: 'platform.admin.access', section: 'Overview' },
  { path: '/facilities', label: 'Facilities', permission: 'platform.facility.read', section: 'Management' },
  { path: '/users', label: 'Users & memberships', permission: 'platform.principal.read', section: 'Management' },
  { path: '/identity', label: 'Identity review', permission: 'platform.identity-review.read', section: 'Management' },
  { path: '/provider-applications', label: 'Provider applications', permission: 'platform.identity-review.read', section: 'Management' },
  { path: '/audit', label: 'Audit center', permission: 'platform.audit.read', section: 'Security' },
  { path: '/operations', label: 'Services', permission: 'platform.operations.read', section: 'Operations' },
  { path: '/events', label: 'Event delivery', permission: 'platform.operations.read', section: 'Operations' },
  { path: '/integrations', label: 'Integrations', permission: 'platform.integration.read', section: 'Settings' },
  { path: '/controls', label: 'Platform controls', permission: 'platform.control.read', section: 'Settings' },
  { path: '/preserved-settings', label: 'Preserved settings', permission: 'platform.admin.access', section: 'Settings' },
] as const;

export function visibleNavigation(actor: AdminActor) {
  const permissions = new Set(actor.platformPermissions);
  return navigation.filter((item) => permissions.has(item.permission) && (item.path !== '/preserved-settings'
    || ['platform.pricing.read','platform.control.read','platform.role.manage','platform.integration.read'].some(code => permissions.has(code))));
}

export function accessState(actor: AdminActor | null): 'unauthenticated' | 'unauthorized' | 'authorized' {
  if (!actor) return 'unauthenticated';
  return actor.platformPermissions.includes('platform.admin.access') ? 'authorized' : 'unauthorized';
}
