import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrganizationApplications } from './OrganizationApplications';
import { AdminApiError } from './api';
import type { AdminActor, OrganizationApplication } from './types';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: apiMock };
});

const actor = (permissions: string[]): AdminActor => ({
  accountId: '20000000-0000-4000-8000-000000000001', subject: 'staff:admin',
  displayName: 'Admin', email: 'admin@example.test', platformRoles: ['platform_super_admin'],
  platformPermissions: permissions,
});
const reviewer = actor(['platform.identity-review.read', 'platform.facility.manage',
  'platform.principal.manage', 'platform.role.manage']);
const application: OrganizationApplication = {
  applicationId: '10000000-0000-4000-8000-000000000011', productCode: 'laboratory',
  organizationName: null, organizationType: 'laboratory', cacHint: 'RC******34',
  administratorName: 'Ada Admin', administratorEmail: 'ada@example.test',
  status: 'pending_verification', verificationResult: null, verifiedOrganizationName: null,
  verifiedEntityType: null, verifiedRegistrationDate: null, verifiedAddress: null,
  verifiedRegistryStatus: null,
  version: 3, createdAt: '2026-09-01T00:00:00Z', verifiedAt: null, reviewedAt: null,
};

afterEach(() => { apiMock.mockReset(); vi.restoreAllMocks(); });

