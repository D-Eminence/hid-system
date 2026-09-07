import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { AdminApiError } from './api';
import type { AdminActor, AdminSession, Facility, Principal } from './types';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: apiMock, commandKey: (prefix: string) => `${prefix}:test-command-0001` };
});

const permissions = [
  'platform.admin.access', 'platform.facility.read', 'platform.facility.manage',
  'platform.principal.read', 'platform.principal.manage', 'platform.session.revoke',
  'platform.role.manage', 'platform.identity-review.read', 'platform.audit.read',
  'platform.operations.read',
];
const actor = (grants = permissions): AdminActor => ({
  accountId: '20000000-0000-4000-8000-000000000001', subject: 'staff:platform-admin',
  displayName: 'Platform Admin', email: 'admin@example.test',
  platformRoles: ['platform_super_admin'], platformPermissions: grants,
});
const session = (grants = permissions): AdminSession => ({ actor: actor(grants) });
const facility: Facility = {
  id: '10000000-0000-4000-8000-000000000002', organizationId: '10000000-0000-4000-8000-000000000001',
  organizationName: 'HID Test Health', name: 'HID Test Clinic', code: 'HID-TEST', status: 'verified',
  version: 4, statusReason: 'Verified onboarding evidence', statusChangedAt: '2026-08-10T12:00:00Z',
  createdAt: '2026-08-01T12:00:00Z', membershipCount: 7,
};

