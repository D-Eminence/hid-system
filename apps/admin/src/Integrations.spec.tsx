import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Integrations } from './Integrations';
import type { AdminActor, IntegrationCatalog, ProviderIntegration } from './types';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api: apiMock, commandKey: (prefix: string) => `${prefix}:test-command` }));

const actor = (permissions = ['platform.integration.read', 'platform.integration.manage', 'platform.integration.test']): AdminActor => ({
  accountId: '20000000-0000-4000-8000-000000000001', subject: 'staff:admin',
  displayName: 'Admin', email: 'admin@example.test', platformRoles: ['platform_super_admin'],
  platformPermissions: permissions,
});

const provider = (changes: Partial<ProviderIntegration>): ProviderIntegration => ({
  provider: 'termii', name: 'Termii', capabilities: ['sms'], enabled: true,
  managementMode: 'runtime', operationGates: [],
  health: 'unknown', activeCapabilities: ['sms'], version: 3,
  configuration: { channel: 'generic', apiKey: 'must-never-render', baseUrl: 'https://v4.api.termii.com' },
  credential: { state: 'configured', masked: '••••', rotationSupported: false },
  lastTestedAt: null, lastSuccessfulTestAt: null, lastFailedTestAt: null,
  availableActions: ['configure', 'pause', 'audit', 'select', 'fallback'], ...changes,
});

const catalog: IntegrationCatalog = {
  items: [provider({}), provider({ provider: 'brevo', name: 'Brevo', capabilities: ['sms', 'email'],
    activeCapabilities: [], configuration: {}, availableActions: ['enable', 'pause', 'audit', 'select', 'fallback'] }),
  provider({ provider: 'qoreid', name: 'QoreID', capabilities: ['patient_nin', 'provider_cac'],
    activeCapabilities: [], configuration: { timeoutMs: 5000 },
    operationGates: [
      { operation: 'existing_patient_nin', state: 'open', detail: 'General gate and provider enabled.' },
      { operation: 'patient_nin_enrollment', state: 'closed', detail: 'Separate deployment gate required.' },
      { operation: 'provider_cac', state: 'scaffold', detail: 'Entitlement and mapping unconfirmed.' },
    ], availableActions: ['pause', 'test', 'audit'] }),
  provider({ provider: 'turnstile', name: 'Turnstile', capabilities: ['bot-protection'],
    managementMode: 'deployment',
    activeCapabilities: [], configuration: {}, credential: { state: 'external', masked: null, rotationSupported: false },
    availableActions: ['audit'] }),
  provider({ provider: 'fcm', name: 'Firebase Cloud Messaging', capabilities: [],
    managementMode: 'scaffold', enabled: false, activeCapabilities: [], configuration: {},
    credential: { state: 'unsupported', masked: null, rotationSupported: false },
    availableActions: ['audit'] })],
  capabilities: [{ capability: 'sms', activeProvider: 'termii', fallbackProvider: null,
    eligibleProviders: ['termii', 'brevo'], version: 8 }],
};

afterEach(() => { apiMock.mockReset(); vi.restoreAllMocks(); });

