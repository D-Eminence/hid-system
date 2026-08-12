import type { AdminActor } from './types';

export const navigation = [
  { path: '/', label: 'Overview', permission: 'platform.admin.access', section: 'Overview' },
  { path: '/facilities', label: 'Facilities', permission: 'platform.facility.read', section: 'Management' },
  { path: '/users', label: 'Users & memberships', permission: 'platform.principal.read', section: 'Management' },
  { path: '/identity', label: 'Identity review', permission: 'platform.identity-review.read', section: 'Management' },
  { path: '/audit', label: 'Audit center', permission: 'platform.audit.read', section: 'Security' },
  { path: '/operations', label: 'Services', permission: 'platform.operations.read', section: 'Operations' },
  { path: '/events', label: 'Event delivery', permission: 'platform.operations.read', section: 'Operations' },
] as const;

export function visibleNavigation(actor: AdminActor) {
  const permissions = new Set(actor.platformPermissions);
  return navigation.filter((item) => permissions.has(item.permission));
}

export function accessState(actor: AdminActor | null): 'unauthenticated' | 'unauthorized' | 'authorized' {
  if (!actor) return 'unauthenticated';
  return actor.platformPermissions.includes('platform.admin.access') ? 'authorized' : 'unauthorized';
}
