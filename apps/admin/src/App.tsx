import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { AdminApiError, api, commandKey } from './api';
import { accessState, visibleNavigation } from './navigation';
import type { AdminSession, AuditEvent, EventFailure, Facility, IdentityReview, Page, Principal, ServiceState } from './types';
import { Turnstile } from '@hid/ui/Turnstile';

type LoadState<T> = { value: T | null; loading: boolean; error: string | null };

function useLoad<T>(loader: () => Promise<T>, dependencies: readonly unknown[] = []) {
  const [state, setState] = useState<LoadState<T>>({ value: null, loading: true, error: null });
  const reload = useCallback(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    void loader().then((value) => active && setState({ value, loading: false, error: null }))
      .catch((error) => active && setState({ value: null, loading: false, error: errorMessage(error) }));
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  useEffect(() => reload(), [reload]);
  return { ...state, reload: () => reload() };
}

export default function App() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    setLoading(true);
    setAuthError(null);
    try { setSession(await api<AdminSession>('/admin/session')); }
    catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) setSession(null);
      else setAuthError(errorMessage(error));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refreshSession(); }, [refreshSession]);
  useEffect(() => {
    const expired = () => setSession(null);
    window.addEventListener('hid:admin-session-expired', expired);
    return () => window.removeEventListener('hid:admin-session-expired', expired);
  }, []);

  if (loading) return <FullState title="Verifying administrator access" detail="Identity is validating the current session and platform membership." />;
  if (authError) return <FullState title="Administration unavailable" detail={authError} action={<button onClick={() => void refreshSession()}>Retry</button>} />;
  const state = accessState(session?.actor ?? null);
  if (state === 'unauthenticated') return <Login onAuthenticated={(next) => setSession(next)} />;
  if (state === 'unauthorized') return <FullState title="Access denied" detail="This account has no active HID platform administration membership." />;
  return <Shell session={session!} onSignedOut={() => setSession(null)} />;
}

