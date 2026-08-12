import { describe, expect, it } from 'vitest';
import { accessState, visibleNavigation } from './navigation';
import type { AdminActor } from './types';

const actor = (permissions: string[]): AdminActor => ({ accountId: crypto.randomUUID(), subject: 'staff:test',
  displayName: 'Test Admin', email: 'admin@example.test', platformRoles: ['security_auditor'],
  platformPermissions: permissions });

describe('admin authorization UX', () => {
  it('classifies a missing session as unauthenticated', () => expect(accessState(null)).toBe('unauthenticated'));
  it('classifies an ordinary authenticated user as unauthorized', () => expect(accessState(actor([]))).toBe('unauthorized'));
  it('allows an explicitly assigned administrator', () => expect(accessState(actor(['platform.admin.access']))).toBe('authorized'));
  it('shows only navigation allowed by platform capabilities', () => {
    const items = visibleNavigation(actor(['platform.admin.access', 'platform.audit.read']));
    expect(items.map((item) => item.label)).toEqual(['Overview', 'Audit center']);
  });
  it('does not infer clinical navigation from Super Admin naming', () => {
    const items = visibleNavigation({ ...actor(['platform.admin.access']), platformRoles: ['platform_super_admin'] });
    expect(items.some((item) => /lab|pharmacy|clinical/i.test(item.label))).toBe(false);
  });
});
