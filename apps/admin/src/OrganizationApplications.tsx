import { FormEvent, useEffect, useState } from 'react';
import { AdminApiError, api } from './api';
import type { AdminActor, OrganizationApplication } from './types';

type ApplicationStatus = OrganizationApplication['status'];
type ListResult = { items: OrganizationApplication[] };
type ReuseIds = { organizationId: string; facilityId: string };
type VerifyResult = { state: OrganizationApplication['verificationResult'];
  providerVerification?: 'verified'; profileState?: 'incomplete' | 'complete';
  status: ApplicationStatus; version: number };

const statusOptions: Array<{ value: ApplicationStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'pending_verification', label: 'Pending verification' },
  { value: 'ready_for_review', label: 'Ready for review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    return `${error.message}${error.correlationId ? ` Reference: ${error.correlationId}` : ''}`;
  }
  return 'The service is unavailable. Try again.';
}

function formattedDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'Unavailable';
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function providerCheck(application: OrganizationApplication): string {
  switch (application.verificationResult) {
    case 'verified':
    case 'verified_incomplete': return 'Verified';
    case 'not_verified': return 'Not verified';
    case 'incomplete': return 'Incomplete provider response';
    case 'provider_error': return 'Provider error';
    case 'disabled': return 'Unavailable';
    default: return 'Not run';
  }
}

function hasCompleteProfile(application: OrganizationApplication): boolean {
  if (application.profileState) return application.profileState === 'complete';
  return Boolean(application.verifiedOrganizationName)
    && Boolean(application.verifiedEntityType)
    && Boolean(application.verifiedRegistrationDate)
    && Boolean(application.verifiedAddress)
    && application.verifiedRegistryStatus === 'active';
}

function profileCompleteness(application: OrganizationApplication): string {
  if (application.verificationResult === 'verified' && hasCompleteProfile(application)) return 'Complete';
  if (application.verificationResult === 'verified' || application.verificationResult === 'verified_incomplete') return 'Incomplete';
  return 'Awaiting provider check';
}

function profileValue(application: OrganizationApplication,
  name: keyof NonNullable<OrganizationApplication['fieldSources']>,
  value: string | null | undefined): JSX.Element {
  const source = application.fieldSources?.[name];
  return <>{value ?? '—'}{source && <small> · {source === 'qoreid'
    ? 'QoreID supplied' : 'Applicant supplied'}</small>}</>;
}

function bindingState(application: OrganizationApplication, ready: boolean): string {
  if (application.status === 'approved') return 'Bound';
  if (ready) return 'Ready for review';
  return 'Not ready';
}