function Login({ onAuthenticated }: { onAuthenticated: (session: AdminSession) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { onAuthenticated(await api<AdminSession>('/auth/login', { method: 'POST', body: {
      email, password, turnstileToken, turnstileAction: 'admin-login',
    } })); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <main className="login-shell"><section className="login-card" aria-labelledby="login-title">
    <div className="brand-mark">HID</div><p className="eyebrow">Governed platform administration</p>
    <h1 id="login-title">Administrator sign in</h1>
    <p>Identity authentication, session controls, CSRF protection, and explicit platform membership remain authoritative.</p>
    <form onSubmit={(event) => void submit(event)}>
      <label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <Turnstile action="admin-login" onTokenChange={setTurnstileToken} />
      {error && <ErrorBanner message={error} />}
      <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </section></main>;
}

function Shell({ session, onSignedOut }: { session: AdminSession; onSignedOut: () => void }) {
  const actor = session.actor;
  const navigate = useNavigate();
  const items = visibleNavigation(actor);
  async function logout() {
    try { await api<void>('/auth/logout', { method: 'POST' }); } finally { onSignedOut(); navigate('/', { replace: true }); }
  }
  return <div className="app-shell"><aside>
    <div className="brand"><span className="brand-mark">HID</span><div><strong>Platform control</strong><small>Administration</small></div></div>
    <nav aria-label="Administration navigation">{items.map((item) => <NavLink key={item.path} to={item.path} end={item.path === '/'}>{item.label}</NavLink>)}</nav>
    <div className="actor"><strong>{actor.displayName ?? actor.email ?? 'Administrator'}</strong><span>{actor.platformRoles.join(', ')}</span><button onClick={() => void logout()}>Sign out</button></div>
  </aside><main className="content"><Routes>
    <Route path="/" element={<Overview />} />
    <Route path="/facilities" element={<Permission actor={actor} permission="platform.facility.read"><Facilities actor={actor} /></Permission>} />
    <Route path="/facilities/:facilityId" element={<Permission actor={actor} permission="platform.facility.read"><FacilityDetail /></Permission>} />
    <Route path="/users" element={<Permission actor={actor} permission="platform.principal.read"><Principals actor={actor} /></Permission>} />
    <Route path="/identity" element={<Permission actor={actor} permission="platform.identity-review.read"><IdentityReviews /></Permission>} />
    <Route path="/audit" element={<Permission actor={actor} permission="platform.audit.read"><AuditCenter /></Permission>} />
    <Route path="/operations" element={<Permission actor={actor} permission="platform.operations.read"><Operations /></Permission>} />
    <Route path="/events" element={<Permission actor={actor} permission="platform.operations.read"><Events /></Permission>} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></main></div>;
}

function Permission({ actor, permission, children }: { actor: AdminSession['actor']; permission: string; children: ReactNode }) {
  return actor.platformPermissions.includes(permission) ? children : <FullState title="Access denied" detail="The required platform capability is not assigned." />;
}

function Overview() {
  const state = useLoad(() => api<Record<string, number>>('/admin/overview'), []);
  return <Page title="Platform overview" subtitle="Truthful Identity-owned counts. Clinical content is deliberately absent.">
    <Load state={state}>{(value) => <div className="metrics">{Object.entries(value).map(([key, count]) => <article className="metric" key={key}><span>{label(key)}</span><strong>{count.toLocaleString()}</strong></article>)}</div>}</Load>
    <section className="boundary"><h2>Permanent authority boundaries</h2><div className="boundary-grid"><p>Super Admin ≠ clinical authority</p><p>Super Admin ≠ break-glass</p><p>Admin UI ≠ database console</p></div></section>
  </Page>;
}

function Facilities({ actor }: { actor: AdminSession['actor'] }) {
  const [status, setStatus] = useState(''); const [query, setQuery] = useState('');
  const path = `/admin/facilities?page=1&pageSize=50${status ? `&status=${status}` : ''}${query.trim().length >= 2 ? `&query=${encodeURIComponent(query.trim())}` : ''}`;
  const state = useLoad(() => api<Page<Facility>>(path), [path]);
  const canManage = actor.platformPermissions.includes('platform.facility.manage');
  async function transition(facility: Facility, next: Facility['status']) {
    const reason = window.prompt(`Reason for changing ${facility.name} to ${next} (minimum 8 characters):`);
    if (!reason || reason.trim().length < 8) return;
    if (!window.confirm(`Confirm ${next} for ${facility.name}. Existing history will be preserved.`)) return;
    try { await api(`/admin/facilities/${facility.id}/status`, { method: 'POST', body: { status: next, reason },
      version: facility.version, idempotencyKey: commandKey('facility-status') }); state.reload(); }
    catch (error) { window.alert(errorMessage(error)); }
  }
  return <Page title="Facilities" subtitle="Verification and suspension are governed lifecycle transitions, never deletion.">
    <Filters><input aria-label="Search facilities" placeholder="Name or code" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label="Facility status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['pending','verified','rejected','suspended'].map((item) => <option key={item}>{item}</option>)}</select></Filters>
    <Load state={state}>{(value) => <Table headers={['Facility','Organization','Status','Memberships','Version','Actions']} rows={value.items.map((facility) => [
      <div><strong><Link to={`/facilities/${facility.id}`}>{facility.name}</Link></strong><small>{facility.code}</small></div>, facility.organizationName, <Status value={facility.status} />,
      facility.membershipCount, facility.version, canManage ? <div className="actions">{facility.status !== 'verified' && <button onClick={() => void transition(facility, 'verified')}>Verify/reactivate</button>}{facility.status === 'pending' && <button onClick={() => void transition(facility, 'rejected')}>Reject</button>}{facility.status !== 'suspended' && <button className="danger" onClick={() => void transition(facility, 'suspended')}>Suspend</button>}</div> : 'Read only'])} />}</Load>
  </Page>;
}

function FacilityDetail() {
  const { facilityId } = useParams();
  const state = useLoad(() => api<Facility>(`/admin/facilities/${facilityId}`), [facilityId]);
  return <Page title="Facility detail" subtitle="Governance state and membership count; clinical records are outside this view.">
    <p><Link to="/facilities">← Back to facilities</Link></p>
    <Load state={state}>{(facility) => <article className="card"><header><div><h3>{facility.name}</h3><small>{facility.code} · {facility.organizationName}</small></div><Status value={facility.status} /></header><dl><dt>Facility ID</dt><dd>{facility.id}</dd><dt>Memberships</dt><dd>{facility.membershipCount}</dd><dt>Version</dt><dd>{facility.version}</dd><dt>Status reason</dt><dd>{facility.statusReason ?? 'No reason recorded'}</dd><dt>Status changed</dt><dd>{facility.statusChangedAt ? date(facility.statusChangedAt) : 'Not reported'}</dd></dl></article>}</Load>
  </Page>;
}

const platformRoleOptions = ['platform_super_admin','platform_operations_admin','identity_review_admin','facility_review_admin','security_auditor','support_admin'];
function Principals({ actor }: { actor: AdminSession['actor'] }) {
  const [query, setQuery] = useState(''); const [submitted, setSubmitted] = useState('');
  const state = useLoad(() => submitted.length >= 2 ? api<Page<Principal>>(`/admin/principals?query=${encodeURIComponent(submitted)}&page=1&pageSize=50`) : Promise.resolve({ items: [], page: 1, pageSize: 50, total: 0 }), [submitted]);
  async function status(principal: Principal, next: 'active' | 'disabled') {
    const reason = window.prompt(`Reason for ${next === 'disabled' ? 'suspending' : 'reactivating'} this account:`);
    if (!reason || reason.trim().length < 8 || !window.confirm('Confirm this authoritative account change and session invalidation.')) return;
    try { await api(`/admin/principals/${principal.id}/status`, { method: 'POST', body: { status: next, reason }, version: principal.version, idempotencyKey: commandKey('account-status') }); state.reload(); }
    catch (error) { window.alert(errorMessage(error)); }
  }
  async function revokeSessions(principal: Principal) {
    const reason = window.prompt('Reason for revoking all active sessions:');
    if (!reason || reason.trim().length < 8 || !window.confirm('Revoke all active sessions for this principal?')) return;
    try { await api(`/admin/principals/${principal.id}/sessions/revoke`, { method: 'POST', body: { reason }, idempotencyKey: commandKey('sessions-revoke') }); state.reload(); }
    catch (error) { window.alert(errorMessage(error)); }
  }
  async function changeRole(principal: Principal) {
    const roleCode = window.prompt(`Role (${platformRoleOptions.join(', ')}):`);
    if (!roleCode || !platformRoleOptions.includes(roleCode)) return;
    const action = principal.platformRoles.includes(roleCode) ? 'revoke' : 'grant';
    const reason = window.prompt(`Reason to ${action} ${roleCode}:`);
    if (!reason || reason.trim().length < 8 || !window.confirm(`Confirm ${action} of ${roleCode}.`)) return;
    try { await api(`/admin/principals/${principal.id}/platform-roles`, { method: 'POST', body: { roleCode, action, reason }, version: principal.version, idempotencyKey: commandKey('platform-role') }); state.reload(); }
    catch (error) { window.alert(errorMessage(error)); }
  }
  return <Page title="Users & memberships" subtitle="Authentication principals, facility memberships, and platform roles remain distinct.">
    <form className="filters" onSubmit={(event) => { event.preventDefault(); if (query.trim().length >= 2) setSubmitted(query.trim()); }}><input aria-label="Principal search" placeholder="Email, name, or subject" value={query} onChange={(e) => setQuery(e.target.value)} /><button className="primary">Search</button></form>
    {!submitted && <Empty text="Enter at least two characters. The platform never downloads the complete principal directory." />}
    {submitted && <Load state={state}>{(value) => <div className="cards">{value.items.map((principal) => <article className="card" key={principal.id}><header><div><h3>{principal.displayName ?? principal.email ?? 'Unnamed principal'}</h3><small>{principal.email ?? principal.subject}</small></div><Status value={principal.status} /></header><dl><dt>Platform roles</dt><dd>{principal.platformRoles.join(', ') || 'None'}</dd><dt>Facility memberships</dt><dd>{principal.memberships.map((membership) => `${membership.facilityName} · ${membership.role}`).join('; ') || 'None'}</dd><dt>Active sessions</dt><dd>{principal.activeSessionCount}</dd><dt>Version</dt><dd>{principal.version}</dd></dl><div className="actions">{actor.platformPermissions.includes('platform.session.revoke') && <button onClick={() => void revokeSessions(principal)}>Revoke sessions</button>}{actor.platformPermissions.includes('platform.principal.manage') && <button className={principal.status === 'active' ? 'danger' : ''} onClick={() => void status(principal, principal.status === 'active' ? 'disabled' : 'active')}>{principal.status === 'active' ? 'Suspend' : 'Reactivate'}</button>}{actor.platformPermissions.includes('platform.role.manage') && <button onClick={() => void changeRole(principal)}>Change platform role</button>}</div></article>)}</div>}</Load>}
  </Page>;
}

function IdentityReviews() {
  const state = useLoad(() => api<Page<IdentityReview>>('/admin/identity/reviews?page=1&pageSize=50'), []);
  return <Page title="Identity review" subtitle="Candidate review evidence only. This page cannot merge patients or issue a new HID."><Load state={state}>{(value) => <Table headers={['Case','Facility','State','Protected NIN','Provider','Candidates','Updated']} rows={value.items.map((item) => [item.id, item.facilityName, <Status value={item.status} />, item.maskedNin, item.provider, item.candidateCount, date(item.updatedAt)])} />}</Load></Page>;
}

function AuditCenter() {
  const [before, setBefore] = useState('');
  const state = useLoad(() => api<{ items: AuditEvent[]; nextBeforeSequenceId: string | null }>(`/admin/audit/events?limit=50${before ? `&beforeSequenceId=${before}` : ''}`), [before]);
  return <Page title="Audit center" subtitle="Read-only semantic evidence. No update or delete operation exists."><Load state={state}>{(value) => <><Table headers={['Time','Action','Outcome','Actor','Facility','Resource','Correlation']} rows={value.items.map((item) => [date(item.occurredAt), item.action, <Status value={item.outcome} />, item.actorSubject ?? item.actorType, item.facilityId ?? '—', `${item.resourceType ?? '—'} ${item.resourceId ?? ''}`, item.correlationId])} />{value.nextBeforeSequenceId && <button onClick={() => setBefore(value.nextBeforeSequenceId!)}>Older events</button>}</>}</Load></Page>;
}

function Operations() {
  const state = useLoad(() => api<{ checkedAt: string; services: ServiceState[] }>('/admin/operations/services'), []);
  return <Page title="Service operations" subtitle="Bounded server-side checks; one unavailable service does not block the rest."><Load state={state}>{(value) => <Table headers={['Service','State','Live','Ready','Last check','Code']} rows={value.services.map((service) => [service.service, <Status value={service.state} />, bool(service.live), bool(service.ready), date(service.checkedAt), service.code ?? '—'])} />}</Load></Page>;
}

function Events() {
  const state = useLoad(() => api<{ state: string; code: string | null; metrics: Record<string, number | boolean> | null; failures: EventFailure[] }>('/admin/operations/events'), []);
  return <Page title="Event delivery" subtitle="Read-only, PHI-minimal delivery state. Arbitrary retry is intentionally unavailable."><Load state={state}>{(value) => <><Status value={value.state} />{value.metrics ? <div className="metrics">{Object.entries(value.metrics).map(([key, metric]) => <article className="metric" key={key}><span>{label(key)}</span><strong>{String(metric)}</strong></article>)}</div> : <Empty text={`Dispatcher metrics unavailable${value.code ? ` (${value.code})` : ''}.`} />}<h2>Terminal failures</h2>{value.failures.length ? <Table headers={['Event','Type','Producer','Attempts','Safe error','Failed','Correlation']} rows={value.failures.map((item) => [item.eventId, item.eventType, item.producer, item.attemptCount, `${item.errorCode}: ${item.errorSummary}`, date(item.failedAt), item.correlationId])} /> : <Empty text="No terminal event failures were returned." />}</>}</Load></Page>;
}

function Page({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) { return <><header className="page-head"><p className="eyebrow">HID Super Admin</p><h1>{title}</h1><p>{subtitle}</p></header>{children}</>; }
function Filters({ children }: { children: ReactNode }) { return <div className="filters">{children}</div>; }
function Load<T>({ state, children }: { state: LoadState<T> & { reload: () => void }; children: (value: T) => ReactNode }) { if (state.loading) return <Empty text="Loading governed data…" />; if (state.error) return <ErrorBanner message={state.error} action={<button onClick={state.reload}>Retry</button>} />; return state.value ? children(state.value) : <Empty text="No data was returned." />; }
function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) { return <div className="table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>{rows.length === 0 && <Empty text="No matching records." />}</div>; }
function Status({ value }: { value: string }) { return <span className={`status status-${value.replaceAll('_','-')}`}>{label(value)}</span>; }
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function ErrorBanner({ message, action }: { message: string; action?: ReactNode }) { return <div className="error" role="alert"><span>{message}</span>{action}</div>; }
function FullState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) { return <main className="full-state"><div className="brand-mark">HID</div><h1>{title}</h1><p>{detail}</p>{action}</main>; }
function errorMessage(error: unknown) { return error instanceof AdminApiError ? `${error.message}${error.correlationId ? ` Reference: ${error.correlationId}` : ''}` : 'The service is unavailable. Try again.'; }
function label(value: string) { return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_',' ').replaceAll('-',' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function date(value: string) { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'Unavailable'; }
function bool(value: boolean | null) { return value === null ? 'Not reported' : value ? 'Yes' : 'No'; }