function mount(path = '/') {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

beforeEach(() => {
  expect(document.body).toBeEmptyDOMElement();
});

afterEach(() => {
  apiMock.mockReset();
  vi.restoreAllMocks();
});

describe('governed Admin application', () => {
  it('shows Identity sign-in for an unauthenticated route', async () => {
    apiMock.mockRejectedValue(new AdminApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in is required.'));
    mount('/facilities');
    expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
    expect(screen.queryByText('HID Test Clinic')).not.toBeInTheDocument();
  });

  it('denies an authenticated principal without platform membership', async () => {
    apiMock.mockResolvedValue(session([]));
    mount();
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
  });

  it('renders truthful overview data and permission-filtered navigation', async () => {
    apiMock.mockImplementation(async (path: string) => path === '/admin/session'
      ? session(['platform.admin.access', 'platform.audit.read'])
      : { facilities: 12, pendingIdentityReviews: 3 });
    mount();
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Audit center' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Facilities' })).not.toBeInTheDocument();
    expect(screen.getByText('Super Admin ≠ clinical authority')).toBeInTheDocument();
  });

  it('lists facilities, opens bounded detail, and preserves versioned command evidence', async () => {
    apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/admin/session') return session();
      if (path.includes(`/admin/facilities/${facility.id}`) && options?.method !== 'POST') return facility;
      if (path.endsWith('/status')) return { facilityId: facility.id, status: 'suspended', version: 5 };
      if (path.startsWith('/admin/facilities?')) return { items: [facility], page: 1, pageSize: 50, total: 1 };
      throw new Error(`Unexpected path ${path}`);
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Governed test suspension');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount('/facilities');
    const facilityLink = await screen.findByRole('link', { name: facility.name });
    fireEvent.click(facilityLink);
    expect(await screen.findByText(facility.statusReason!)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /back to facilities/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(`/admin/facilities/${facility.id}/status`,
      expect.objectContaining({ method: 'POST', version: 4,
        idempotencyKey: 'facility-status:test-command-0001',
        body: { status: 'suspended', reason: 'Governed test suspension' } })));
  });

  it('requires destructive confirmation and safely reports a concurrent mutation conflict', async () => {
    apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/admin/session') return session();
      if (path.endsWith('/status') && options?.method === 'POST') {
        throw new AdminApiError(409, 'VERSION_CONFLICT', 'The resource changed. Reload and try again.', 'conflict-correlation');
      }
      return { items: [facility], page: 1, pageSize: 50, total: 1 };
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Governed test suspension');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    mount('/facilities');
    const suspend = await screen.findByRole('button', { name: 'Suspend' });
    fireEvent.click(suspend);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls.some(([path]) => String(path).endsWith('/status'))).toBe(false);
    fireEvent.click(suspend);
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('conflict-correlation')));
  });

  it('uses server-side principal search and distinguishes facility from platform membership', async () => {
    const principal: Principal = { id: '20000000-0000-4000-8000-000000000002', subject: 'staff:user',
      email: 'user@example.test', displayName: 'Test User', status: 'active', version: 2,
      createdAt: '2026-08-01T00:00:00Z', activeSessionCount: 1,
      platformRoles: ['support_admin'], memberships: [{ id: 'membership-1', facilityId: facility.id,
        facilityName: facility.name, role: 'receptionist', appRole: 'receptionist', active: true, version: 1 }] };
    apiMock.mockImplementation(async (path: string) => path === '/admin/session' ? session()
      : path.startsWith('/admin/principals?') ? { items: [principal], page: 1, pageSize: 50, total: 1 } : {});
    mount('/users');
    fireEvent.change(await screen.findByLabelText('Principal search'), { target: { value: 'user@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('support_admin')).toBeInTheDocument();
    expect(screen.getByText(`${facility.name} · receptionist`)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(expect.stringMatching(/^\/admin\/principals\?query=user%40example\.test/));
  });

  it('paginates immutable audit evidence through the server cursor', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/admin/session') return session();
      return path.includes('beforeSequenceId=90')
        ? { items: [], nextBeforeSequenceId: null }
        : { items: [{ sequenceId: '100', eventId: 'event-1', occurredAt: '2026-08-10T00:00:00Z',
          correlationId: 'audit-correlation', actorType: 'staff', actorSubject: 'staff:admin', facilityId: facility.id,
          action: 'admin.facility.suspended', outcome: 'success', resourceType: 'facility', resourceId: facility.id,
          purposeOfUse: 'healthcare-operations', reason: 'Governed suspension', sourceSystem: 'identity-api' }],
          nextBeforeSequenceId: '90' };
    });
    mount('/audit');
    fireEvent.click(await screen.findByRole('button', { name: 'Older events' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('beforeSequenceId=90')));
  });

  it('represents partial service failure without hiding ready services', async () => {
    apiMock.mockImplementation(async (path: string) => path === '/admin/session' ? session() : ({
      checkedAt: '2026-08-10T00:00:00Z', services: [
        { service: 'Identity', live: true, ready: true, state: 'ready', checkedAt: '2026-08-10T00:00:00Z', code: null },
        { service: 'Lab', live: null, ready: false, state: 'unavailable', checkedAt: '2026-08-10T00:00:00Z', code: 'STATUS_TIMEOUT' },
      ],
    }));
    mount('/operations');
    expect(await screen.findByText('Identity')).toBeInTheDocument();
    expect(screen.getByText('Lab')).toBeInTheDocument();
    expect(screen.getByText('STATUS_TIMEOUT')).toBeInTheDocument();
  });

  it('shows PHI-minimal event metrics and terminal failure evidence without payloads', async () => {
    apiMock.mockImplementation(async (path: string) => path === '/admin/session' ? session() : ({
      state: 'available', code: null, metrics: { pending: 2, terminalFailures: 1 },
      failures: [{ eventId: 'event-safe-1', eventType: 'PatientRegistered', producer: 'identity', attemptCount: 8,
        errorCode: 'DELIVERY_TIMEOUT', errorSummary: 'Bounded provider timeout', failedAt: '2026-08-10T00:00:00Z',
        nextAttemptAt: '2026-08-10T00:00:00Z', correlationId: 'event-correlation' }],
    }));
    mount('/events');
    expect(await screen.findByText('event-safe-1')).toBeInTheDocument();
    expect(screen.getByText('DELIVERY_TIMEOUT: Bounded provider timeout')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('payload');
  });

  it('returns to Identity sign-in when an established session expires', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/admin/session') return session();
      window.dispatchEvent(new CustomEvent('hid:admin-session-expired'));
      throw new AdminApiError(401, 'SESSION_EXPIRED', 'Sign in is required.');
    });
    mount('/operations');
    expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
  });
});