export function OrganizationApplications({ actor }: { actor: AdminActor }) {
  const [status, setStatus] = useState<ApplicationStatus | ''>('');
  const [revision, setRevision] = useState(0);
  const [items, setItems] = useState<OrganizationApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [reuseIds, setReuseIds] = useState<Record<string, ReuseIds>>({});

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
    void api<ListResult>(`/admin/organization-applications${suffix}`)
      .then((result) => { if (active) setItems(result.items); })
      .catch((error) => { if (active) setLoadError(errorMessage(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [status, revision]);

  const canVerifyOrReject = actor.platformPermissions.includes('platform.facility.manage');
  const canApprove = canVerifyOrReject && actor.platformPermissions.includes('platform.principal.manage')
    && actor.platformPermissions.includes('platform.role.manage');

  async function verify(application: OrganizationApplication) {
    if (!window.confirm(`Request CAC verification for ${application.cacHint}? This may contact the external provider.`)) return;
    setBusyId(application.applicationId); setActionError(null); setNotice(null);
    try {
      const result = await api<VerifyResult>(`/admin/organization-applications/${application.applicationId}/verify-cac`, {
        method: 'POST', version: application.version,
      });
      setNotice(result.state === 'verified' && result.profileState === 'incomplete'
        ? `QoreID verified the CAC check for ${application.cacHint}. The applicant can complete missing profile fields after confirming the administrator email; approval remains unavailable until review-ready.`
        : result.state === 'verified'
          ? `CAC verification recorded for ${application.cacHint}. The completed sourced profile is ready for platform review.`
          : `CAC verification result recorded for ${application.cacHint}. Review the application state.`);
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusyId(null); setRevision((current) => current + 1); }
  }

  async function review(application: OrganizationApplication, action: 'approve' | 'reject') {
    const reason = (reasons[application.applicationId] ?? '').trim();
    if (reason.length < 8 || reason.length > 500) {
      setActionError('Enter a review reason of 8 to 500 characters.'); return;
    }
    const ids = reuseIds[application.applicationId] ?? { organizationId: '', facilityId: '' };
    const organizationId = ids.organizationId.trim();
    const facilityId = ids.facilityId.trim();
    if (action === 'approve' && ((organizationId || facilityId)
      && (!uuidV4.test(organizationId) || !uuidV4.test(facilityId)))) {
      setActionError('Provide both existing organization and facility UUIDs, or leave both blank.'); return;
    }
    const detail = action === 'approve'
      ? `Approve the reviewed organization profile for ${application.profileCompanyName ?? application.verifiedOrganizationName}? Check the source of each field before provisioning or linking an organization and administrator.`
      : `Reject the application for ${application.cacHint}?`;
    if (!window.confirm(detail)) return;
    setBusyId(application.applicationId); setActionError(null); setNotice(null);
    try {
      const body = action === 'approve'
        ? { reason, ...(organizationId ? { existingOrganizationId: organizationId,
          existingFacilityId: facilityId } : {}) }
        : { reason };
      await api(`/admin/organization-applications/${application.applicationId}/${action}`, {
        method: 'POST', version: application.version, body,
      });
      setReasons((current) => ({ ...current, [application.applicationId]: '' }));
      setNotice(`Application for ${application.cacHint} ${action === 'approve' ? 'approved' : 'rejected'}.`);
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusyId(null); setRevision((current) => current + 1); }
  }

  function updateReason(applicationId: string, reason: string) {
    setReasons((current) => ({ ...current, [applicationId]: reason }));
  }

  function updateReuse(applicationId: string, field: keyof ReuseIds, value: string) {
    setReuseIds((current) => ({ ...current,
      [applicationId]: { organizationId: current[applicationId]?.organizationId ?? '',
        facilityId: current[applicationId]?.facilityId ?? '', [field]: value },
    }));
  }

  return <div className="organization-applications-page">
    <header className="page-head"><p className="eyebrow">HID Super Admin</p><h1>Provider applications</h1>
      <p>Review the masked CAC reference, QoreID check, and source of each organization field before granting access.</p></header>
    <div className="filters"><label className="application-filter">Application status
      <select value={status} onChange={(event) => { setStatus(event.target.value as ApplicationStatus | ''); setActionError(null); setNotice(null); }}>
        {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <button type="button" onClick={() => setRevision((current) => current + 1)}>Refresh</button>
    </div>
    {actionError && <div className="error" role="alert">{actionError}</div>}
    {notice && <p className="integration-notice" role="status">{notice}</p>}
    {!canVerifyOrReject && <p className="empty">Read-only access. Facility management permission is required for review actions.</p>}
    {loading ? <p className="empty">Loading applications…</p>
      : loadError ? <div className="error" role="alert">{loadError}</div>
        : items.length === 0 ? <p className="empty">No applications found for this status.</p>
          : <div className="cards">{items.map((application) => {
            const open = application.status === 'pending_verification' || application.status === 'ready_for_review';
            const ready = application.status === 'ready_for_review'
              && application.verificationResult === 'verified' && hasCompleteProfile(application);
            const busy = busyId === application.applicationId;
            const ids = reuseIds[application.applicationId] ?? { organizationId: '', facilityId: '' };
            return <article className="card application-card" key={application.applicationId}>
              <header><div><p className="eyebrow">{label(application.productCode)} · Requested {label(application.organizationType)} service</p>
                <h2>{application.profileCompanyName ?? application.verifiedOrganizationName
                  ?? (application.verificationResult === 'verified' || application.verificationResult === 'verified_incomplete'
                    ? 'Organization profile incomplete' : 'Registry verification pending')}</h2>
                <small>Application {application.applicationId}</small></div>
                <span className={`status status-${application.status.replaceAll('_', '-')}`}>
                  {application.verificationResult === 'verified' && application.profileState === 'incomplete'
                    ? 'Awaiting applicant details' : label(application.status)}
                </span></header>
              <dl>
                <dt>Masked CAC</dt><dd>{application.cacHint}</dd>
                <dt>Organization name</dt><dd>{profileValue(application, 'companyName',
                  application.profileCompanyName ?? application.verifiedOrganizationName)}</dd>
                <dt>Entity type</dt><dd>{profileValue(application, 'entityType',
                  application.profileEntityType ?? application.verifiedEntityType)}</dd>
                <dt>Registration date</dt><dd>{profileValue(application, 'registrationDate',
                  application.profileRegistrationDate ?? application.verifiedRegistrationDate)}</dd>
                <dt>Registered address</dt><dd>{profileValue(application, 'address',
                  application.profileAddress ?? application.verifiedAddress)}</dd>
                <dt>Registry status</dt><dd>{profileValue(application, 'registryStatus',
                  application.profileRegistryStatus ?? application.verifiedRegistryStatus)}</dd>
                <dt>Provider CAC check</dt><dd>{providerCheck(application)}</dd>
                <dt>Organization profile</dt><dd>{profileCompleteness(application)}</dd>
                <dt>Organization binding</dt><dd>{bindingState(application, ready)}</dd>
                <dt>Organization activation</dt><dd>{application.status === 'approved' ? 'Active' : 'Not active'}</dd>
                <dt>Applicant admin</dt><dd>{application.administratorName} · {application.administratorEmail}</dd>
                <dt>Submitted</dt><dd>{formattedDate(application.createdAt)}</dd>
                <dt>Provider checked</dt><dd>{formattedDate(application.verifiedAt)}</dd>
                <dt>Reviewed</dt><dd>{formattedDate(application.reviewedAt)}</dd>
                <dt>Version</dt><dd>{application.version}</dd>
              </dl>
              {open && canVerifyOrReject && <div className="application-review">
                <div className="actions"><button type="button" disabled={busy || busyId !== null}
                  onClick={() => void verify(application)}>{application.verificationResult === 'verified'
                    || application.verificationResult === 'verified_incomplete' ? 'Reverify CAC' : 'Verify CAC'}</button></div>
                <form onSubmit={(event: FormEvent) => { event.preventDefault(); if (ready && canApprove) void review(application, 'approve'); }}>
                  <label>Review reason <textarea value={reasons[application.applicationId] ?? ''} minLength={8} maxLength={500}
                    onChange={(event) => updateReason(application.applicationId, event.target.value)}
                    placeholder="Record the basis for approval or rejection" required /></label>
                  {ready && canApprove && <div className="application-reuse-fields">
                    <p>For a reviewed existing organization, enter both IDs. Leave blank to create a new organization.</p>
                    <label>Existing organization ID <input value={ids.organizationId} onChange={(event) => updateReuse(application.applicationId, 'organizationId', event.target.value)} /></label>
                    <label>Existing facility ID <input value={ids.facilityId} onChange={(event) => updateReuse(application.applicationId, 'facilityId', event.target.value)} /></label>
                  </div>}
                  <div className="actions">
                    <button type="submit" className="primary" disabled={!ready || !canApprove || busy || busyId !== null}>Approve and provision</button>
                    <button type="button" className="danger" disabled={busy || busyId !== null}
                      onClick={() => void review(application, 'reject')}>Reject application</button>
                  </div>
                  {!canApprove && <small>Principal and role management permissions are required to approve.</small>}
                  {!ready && <small>{application.verificationResult === 'verified'
                    && application.profileState === 'incomplete'
                    ? 'QoreID verified this CAC check. The applicant must complete missing fields using the administrator email code before review.'
                    : 'Approval requires a verified CAC lookup and complete sourced organization profile.'}</small>}
                </form>
              </div>}
            </article>;
          })}</div>}
  </div>;
}
