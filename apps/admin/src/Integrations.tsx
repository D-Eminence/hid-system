import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, commandKey } from './api';
import type { AdminActor, CapabilityRouting, IntegrationAuditEvent, IntegrationCatalog,
  IntegrationHealth, IntegrationSetting, ProviderIntegration } from './types';

const configurationFields: Record<string, Array<{ key: string; label: string; kind?: 'email' | 'select'; options?: string[] }>> = {
  ses: [{ key: 'fromAddress', label: 'From address', kind: 'email' }],
  termii: [{ key: 'senderId', label: 'Sender ID' }, { key: 'channel', label: 'Channel', kind: 'select', options: ['generic', 'dnd'] }],
  'meta-whatsapp': [{ key: 'phoneNumberId', label: 'Phone number ID' }, { key: 'templateName', label: 'OTP template name' },
    { key: 'templateLanguage', label: 'Template language' }],
  brevo: [{ key: 'emailFrom', label: 'Email sender', kind: 'email' }, { key: 'smsSender', label: 'SMS sender' },
    { key: 'whatsappSender', label: 'WhatsApp sender' }],
};
const settingName = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Never';
function safeConfiguration(provider: string, configuration: ProviderIntegration['configuration']) {
  const keys = new Set((configurationFields[provider] ?? []).map((field) => field.key));
  return Object.fromEntries(Object.entries(configuration ?? {}).filter(([key, value]) => keys.has(key)
    && (value === null || typeof value === 'boolean' || typeof value === 'number'
      || (typeof value === 'string' && value.length <= 128 && !/^https?:\/\//i.test(value)))));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The integration request could not be completed.';
}

function credentialState(integration: ProviderIntegration) {
  switch (integration.credential?.state) {
    case 'configured': return 'Configured · ••••';
    case 'external': return 'Managed externally · ••••';
    case 'missing': return 'Missing';
    default: return 'Not available';
  }
}

function action(integration: ProviderIntegration, name: string) {
  return integration.availableActions?.includes(name) ?? false;
}

type AuditResponse = { items: IntegrationAuditEvent[] } | IntegrationAuditEvent[];

export function Integrations({ actor }: { actor: AdminActor }) {
  const [catalog, setCatalog] = useState<IntegrationCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, IntegrationSetting>>({});
  const [auditProvider, setAuditProvider] = useState<string | null>(null);
  const [audit, setAudit] = useState<IntegrationAuditEvent[]>([]);

  const canManage = actor.platformPermissions.includes('platform.integration.manage');
  const canTest = actor.platformPermissions.includes('platform.integration.test');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<IntegrationCatalog>('/admin/integrations');
      setCatalog({ items: Array.isArray(result.items) ? result.items : [],
        capabilities: Array.isArray(result.capabilities) ? result.capabilities : [] });
      setError(null);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function mutate(path: string, version: number, body: unknown, label: string) {
    setBusy(path); setError(null); setNotice(null);
    try {
      await api(path, { method: 'POST', body, version, idempotencyKey: commandKey('integration') });
      setNotice(`${label} saved.`);
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(null); }
  }

  function reasonFor(message: string) {
    const reason = window.prompt(`${message}\nReason (at least 8 characters):`)?.trim();
    return reason && reason.length >= 8 ? reason : null;
  }

  function transition(integration: ProviderIntegration, next: 'enable' | 'pause') {
    const reason = reasonFor(`${next === 'pause' ? 'Pause' : 'Enable'} ${integration.name}`);
    if (!reason || !window.confirm(`Confirm ${next} for ${integration.name}. New requests will use the configured routing and fallback policy.`)) return;
    void mutate(`/admin/integrations/${encodeURIComponent(integration.provider)}/${next}`,
      integration.version, { reason }, `${integration.name} ${next === 'pause' ? 'pause' : 'enablement'}`);
  }

  async function configure(integration: ProviderIntegration) {
    setBusy(`configure:${integration.provider}`); setError(null);
    try {
      const detail = await api<ProviderIntegration>(`/admin/integrations/${encodeURIComponent(integration.provider)}`);
      setDraft(safeConfiguration(detail.provider, detail.configuration));
      setEditing(integration.provider);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(null); }
  }

  function saveConfiguration(event: FormEvent, integration: ProviderIntegration) {
    event.preventDefault();
    const reason = reasonFor(`Save non-secret configuration for ${integration.name}`);
    if (!reason || !window.confirm(`Apply configuration changes for ${integration.name}?`)) return;
    setEditing(null);
    const configuration = Object.fromEntries(Object.entries(draft).filter(([, value]) =>
      value !== null && value !== ''));
    void mutate(`/admin/integrations/${encodeURIComponent(integration.provider)}/configuration`,
      integration.version, { configuration, reason }, `${integration.name} configuration`);
  }

  function rotateCredential(integration: ProviderIntegration) {
    const reference = window.prompt('AWS Secrets Manager ARN for the approved replacement credential:')?.trim();
    if (!reference || !/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@:-]+$/.test(reference)) {
      return;
    }
    const reason = reasonFor(`Update the credential reference for ${integration.name}`);
    if (!reason || !window.confirm(`Confirm credential reference update for ${integration.name}?`)) return;
    void mutate(`/admin/integrations/${encodeURIComponent(integration.provider)}/credential-reference`,
      integration.version, { reference, reason }, `${integration.name} credential reference`);
  }

  async function test(integration: ProviderIntegration) {
    const path = `/admin/integrations/${encodeURIComponent(integration.provider)}/test`;
    setBusy(path); setError(null); setNotice(null);
    try {
      const result = await api<{ status: IntegrationHealth }>(path, { method: 'POST',
        body: { reason: 'Administrator requested connection test' }, version: integration.version,
        idempotencyKey: commandKey('integration') });
      await refresh();
      if (result.status === 'healthy') setNotice(`${integration.name} connection test: healthy.`);
      else if (result.status === 'degraded' || result.status === 'failed') {
        setError(`${integration.name} connection test: ${result.status}. Review the provider configuration and audit history.`);
      } else setError(`${integration.name} connection test returned an unknown status.`);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(null); }
  }

  async function showAudit(integration: ProviderIntegration) {
    setBusy(`audit:${integration.provider}`); setError(null);
    try {
      const response = await api<AuditResponse>(`/admin/integrations/${encodeURIComponent(integration.provider)}/audit`);
      setAudit(Array.isArray(response) ? response : Array.isArray(response.items) ? response.items : []);
      setAuditProvider(integration.provider);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(null); }
  }

  function route(capability: CapabilityRouting, kind: 'selection' | 'fallback', provider: string | null) {
    const reason = reasonFor(`${kind === 'selection' ? 'Select active provider' : 'Set fallback'} for ${capability.capability}`);
    if (!reason || !window.confirm(`Confirm ${kind === 'selection' ? 'active provider' : 'fallback'} change for ${capability.capability}?`)) return;
    void mutate(`/admin/integrations/capabilities/${encodeURIComponent(capability.capability)}/${kind}`,
      capability.version, { provider, reason }, `${capability.capability} ${kind}`);
  }

  return <section className="integrations-page">
    <header className="page-head"><p className="eyebrow">Settings</p><h1>Integrations</h1>
      <p>Control approved providers and capability routing. Credential values stay in the external secret store.</p></header>
    {error && <div className="error" role="alert"><span>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}
    {notice && <p className="integration-notice" role="status">{notice}</p>}
    {loading && !catalog && <p role="status">Loading integrations…</p>}
    {catalog && <>
      <div className="cards">{catalog.items.map((integration) => {
        const settings = Object.entries(safeConfiguration(integration.provider, integration.configuration));
        const fields = configurationFields[integration.provider] ?? [];
        const current = editing === integration.provider;
        const pending = busy !== null;
        return <article className="card integration-card" key={integration.provider}>
          <header><div><h2>{integration.name}</h2><small>{integration.capabilities.join(', ') || 'No runtime capability'}</small></div>
            <div className="integration-badges"><span className={`status status-${integration.enabled ? 'active' : 'disabled'}`}>{integration.enabled ? 'Enabled' : 'Paused'}</span>
              <span className={`status status-${integration.health}`}>{integration.health}</span></div></header>
          <dl><dt>Active for</dt><dd>{integration.activeCapabilities.length ? integration.activeCapabilities.join(', ') : 'Inactive'}</dd>
            <dt>Last tested</dt><dd>{date(integration.lastTestedAt)}</dd>
            <dt>Last successful test</dt><dd>{date(integration.lastSuccessfulTestAt)}</dd>
            <dt>Last failed test</dt><dd>{date(integration.lastFailedTestAt)}</dd>
            <dt>Credential</dt><dd>{credentialState(integration)}</dd>
            <dt>Configuration</dt><dd>{settings.length ? settings.map(([key, value]) =>
              <span className="integration-setting" key={key}>{settingName(key)}: {String(value ?? 'Unset')}</span>) : 'No dashboard settings'}</dd></dl>
          <div className="actions integration-actions">
            <button disabled={pending || !canManage || !action(integration, 'configure') || fields.length === 0}
              onClick={() => void configure(integration)}>Configure</button>
            <button disabled={pending || !canManage || integration.enabled || !action(integration, 'enable')}
              onClick={() => transition(integration, 'enable')}>Enable</button>
            <button className="danger" disabled={pending || !canManage || !integration.enabled || !action(integration, 'pause')}
              onClick={() => transition(integration, 'pause')}>Pause</button>
            <button disabled={pending || !canTest || !action(integration, 'test')}
              onClick={() => void test(integration)}>Test Connection</button>
            <button disabled={pending || !canManage || !integration.credential?.rotationSupported || !action(integration, 'credential-reference')}
              onClick={() => rotateCredential(integration)}>Rotate Credential</button>
            <button disabled={pending || !action(integration, 'audit')} onClick={() => void showAudit(integration)}>View Audit History</button>
          </div>
          {current && <form className="integration-form" onSubmit={(event) => saveConfiguration(event, integration)}>
            <h3>Configure {integration.name}</h3>
            {fields.map((field) => <label key={field.key}>{field.label}
              {field.kind === 'select'
                ? <select value={String(draft[field.key] ?? '')} onChange={(event) => setDraft((old) => ({ ...old, [field.key]: event.target.value }))}>
                  <option value="">Unset</option>{field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select>
                : <input type={field.kind === 'email' ? 'email' : 'text'} value={String(draft[field.key] ?? '')} maxLength={120}
                  onChange={(event) => setDraft((old) => ({ ...old, [field.key]: event.target.value }))} />}</label>)}
            <div className="actions"><button className="primary" type="submit">Save configuration</button>
              <button type="button" onClick={() => setEditing(null)}>Cancel</button></div>
          </form>}
        </article>;
      })}</div>
      {catalog.capabilities.length > 0 && <section className="integration-routing"><h2>Capability routing</h2>
        <p>Only approved providers for each capability are available here.</p>
        <div className="cards">{catalog.capabilities.map((capability) => <RoutingCard key={capability.capability}
          capability={capability} providers={catalog.items} busy={busy !== null} canManage={canManage} onChange={route} />)}</div>
      </section>}
    </>}
    {auditProvider && <section className="card integration-audit" aria-label="Integration audit history">
      <header><h2>Audit history · {catalog?.items.find((item) => item.provider === auditProvider)?.name ?? auditProvider}</h2>
        <button onClick={() => setAuditProvider(null)}>Close</button></header>
      {audit.length ? <ul>{audit.map((item) => <li key={item.eventId}><strong>{item.action}</strong> · {date(item.occurredAt)} · {item.outcome}
        {item.capability && <span> · {settingName(item.capability)}</span>}
        {item.reason && <span> · {item.reason}</span>}
        <small> Actor {item.actorAccountId} · Correlation {item.correlationId}</small></li>)}</ul> : <p>No audit events recorded.</p>}
    </section>}
  </section>;
}

function RoutingCard({ capability, providers, busy, canManage, onChange }: {
  capability: CapabilityRouting;
  providers: ProviderIntegration[];
  busy: boolean;
  canManage: boolean;
  onChange: (capability: CapabilityRouting, kind: 'selection' | 'fallback', provider: string | null) => void;
}) {
  const [active, setActive] = useState(capability.activeProvider ?? '');
  const [fallback, setFallback] = useState(capability.fallbackProvider ?? '');
  useEffect(() => { setActive(capability.activeProvider ?? ''); setFallback(capability.fallbackProvider ?? ''); },
    [capability.version, capability.activeProvider, capability.fallbackProvider]);
  const eligible = capability.eligibleProviders.filter((provider) => providers.some((item) =>
    item.provider === provider && item.capabilities.includes(capability.capability)));
  const selectable = eligible.filter((provider) => {
    const item = providers.find((candidate) => candidate.provider === provider);
    return item?.enabled && item.credential?.state !== 'missing';
  });
  const providerLabel = (provider: string) => providers.find((item) => item.provider === provider)?.name ?? provider;
  const activeAction = providers.some((item) => selectable.includes(item.provider) && action(item, 'select'));
  const fallbackAction = providers.some((item) => selectable.includes(item.provider) && action(item, 'fallback'));
  const unsaved = active !== (capability.activeProvider ?? '') || fallback !== (capability.fallbackProvider ?? '');
  return <article className="card integration-routing-card"><h3>{settingName(capability.capability)}</h3>
    {unsaved && <p role="status">Unsaved routing choice. Current active provider: {providerLabel(capability.activeProvider ?? '')};
      current fallback: {capability.fallbackProvider ? providerLabel(capability.fallbackProvider) : 'none'}.</p>}
    <label>Active provider<select aria-label={`${capability.capability} active provider`} value={active} onChange={(event) => setActive(event.target.value)}
      disabled={busy || !canManage || !activeAction}>
      <option value="">No active provider</option>{eligible.map((provider) => <option key={provider} value={provider}
        disabled={!selectable.includes(provider)}>{providerLabel(provider)}</option>)}</select></label>
    <button disabled={busy || !canManage || !activeAction || !active || active === capability.activeProvider}
      onClick={() => onChange(capability, 'selection', active)}>Select active provider</button>
    <label>Fallback provider<select aria-label={`${capability.capability} fallback provider`} value={fallback} onChange={(event) => setFallback(event.target.value)}
      disabled={busy || !canManage || !fallbackAction}>
      <option value="">No fallback</option>{eligible.map((provider) => <option key={provider} value={provider}
        disabled={!selectable.includes(provider) || provider === active}>{providerLabel(provider)}</option>)}</select></label>
    <button disabled={busy || !canManage || !fallbackAction || fallback === capability.fallbackProvider || fallback === active}
      onClick={() => onChange(capability, 'fallback', fallback || null)}>Save fallback</button>
    {unsaved && <button type="button" disabled={busy} onClick={() => {
      setActive(capability.activeProvider ?? ''); setFallback(capability.fallbackProvider ?? '');
    }}>Reset choices</button>}
  </article>;
}