describe('admin integration management', () => {
  it('shows approved capability routing, masked credentials, and no secret or endpoint fields', async () => {
    apiMock.mockResolvedValue(catalog);
    render(<Integrations actor={actor()} />);
    expect(await screen.findByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.getAllByText('Configured · ••••').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('must-never-render');
    expect(document.body.textContent).not.toContain('api.termii.com');
    const qoreid = screen.getByRole('heading', { name: 'QoreID' }).closest('article')!;
    expect(within(qoreid).getByText('NIN-only enrollment')).toBeInTheDocument();
    expect(within(qoreid).getByText('CAC verification')).toBeInTheDocument();
    expect(within(qoreid).getByText('Entitlement and mapping unconfirmed.')).toBeInTheDocument();
    expect(within(qoreid).getAllByText('Gate off')).toHaveLength(1);
    expect(within(qoreid).getByText('Unavailable')).toBeInTheDocument();
    const termii = screen.getByRole('heading', { name: 'Termii' }).closest('article')!;
    expect(within(termii).getByRole('button', { name: 'Rotate Credential' })).toBeDisabled();
  });

  it('requires reason and confirmation before pausing an active provider and sends concurrency evidence', async () => {
    apiMock.mockImplementation(async (path: string) => path === '/admin/integrations' ? catalog : {});
    vi.spyOn(window, 'prompt').mockReturnValue('Planned provider pause');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Integrations actor={actor()} />);
    const termii = (await screen.findByRole('heading', { name: 'Termii' })).closest('article')!;
    fireEvent.click(within(termii).getByRole('button', { name: 'Pause' }));
    expect(apiMock.mock.calls.some(([path]) => String(path).endsWith('/pause'))).toBe(false);
    fireEvent.click(within(termii).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/integrations/termii/pause',
      expect.objectContaining({ method: 'POST', version: 3, idempotencyKey: 'integration:test-command',
        body: { reason: 'Planned provider pause' } })));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('restricts read-only users and infrastructure providers to supported actions', async () => {
    apiMock.mockResolvedValue(catalog);
    render(<Integrations actor={actor(['platform.integration.read'])} />);
    const termii = (await screen.findByRole('heading', { name: 'Termii' })).closest('article')!;
    expect(within(termii).getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(within(termii).getByRole('button', { name: 'Test Connection' })).toBeDisabled();
    const turnstile = screen.getByRole('heading', { name: 'Turnstile' }).closest('article')!;
    expect(within(turnstile).getByText('Deployment controlled')).toBeInTheDocument();
    expect(within(turnstile).getByText('Not tracked by dashboard')).toBeInTheDocument();
    expect(within(turnstile).getByRole('button', { name: 'Configure' })).toBeDisabled();
    expect(within(turnstile).getByRole('button', { name: 'Pause' })).toBeDisabled();
    const fcm = screen.getByRole('heading', { name: 'Firebase Cloud Messaging' }).closest('article')!;
    expect(within(fcm).getByText('Scaffold')).toBeInTheDocument();
    expect(within(fcm).getByText('Unavailable scaffold')).toBeInTheDocument();
    expect(within(fcm).getByRole('button', { name: 'Enable' })).toBeDisabled();
  });

  it('shows a paused QoreID provider with its connection test disabled and CAC still unavailable', async () => {
    const paused = provider({ provider: 'qoreid', name: 'QoreID', enabled: false,
      capabilities: ['patient_nin', 'provider_cac'], activeCapabilities: [],
      operationGates: [
        { operation: 'existing_patient_nin', state: 'closed', detail: 'Provider paused.' },
        { operation: 'patient_nin_enrollment', state: 'closed', detail: 'Separate gate is off.' },
        { operation: 'provider_cac', state: 'scaffold', detail: 'Contract unconfirmed.' },
      ], availableActions: ['enable', 'audit'] });
    apiMock.mockResolvedValue({ items: [paused], capabilities: [] });
    render(<Integrations actor={actor()} />);
    const qoreid = (await screen.findByRole('heading', { name: 'QoreID' })).closest('article')!;
    expect(within(qoreid).getByText('Paused')).toBeInTheDocument();
    expect(within(qoreid).getByRole('button', { name: 'Test Connection' })).toBeDisabled();
    expect(within(qoreid).getByText('Contract unconfirmed.')).toBeInTheDocument();
  });

  it('configures only approved non-secret fields when the provider has no prior override', async () => {
    const emptyTermii = provider({ configuration: {} });
    apiMock.mockImplementation(async (path: string) => path === '/admin/integrations'
      ? { ...catalog, items: [emptyTermii] } : path === '/admin/integrations/termii' ? emptyTermii : {});
    vi.spyOn(window, 'prompt').mockReturnValue('Approved sender settings');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Integrations actor={actor()} />);
    const termii = (await screen.findByRole('heading', { name: 'Termii' })).closest('article')!;
    fireEvent.click(within(termii).getByRole('button', { name: 'Configure' }));
    fireEvent.change(await within(termii).findByLabelText('Sender ID'), { target: { value: 'HID' } });
    fireEvent.click(within(termii).getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/integrations/termii/configuration',
      expect.objectContaining({ version: 3, body: { configuration: { senderId: 'HID' }, reason: 'Approved sender settings' } })));
  });

  it('selects an eligible fallback, tests a connection, and fetches audit history', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/admin/integrations') return catalog;
      if (path === '/admin/integrations/qoreid/test') return { status: 'healthy', version: 4 };
      if (path === '/admin/integrations/termii/audit') return { items: [{ eventId: 'event-1',
        action: 'integration.test', occurredAt: '2026-09-01T00:00:00Z', actorSubject: 'staff:admin',
        actorAccountId: '20000000-0000-4000-8000-000000000001', correlationId: 'audit-test-001',
        capability: 'sms', reason: 'Connection test', outcome: 'success' }] };
      return {};
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Approved SMS fallback');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Integrations actor={actor()} />);
    const sms = (await screen.findByRole('heading', { name: 'sms' })).closest('article')!;
    fireEvent.change(within(sms).getByLabelText('sms fallback provider'), { target: { value: 'brevo' } });
    expect(within(sms).getByText(/Unsaved routing choice/)).toBeInTheDocument();
    fireEvent.click(within(sms).getByRole('button', { name: 'Save fallback' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/integrations/capabilities/sms/fallback',
      expect.objectContaining({ version: 8, body: { provider: 'brevo', reason: 'Approved SMS fallback' } })));
    const qoreid = screen.getByRole('heading', { name: 'QoreID' }).closest('article')!;
    fireEvent.click(within(qoreid).getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/integrations/qoreid/test',
      expect.objectContaining({ method: 'POST', version: 3 })));
    const termii = screen.getByRole('heading', { name: 'Termii' }).closest('article')!;
    fireEvent.click(within(termii).getByRole('button', { name: 'View Audit History' }));
    expect(await screen.findByText(/integration.test/)).toBeInTheDocument();
    expect(screen.getByText(/Correlation audit-test-001/)).toBeInTheDocument();
  });

  it('shows a failed connection probe as an error even when the API returns HTTP 200', async () => {
    apiMock.mockImplementation(async (path: string) => path === '/admin/integrations'
      ? catalog : path === '/admin/integrations/qoreid/test' ? { status: 'failed', version: 4 } : {});
    render(<Integrations actor={actor()} />);
    const qoreid = (await screen.findByRole('heading', { name: 'QoreID' })).closest('article')!;
    fireEvent.click(within(qoreid).getByRole('button', { name: 'Test Connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('QoreID connection test: failed');
    expect(screen.queryByText(/connection test saved/i)).not.toBeInTheDocument();
  });
});