describe('provider organization application review', () => {
  it('shows only the masked CAC hint and keeps a reader in read-only mode', async () => {
    apiMock.mockResolvedValue({ items: [{ ...application, cacRegistrationNumber: 'RC12345634' }] });
    render(<OrganizationApplications actor={actor(['platform.identity-review.read'])} />);
    expect(await screen.findByRole('heading', { name: 'Provider applications' })).toBeInTheDocument();
    expect(screen.getByText('RC******34')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('RC12345634');
    expect(screen.getByText(/Read-only access/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify CAC' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Application status'), { target: { value: 'ready_for_review' } });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/organization-applications?status=ready_for_review'));
  });

  it('requires confirmation and sends the current version for CAC verification', async () => {
    apiMock.mockImplementation(async (path: string) => path === '/admin/organization-applications'
      ? { items: [application] } : { status: 'pending_verification', version: 4, state: 'not_verified' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<OrganizationApplications actor={reviewer} />);
    const verify = await screen.findByRole('button', { name: 'Verify CAC' });
    expect(screen.getByRole('button', { name: 'Approve and provision' })).toBeDisabled();
    fireEvent.click(verify);
    expect(apiMock.mock.calls.some(([path]) => String(path).endsWith('/verify-cac'))).toBe(false);
    fireEvent.click(verify);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      `/admin/organization-applications/${application.applicationId}/verify-cac`,
      { method: 'POST', version: 3 }));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('shows a verified CAC check with missing applicant fields as pending and blocks approval', async () => {
    const incomplete: OrganizationApplication = { ...application, verificationResult: 'verified',
      profileState: 'incomplete', profileAddress: 'Synthetic Registry Office',
      fieldSources: { companyName: null, entityType: null, registrationDate: null,
        address: 'qoreid', registryStatus: null },
      verifiedAt: '2026-09-02T00:00:00Z', version: 4 };
    apiMock.mockImplementation(async (path: string) => path === '/admin/organization-applications'
      ? { items: [incomplete] }
      : { status: 'pending_verification', version: 5, state: 'verified',
        profileState: 'incomplete', providerVerification: 'verified' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<OrganizationApplications actor={reviewer} />);
    const card = (await screen.findByRole('heading', { name: 'Organization profile incomplete' })).closest('article')!;
    expect(within(card).getByText('Awaiting applicant details')).toBeInTheDocument();
    expect(within(card).getByText(/Synthetic Registry Office/)).toBeInTheDocument();
    expect(within(card).getByText(/QoreID supplied/)).toBeInTheDocument();
    expect(within(card).getByText('Provider CAC check').nextElementSibling).toHaveTextContent('Verified');
    expect(within(card).getByText('Organization profile').nextElementSibling).toHaveTextContent('Incomplete');
    expect(within(card).getByText('Organization binding').nextElementSibling).toHaveTextContent('Not ready');
    expect(within(card).getByText('Organization activation').nextElementSibling).toHaveTextContent('Not active');
    expect(within(card).getByText('Provider checked').nextElementSibling).not.toHaveTextContent('—');
    expect(within(card).getByRole('button', { name: 'Approve and provision' })).toBeDisabled();
    expect(within(card).getByText(/applicant must complete missing fields/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Reverify CAC' }));
    expect(await screen.findByRole('status')).toHaveTextContent('QoreID verified the CAC check');
    expect(screen.getByRole('status')).toHaveTextContent('approval remains unavailable');
    expect(apiMock.mock.calls.some(([path]) => String(path).endsWith('/approve'))).toBe(false);
  });

  it('shows applicant provenance on a completed profile before admin approval', async () => {
    const sourced: OrganizationApplication = { ...application, status: 'ready_for_review',
      verificationResult: 'verified', profileState: 'complete',
      profileCompanyName: 'Applicant Clinic Limited', profileEntityType: 'Private Limited',
      profileRegistrationDate: '2018-06-12', profileAddress: 'Synthetic Registry Office',
      profileRegistryStatus: 'active', fieldSources: {
        companyName: 'user_provided', entityType: 'user_provided',
        registrationDate: 'user_provided', address: 'qoreid', registryStatus: 'user_provided',
      } };
    apiMock.mockResolvedValue({ items: [sourced] });
    render(<OrganizationApplications actor={reviewer} />);
    const card = (await screen.findByRole('heading', { name: 'Applicant Clinic Limited' })).closest('article')!;
    expect(within(card).getAllByText(/Applicant supplied/)).toHaveLength(4);
    expect(within(card).getByText(/QoreID supplied/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Approve and provision' })).toBeEnabled();
  });

  it('requires review reason and confirmation before approving the verified legal entity', async () => {
    const ready = { ...application, status: 'ready_for_review' as const,
      organizationName: 'Registry Lab Limited', verificationResult: 'verified' as const,
      verifiedOrganizationName: 'Registry Lab Limited', verifiedEntityType: 'Private Limited',
      verifiedRegistrationDate: '2001-01-01', verifiedAddress: '123 Registry Street, Lagos',
      verifiedRegistryStatus: 'active', version: 7 };
    apiMock.mockImplementation(async (path: string) => path === '/admin/organization-applications'
      ? { items: [ready] } : { organizationId: 'new-org' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<OrganizationApplications actor={reviewer} />);
    const card = (await screen.findByRole('heading', { name: 'Registry Lab Limited' })).closest('article')!;
    expect(within(card).getAllByText('Registry Lab Limited')).not.toHaveLength(0);
    expect(within(card).getByText('Provider CAC check').nextElementSibling).toHaveTextContent('Verified');
    expect(within(card).getByText('Organization profile').nextElementSibling).toHaveTextContent('Complete');
    expect(within(card).getByText('Organization binding').nextElementSibling).toHaveTextContent('Ready for review');
    expect(within(card).getByText('Organization activation').nextElementSibling).toHaveTextContent('Not active');
    fireEvent.change(within(card).getByLabelText('Review reason'), { target: { value: 'Registry legal entity and admin reviewed' } });
    fireEvent.change(within(card).getByLabelText('Existing organization ID'), {
      target: { value: '10000000-0000-4000-8000-000000000001' },
    });
    fireEvent.change(within(card).getByLabelText('Existing facility ID'), {
      target: { value: '10000000-0000-4000-8000-000000000002' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Approve and provision' }));
    expect(apiMock.mock.calls.some(([path]) => String(path).endsWith('/approve'))).toBe(false);
    fireEvent.click(within(card).getByRole('button', { name: 'Approve and provision' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      `/admin/organization-applications/${application.applicationId}/approve`,
      { method: 'POST', version: 7, body: { reason: 'Registry legal entity and admin reviewed',
        existingOrganizationId: '10000000-0000-4000-8000-000000000001',
        existingFacilityId: '10000000-0000-4000-8000-000000000002' } }));
    expect(confirm.mock.calls[0]?.[0]).toContain('Registry Lab Limited');
  });

  it('labels an approved and bound organization as active without offering another approval', async () => {
    const approved: OrganizationApplication = { ...application, status: 'approved',
      verificationResult: 'verified', verifiedOrganizationName: 'Registry Lab Limited',
      verifiedEntityType: 'Private Limited', verifiedRegistrationDate: '2001-01-01',
      verifiedAddress: '123 Registry Street, Lagos', verifiedRegistryStatus: 'active' };
    apiMock.mockResolvedValue({ items: [approved] });
    render(<OrganizationApplications actor={reviewer} />);
    const card = (await screen.findByRole('heading', { name: 'Registry Lab Limited' })).closest('article')!;
    expect(within(card).getByText('Organization binding').nextElementSibling).toHaveTextContent('Bound');
    expect(within(card).getByText('Organization activation').nextElementSibling).toHaveTextContent('Active');
    expect(within(card).queryByRole('button', { name: 'Approve and provision' })).not.toBeInTheDocument();
  });

  it('keeps approval disabled without all provisioning permissions and sends a versioned rejection', async () => {
    apiMock.mockImplementation(async (path: string) => path === '/admin/organization-applications'
      ? { items: [application] } : { status: 'rejected', version: 4 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<OrganizationApplications actor={actor(['platform.identity-review.read', 'platform.facility.manage'])} />);
    const card = (await screen.findByRole('heading', { name: 'Registry verification pending' })).closest('article')!;
    expect(within(card).getByRole('button', { name: 'Approve and provision' })).toBeDisabled();
    fireEvent.click(within(card).getByRole('button', { name: 'Reject application' }));
    expect(screen.getByRole('alert')).toHaveTextContent('8 to 500 characters');
    fireEvent.change(within(card).getByLabelText('Review reason'), { target: { value: 'Invalid application evidence' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Reject application' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      `/admin/organization-applications/${application.applicationId}/reject`,
      { method: 'POST', version: 3, body: { reason: 'Invalid application evidence' } }));
  });

  it('surfaces provider failure with its correlation reference and reloads recorded evidence', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/admin/organization-applications') return { items: [application] };
      throw new AdminApiError(503, 'QOREID_DISABLED', 'External verification is not enabled', 'cac-correlation');
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<OrganizationApplications actor={reviewer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify CAC' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cac-correlation');
    await waitFor(() => expect(apiMock.mock.calls.filter(([path]) => path === '/admin/organization-applications')).toHaveLength(2));
  });
});
