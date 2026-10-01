import { FormEvent, useEffect, useState } from 'react';
import { AdminApiError, api } from './api';
import type { AdminActor, OrganizationApplication } from './types';

type ApplicationStatus = OrganizationApplication['status'];
type ListResult = { items: OrganizationApplication[] };
type ReuseIds = { organizationId: string; facilityId: string };

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
      await api(`/admin/organization-applications/${application.applicationId}/verify-cac`, {
        method: 'POST', version: application.version,
      });
      setNotice(`CAC verification recorded for ${application.cacHint}. Review the registry identity before approval.`);
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
      ? `Approve the registry-verified organization ${application.verifiedOrganizationName}? This provisions or links an organization and administrator.`
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
      <p>Review the masked CAC reference and registry-confirmed organization identity before granting access. Verification depends on the configured provider.</p></header>
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
              && application.verificationResult === 'verified' && Boolean(application.verifiedOrganizationName)
              && Boolean(application.verifiedEntityType) && Boolean(application.verifiedRegistrationDate)
              && Boolean(application.verifiedAddress) && application.verifiedRegistryStatus === 'active';
            const busy = busyId === application.applicationId;
            const ids = reuseIds[application.applicationId] ?? { organizationId: '', facilityId: '' };
            return <article className="card application-card" key={application.applicationId}>
              <header><div><p className="eyebrow">{label(application.productCode)} · Requested {label(application.organizationType)} service</p>
                <h2>{application.verifiedOrganizationName ?? 'Registry verification pending'}</h2><small>Application {application.applicationId}</small></div>
                <span className={`status status-${application.status.replaceAll('_', '-')}`}>{label(application.status)}</span></header>
              <dl>
                <dt>Masked CAC</dt><dd>{application.cacHint}</dd>
                <dt>Registry legal name</dt><dd>{application.verifiedOrganizationName ?? 'Awaiting verified CAC result'}</dd>
                <dt>Registry entity type</dt><dd>{application.verifiedEntityType ?? '—'}</dd>
                <dt>Registration date</dt><dd>{application.verifiedRegistrationDate ?? '—'}</dd>
                <dt>Registry address</dt><dd>{application.verifiedAddress ?? '—'}</dd>
                <dt>Registry status</dt><dd>{application.verifiedRegistryStatus ? label(application.verifiedRegistryStatus) : '—'}</dd>
                <dt>Verification</dt><dd>{application.verificationResult ? label(application.verificationResult) : 'Not run'}</dd>
                <dt>Applicant admin</dt><dd>{application.administratorName} · {application.administratorEmail}</dd>
                <dt>Submitted</dt><dd>{formattedDate(application.createdAt)}</dd>
                <dt>Verified</dt><dd>{formattedDate(application.verifiedAt)}</dd>
                <dt>Reviewed</dt><dd>{formattedDate(application.reviewedAt)}</dd>
                <dt>Version</dt><dd>{application.version}</dd>
              </dl>
              {open && canVerifyOrReject && <div className="application-review">
                <div className="actions"><button type="button" disabled={busy || busyId !== null}
                  onClick={() => void verify(application)}>{application.verificationResult === 'verified' ? 'Reverify CAC' : 'Verify CAC'}</button></div>
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
                  {!ready && <small>Approval requires a complete, active registry identity from CAC verification.</small>}
                </form>
              </div>}
            </article>;
          })}</div>}
  </div>;
}
