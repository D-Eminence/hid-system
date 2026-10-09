import React, { useEffect, useMemo, useState } from 'react'
import { AdminLayout, type AdminSidebarSection } from '../../components/AdminLayout'
import { Badge, Button, EmptyState, Input, Modal, PageLoader, Select, showToast } from '../../components/ui'
import { ADMIN_BILLING_PATH, ADMIN_LOGIN_PATH, ADMIN_OVERVIEW_PATH } from '../../lib/adminRoutes'
import { signOutAndClearSessions } from '../../lib/auth'
import { getSafeUser } from '../../lib/identityClient'
import { fetchAdminAiProcessing, runAdminAiProcessingAction } from '../../services/adminDashboard'
import type {
  AdminAiModel,
  AdminAiProcessingOverview,
  AdminAiProvider,
  AdminAiWorkload,
} from '../../types/admin'

const sections: AdminSidebarSection[] = [
  { id: 'dashboard', label: 'Dashboard', href: ADMIN_OVERVIEW_PATH },
  { id: 'billing', label: 'Billing', href: ADMIN_BILLING_PATH },
  { id: 'migrate-overview', label: 'HID Migrate' },
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'usage', label: 'Usage' },
  { id: 'processing-health', label: 'Health' },
  { id: 'cost-budget', label: 'Cost & Budget' },
  { id: 'routing', label: 'Settings' },
]

const workloadLabels: Record<AdminAiWorkload, string> = {
  ocr: 'OCR',
  handwriting_recognition: 'Handwriting Recognition',
  document_classification: 'Document Classification',
  structured_data_extraction: 'Structured Data Extraction',
  clinical_entity_extraction: 'Clinical Entity Extraction',
  document_summarization: 'Document Summarization',
  patient_matching_assistance: 'Patient Matching Assistance',
  image_understanding: 'Image Understanding',
}

const providerTypes = [
  { value: 'nvidia', label: 'NVIDIA' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'other', label: 'Other compatible provider' },
]

const providerKinds = [
  { value: 'ocr', label: 'OCR provider' },
  { value: 'ai', label: 'AI processing provider' },
  { value: 'multimodal', label: 'Multimodal provider' },
  { value: 'compatible', label: 'Compatible provider' },
]

const panel: React.CSSProperties = {
  background: '#fff',
  border: '1px solid var(--admin-border)',
  borderRadius: 12,
  padding: 16,
  boxShadow: 'var(--admin-shadow)',
}

const grid = (min = 210): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
  gap: 12,
})

function compact(value: number | null | undefined) {
  if (value == null) return 'Not provided'
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function money(value: number | null | undefined, currency = 'USD') {
  if (value == null) return 'Not provided'
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value / 100)
}

function duration(value: number | null | undefined) {
  if (value == null) return 'Not provided'
  return `${Math.round(value)} ms`
}

function dateTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : 'Never'
}

function label(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, match => match.toUpperCase())
}

function Metric({ title, value, helper }: { title: string; value: React.ReactNode; helper?: string }) {
  return (
    <div style={{ ...panel, padding: 14 }}>
      <div style={{ color: 'var(--admin-muted)', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{title}</div>
      <div style={{ color: 'var(--admin-text)', fontSize: 22, fontWeight: 800, marginTop: 7 }}>{value}</div>
      {helper && <div style={{ color: 'var(--admin-muted)', fontSize: 11, marginTop: 5, lineHeight: 1.45 }}>{helper}</div>}
    </div>
  )
}

function SectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h2 style={{ margin: 0, fontSize: 17, color: 'var(--admin-text)' }}>{title}</h2>
      <p style={{ margin: '5px 0 0', color: 'var(--admin-muted)', fontSize: 12, lineHeight: 1.55 }}>{description}</p>
    </div>
  )
}

const emptyProvider = {
  provider_id: '',
  name: '',
  provider_type: 'anthropic',
  provider_kind: 'ai',
  api_base_url: '',
  api_version: '',
  organization_reference: '',
  project_reference: '',
  request_timeout_ms: '30000',
  max_retry_count: '3',
  priority: '100',
  status: 'active',
  api_key: '',
}

const emptyModel = {
  model_config_id: '',
  provider_id: '',
  display_name: '',
  model_id: '',
  model_version: '',
  purposes: ['structured_data_extraction'] as AdminAiWorkload[],
  status: 'active',
  priority: '100',
  input_cost_per_million_minor: '',
  output_cost_per_million_minor: '',
  page_cost_minor: '',
  currency: 'USD',
}

export default function AdminAiProcessing() {
  const [data, setData] = useState<AdminAiProcessingOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewer, setViewer] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState('migrate-overview')
  const [searchQuery, setSearchQuery] = useState('')
  const [providerOpen, setProviderOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [providerForm, setProviderForm] = useState(emptyProvider)
  const [modelForm, setModelForm] = useState(emptyModel)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [budget, setBudget] = useState({ scope: 'platform', target: '', amount: '', warning: '80', critical: '95', block: false })

  async function load(force = false) {
    if (force) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      setData(await fetchAdminAiProcessing())
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'AI processing data could not be loaded.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void getSafeUser().then(user => setViewer(user?.email ?? null))
    void load()
  }, [])

  useEffect(() => {
    const onScroll = () => {
      const visible = [...sections].reverse().find(section => {
        if (section.href) return false
        return (document.getElementById(section.id)?.getBoundingClientRect().top ?? Infinity) <= 180
      })
      if (visible) setActiveSection(visible.id)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const filteredProviders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return (data?.providers ?? []).filter(provider => !query || [
      provider.name, provider.provider_type, provider.provider_kind, provider.status,
    ].some(value => value.toLowerCase().includes(query)))
  }, [data?.providers, searchQuery])

  function editProvider(provider: AdminAiProvider) {
    setProviderForm({
      provider_id: provider.id,
      name: provider.name,
      provider_type: provider.provider_type,
      provider_kind: provider.provider_kind,
      api_base_url: provider.api_base_url ?? '',
      api_version: provider.api_version ?? '',
      organization_reference: provider.organization_reference ?? '',
      project_reference: provider.project_reference ?? '',
      request_timeout_ms: `${provider.request_timeout_ms}`,
      max_retry_count: `${provider.max_retry_count}`,
      priority: `${provider.priority}`,
      status: provider.status,
      api_key: '',
    })
    setProviderOpen(true)
  }

  async function saveProvider() {
    const existingProvider = data?.providers.find(provider => provider.id === providerForm.provider_id)
    const confirmDisable = providerForm.status === 'disabled' && existingProvider?.status !== 'disabled'
      ? window.confirm('Disabling this provider affects new routing decisions. Existing jobs retain their pinned configuration and may still require this credential to finish. Continue?')
      : false
    if (providerForm.status === 'disabled' && existingProvider?.status !== 'disabled' && !confirmDisable) return
    setSaving(true)
    try {
      await runAdminAiProcessingAction('save_provider', {
        ...providerForm,
        request_timeout_ms: Number(providerForm.request_timeout_ms),
        max_retry_count: Number(providerForm.max_retry_count),
        priority: Number(providerForm.priority),
        api_key: providerForm.api_key || undefined,
        confirm_disable: confirmDisable,
      })
      showToast(providerForm.provider_id ? 'Provider configuration updated.' : 'Provider added securely.', 'success')
      setProviderOpen(false)
      setProviderForm(emptyProvider)
      await load(true)
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Provider could not be saved.', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function testProvider(provider: AdminAiProvider) {
    setTestingId(provider.id)
    try {
      const response = await runAdminAiProcessingAction<{ message: string }>('test_connection', { provider_id: provider.id })
      showToast(response.message, 'success')
      await load(true)
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Connection test failed.', 'error')
    } finally {
      setTestingId(null)
    }
  }

  async function removeKey(provider: AdminAiProvider) {
    if (!window.confirm(`Remove the stored credential for ${provider.name}? Processing assigned to this provider may fail until a new key is supplied.`)) return
    try {
      await runAdminAiProcessingAction('remove_provider_key', { provider_id: provider.id })
      showToast('The provider credential was removed.', 'success')
      await load(true)
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'The key could not be removed.', 'error')
    }
  }

  function editModel(model: AdminAiModel) {
    setModelForm({
      model_config_id: model.id,
      provider_id: model.provider_id,
      display_name: model.display_name,
      model_id: model.model_id,
      model_version: model.model_version ?? '',
      purposes: model.purposes,
      status: model.status,
      priority: `${model.priority}`,
      input_cost_per_million_minor: model.input_cost_per_million_minor == null ? '' : `${model.input_cost_per_million_minor}`,
      output_cost_per_million_minor: model.output_cost_per_million_minor == null ? '' : `${model.output_cost_per_million_minor}`,
      page_cost_minor: model.page_cost_minor == null ? '' : `${model.page_cost_minor}`,
      currency: model.currency,
    })
    setModelOpen(true)
  }

  async function saveModel() {
    const existingModel = data?.models.find(model => model.id === modelForm.model_config_id)
    const confirmDisable = modelForm.status === 'disabled' && existingModel?.status !== 'disabled'
      ? window.confirm('Disabling this model affects new routing decisions. Existing jobs retain their pinned model and configuration version. Continue?')
      : false
    if (modelForm.status === 'disabled' && existingModel?.status !== 'disabled' && !confirmDisable) return
    setSaving(true)
    try {
      await runAdminAiProcessingAction('save_model', {
        ...modelForm,
        priority: Number(modelForm.priority),
        input_cost_per_million_minor: modelForm.input_cost_per_million_minor === '' ? null : Number(modelForm.input_cost_per_million_minor),
        output_cost_per_million_minor: modelForm.output_cost_per_million_minor === '' ? null : Number(modelForm.output_cost_per_million_minor),
        page_cost_minor: modelForm.page_cost_minor === '' ? null : Number(modelForm.page_cost_minor),
        confirm_disable: confirmDisable,
      })
      showToast(modelForm.model_config_id ? 'Model updated.' : 'Model added.', 'success')
      setModelOpen(false)
      setModelForm(emptyModel)
      await load(true)
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Model could not be saved.', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function updateRoute(workload: AdminAiWorkload, field: string, value: string | null) {
    const route = data?.routes.find(item => item.workload === workload)
    if (!route) return
    const queued = data?.processing.queued ?? 0
    if (queued && !window.confirm(`${compact(queued)} jobs are currently queued. New jobs will use the replacement; existing jobs retain their pinned provider, model, and configuration version. Continue?`)) return
    try {
      const response = await runAdminAiProcessingAction<{ queued_jobs_unchanged: number }>('save_route', {
        workload,
        processing_strategy: route.processing_strategy,
        primary_model_id: route.primary_model_id,
        fallback_model_id: route.fallback_model_id,
        [field]: value || null,
      })
      showToast(response.queued_jobs_unchanged
        ? `Route updated. ${compact(response.queued_jobs_unchanged)} queued jobs remain unchanged.`
        : 'Processing route updated.', 'success')
      await load(true)
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Route could not be changed.', 'error')
    }
  }

  async function saveBudget() {
    try {
      await runAdminAiProcessingAction('save_budget', {
        scope_type: budget.scope,
        provider_id: budget.scope === 'provider' ? budget.target : undefined,
        migration_project_id: budget.scope === 'project' ? budget.target : undefined,
        monthly_budget_minor: Math.round(Number(budget.amount) * 100),
        warning_threshold_percent: Number(budget.warning),
        critical_threshold_percent: Number(budget.critical),
        block_non_critical: budget.block,
        currency: 'USD',
      })
      showToast('Monthly AI budget controls updated.', 'success')
      await load(true)
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Budget could not be saved.', 'error')
    }
  }

  async function retryJob(jobId: string) {
    if (!window.confirm('Retry this dead-letter job using its pinned provider, model, and configuration version?')) return
    try {
      await runAdminAiProcessingAction('retry_job', { job_id: jobId })
      showToast('The job was scheduled for a controlled retry.', 'success')
      await load(true)
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'The job could not be retried.', 'error')
    }
  }

  async function logout() {
    await signOutAndClearSessions()
    window.location.assign(ADMIN_LOGIN_PATH)
  }

  if (loading && !data) return <PageLoader label="Loading AI infrastructure..." />

  return (
    <AdminLayout
      activeSection={activeSection}
      darkMode={false}
      notificationsCount={data?.processing.dead_letter ?? 0}
      onLogout={() => { void logout() }}
      onSearchChange={setSearchQuery}
      onToggleTheme={() => undefined}
      searchQuery={searchQuery}
      sections={sections}
      title="AI & Processing"
      userName={viewer}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {error && (
          <div style={{ ...panel, borderColor: '#fecaca', background: '#fff7f7', color: '#b91c1c', fontSize: 12 }}>
            {error}
            <div style={{ marginTop: 10 }}><Button size="sm" variant="outline" onClick={() => { void load(true) }}>Retry</Button></div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 21 }}>AI & Processing Settings</h1>
            <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--admin-muted)', maxWidth: 720, lineHeight: 1.55 }}>
              Platform-wide provider routing, processing health, usage, and cost controls for HID Migrate. Credentials remain server-side and are never returned to this page.
            </p>
          </div>
          <Button size="sm" variant="outline" loading={refreshing} onClick={() => { void load(true) }}>Refresh live data</Button>
        </div>

        <section id="migrate-overview">
          <SectionTitle title="HID Migrate overview" description="A compact platform summary. Detailed provider, workload, organization, and project information appears below." />
          <div style={grid()}>
            <Metric title="Active projects" value={compact(data?.migrate.active_projects)} />
            <Metric title="Patients migrated" value={compact(data?.migrate.patients_migrated)} />
            <Metric title="Folders scanned" value={compact(data?.migrate.folders_scanned)} />
            <Metric title="Pages processed" value={compact(data?.migrate.pages_processed)} />
            <Metric title="Import success" value={`${(data?.migrate.import_success_rate ?? 0).toFixed(1)}%`} />
            <Metric title="AI spend this month" value={money(data?.migrate.estimated_processing_cost_minor)} />
          </div>
        </section>

        <section id="providers">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <SectionTitle title="Providers" description="OCR engines and AI processing providers are configured independently and may be combined through workload routing." />
            <Button size="sm" onClick={() => { setProviderForm(emptyProvider); setProviderOpen(true) }}>Add provider</Button>
          </div>
          {filteredProviders.length ? (
            <div style={grid(300)}>
              {filteredProviders.map(provider => {
                const connected = Boolean(provider.last_success_at) && (!provider.last_failure_at || new Date(provider.last_success_at!).getTime() > new Date(provider.last_failure_at).getTime())
                const assigned = data?.models.filter(model => model.provider_id === provider.id).flatMap(model => model.purposes) ?? []
                const todayUsage = data?.usage.today_by_provider.find(item => item.key === provider.id)
                return (
                  <article key={provider.id} style={panel}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 15 }}>{provider.name}</div>
                        <div style={{ color: 'var(--admin-muted)', fontSize: 11, marginTop: 3 }}>{label(provider.provider_kind)} · {label(provider.provider_type)}</div>
                      </div>
                      <Badge color={provider.status === 'active' && connected ? 'green' : provider.status === 'disabled' ? 'gray' : 'amber'}>
                        {provider.status === 'disabled' ? 'Disabled' : connected ? 'Connected' : 'Not confirmed'}
                      </Badge>
                    </div>
                    <dl style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '14px 0', fontSize: 11 }}>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Credential</dt><dd style={{ margin: '3px 0 0', fontFamily: 'JetBrains Mono, monospace' }}>{provider.api_key_masked ?? 'Not configured'}</dd></div>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Priority</dt><dd style={{ margin: '3px 0 0' }}>{provider.priority}</dd></div>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Last success</dt><dd style={{ margin: '3px 0 0' }}>{dateTime(provider.last_success_at)}</dd></div>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Last failure</dt><dd style={{ margin: '3px 0 0' }}>{dateTime(provider.last_failure_at)}</dd></div>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Average latency</dt><dd style={{ margin: '3px 0 0' }}>{duration(provider.average_latency_ms)}</dd></div>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Configuration</dt><dd style={{ margin: '3px 0 0' }}>v{provider.configuration_version}</dd></div>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Requests today</dt><dd style={{ margin: '3px 0 0' }}>{compact(todayUsage?.requests ?? 0)}</dd></div>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Estimated cost today</dt><dd style={{ margin: '3px 0 0' }}>{money(todayUsage?.estimated_cost_minor ?? 0)}</dd></div>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Rate limit remaining</dt><dd style={{ margin: '3px 0 0' }}>{todayUsage?.provider_quota?.rate_limit_remaining == null ? 'Not provided' : String(todayUsage.provider_quota.rate_limit_remaining)}</dd></div>
                      <div><dt style={{ color: 'var(--admin-muted)' }}>Rate-limit errors</dt><dd style={{ margin: '3px 0 0' }}>{compact(todayUsage?.rate_limited_requests ?? 0)}</dd></div>
                    </dl>
                    <div style={{ color: 'var(--admin-muted)', fontSize: 11, marginBottom: 12 }}>
                      Workloads: {[...new Set(assigned)].map(item => workloadLabels[item]).join(', ') || 'No workloads assigned'}
                    </div>
                    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                      <Button size="sm" variant="outline" onClick={() => editProvider(provider)}>Edit</Button>
                      <Button size="sm" variant="outline" loading={testingId === provider.id} onClick={() => { void testProvider(provider) }}>Test connection</Button>
                      {provider.has_api_key && <Button size="sm" variant="ghost" onClick={() => { void removeKey(provider) }}>Remove key</Button>}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : <div style={panel}><EmptyState icon={<span aria-hidden="true">AI</span>} title="No providers configured" description="Add an OCR or AI processing provider. No connection state will be invented until a real test succeeds." /></div>}
        </section>

        <section id="models">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <SectionTitle title="Model management" description="Models carry their purposes, cost assumptions, status, and immutable configuration version used for new jobs." />
            <Button size="sm" disabled={!data?.providers.length} onClick={() => { setModelForm({ ...emptyModel, provider_id: data?.providers[0]?.id ?? '' }); setModelOpen(true) }}>Add model</Button>
          </div>
          <div style={{ ...panel, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860, fontSize: 11.5 }}>
              <thead><tr>{['Provider', 'Model', 'Purpose', 'Status', 'Priority', 'Usage cost', 'Last used', 'Actions'].map(item => <th key={item} style={{ textAlign: 'left', padding: 10, color: 'var(--admin-muted)', borderBottom: '1px solid var(--admin-border)' }}>{item}</th>)}</tr></thead>
              <tbody>
                {(data?.models ?? []).map(model => (
                  <tr key={model.id}>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}>{model.provider?.name ?? 'Unknown'}</td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}><strong>{model.display_name}</strong><div style={{ color: 'var(--admin-muted)', fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>{model.model_id}</div></td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}>{model.purposes.map(item => workloadLabels[item]).join(', ') || 'Unassigned'}</td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}><Badge color={model.status === 'active' ? 'green' : model.status === 'disabled' ? 'gray' : 'amber'}>{label(model.status)}</Badge></td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}>{model.priority}</td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}>{model.page_cost_minor != null ? `${money(model.page_cost_minor, model.currency)}/page` : model.input_cost_per_million_minor != null ? `${money(model.input_cost_per_million_minor, model.currency)}/1M input` : 'Not configured'}</td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}>{dateTime(model.last_used_at)}</td>
                    <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}><Button size="sm" variant="outline" onClick={() => editModel(model)}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="usage">
          <SectionTitle title="AI usage" description="Unavailable provider quotas are explicitly shown as not provided; HID never fabricates token balances or credits." />
          <div style={grid()}>
            <Metric title="Requests today" value={compact(data?.usage.today.requests)} />
            <Metric title="Requests this month" value={compact(data?.usage.month.requests)} />
            <Metric title="OCR pages processed" value={compact(data?.usage.month.pages_processed)} />
            <Metric title="Successful requests" value={compact(data?.usage.month.successful_requests)} />
            <Metric title="Failed requests" value={compact(data?.usage.month.failed_requests)} />
            <Metric title="Rate-limit errors" value={compact(data?.usage.month.rate_limited_requests ?? 0)} />
            <Metric title="Timeouts" value={compact(data?.usage.month.timed_out_requests ?? 0)} />
            <Metric title="Retry rate" value={`${data?.usage.month.requests ? (100 * data.usage.month.retries / data.usage.month.requests).toFixed(1) : '0.0'}%`} />
            <Metric title="Input tokens" value={compact(data?.usage.month.input_tokens)} />
            <Metric title="Output tokens" value={compact(data?.usage.month.output_tokens)} />
            <Metric title="Provider quota" value="Not provided by provider" helper={data?.usage.quota_note} />
          </div>
          <div style={{ ...grid(320), marginTop: 12 }}>
            <div style={panel}>
              <h3 style={{ margin: '0 0 10px', fontSize: 13 }}>Usage by provider</h3>
              {(data?.usage.by_provider ?? []).length ? data?.usage.by_provider.map(item => {
                const provider = data.providers.find(candidate => candidate.id === item.key)
                return <div key={item.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--admin-border)', fontSize: 11.5 }}><strong>{provider?.name ?? 'Provider not available'}</strong><span>{compact(item.requests)} requests</span><span>{money(item.estimated_cost_minor)}</span></div>
              }) : <div style={{ color: 'var(--admin-muted)', fontSize: 11.5 }}>No provider usage has been recorded this month.</div>}
            </div>
            <div style={panel}>
              <h3 style={{ margin: '0 0 10px', fontSize: 13 }}>Usage by workload</h3>
              {(data?.usage.by_workload ?? []).length ? data?.usage.by_workload.map(item => <div key={item.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--admin-border)', fontSize: 11.5 }}><strong>{workloadLabels[item.key as AdminAiWorkload] ?? label(item.key)}</strong><span>{compact(item.requests)} requests</span><span>{money(item.estimated_cost_minor)}</span></div>) : <div style={{ color: 'var(--admin-muted)', fontSize: 11.5 }}>No workload usage has been recorded this month.</div>}
            </div>
          </div>
          <div style={{ ...panel, marginTop: 12, overflowX: 'auto' }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 13 }}>Usage by migration project and organization</h3>
            <table style={{ width: '100%', minWidth: 1000, borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead><tr>{['Organization', 'Project', 'Pages', 'Requests', 'Tokens', 'Cost', 'Patients', 'Cost / page', 'Failed', 'Retries'].map(item => <th key={item} style={{ textAlign: 'left', padding: 9, color: 'var(--admin-muted)', borderBottom: '1px solid var(--admin-border)' }}>{item}</th>)}</tr></thead>
              <tbody>{(data?.usage.projects ?? []).map(project => <tr key={project.id}>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{project.organization_name ?? 'Not available'}</td>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}><strong>{project.name}</strong><div style={{ color: 'var(--admin-muted)' }}>{project.project_reference}</div></td>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{compact(project.pages_scanned)}</td>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{compact(project.requests)}</td>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{compact(project.input_tokens + project.output_tokens)}</td>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{money(project.estimated_cost_minor)}</td>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{compact(project.patients_migrated)}</td>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{money(project.cost_per_page_minor)}</td>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{project.failed_jobs}</td>
                <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{project.retrying_jobs}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>

        <section id="processing-health">
          <SectionTitle title="AI/OCR processing health" description="Queue health and failures are derived from durable jobs. Provider status is based on real connection results." />
          <div style={grid()}>
            <Metric title="Processing health" value={label(data?.processing.health ?? 'unknown')} />
            <Metric title="Jobs processing" value={compact(data?.processing.processing)} />
            <Metric title="Jobs waiting" value={compact(data?.processing.queued)} />
            <Metric title="Jobs retrying" value={compact(data?.processing.retrying)} />
            <Metric title="Dead-letter jobs" value={compact(data?.processing.dead_letter)} />
            <Metric title="Oldest queued job" value={dateTime(data?.processing.oldest_queued_at)} />
          </div>
          {(data?.processing.retrying ?? 0) > 0 && (
            <div style={{ ...panel, marginTop: 12, background: '#fffaf0', borderColor: '#fde68a', color: '#92400e', fontSize: 12 }}>
              Processing may be delayed because jobs are retrying. Review provider health, recent failures, credentials, and rate limits before manually retrying dead-letter work.
            </div>
          )}
          <div style={{ ...panel, marginTop: 12 }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 13 }}>Failure and review analytics</h3>
            <div style={grid()}>
              <Metric title="OCR failures" value={compact(data?.processing.failures.ocr)} />
              <Metric title="Classification failures" value={compact(data?.processing.failures.classification)} />
              <Metric title="Extraction failures" value={compact(data?.processing.failures.extraction)} />
              <Metric title="Provider errors" value={compact(data?.processing.failures.provider_errors)} />
              <Metric title="Low-confidence results" value={compact(data?.processing.failures.low_confidence_results)} />
              <Metric title="Sent for human review" value={compact(data?.processing.failures.human_review)} />
            </div>
            {(data?.processing.failed_jobs ?? []).length > 0 && (
              <div style={{ overflowX: 'auto', marginTop: 12 }}>
                <table style={{ width: '100%', minWidth: 650, borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead><tr>{['Job', 'Workload', 'Provider', 'Attempts', 'Queued', 'Action'].map(item => <th key={item} style={{ textAlign: 'left', padding: 9, color: 'var(--admin-muted)', borderBottom: '1px solid var(--admin-border)' }}>{item}</th>)}</tr></thead>
                  <tbody>{data?.processing.failed_jobs.map(job => <tr key={job.id}>
                    <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)', fontFamily: 'JetBrains Mono, monospace' }}>{job.id.slice(0, 8)}</td>
                    <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{label(job.job_type)}</td>
                    <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{job.provider ?? 'Not assigned'}</td>
                    <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{job.attempt_count}</td>
                    <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}>{dateTime(job.created_at)}</td>
                    <td style={{ padding: 9, borderBottom: '1px solid var(--admin-border)' }}><Button size="sm" variant="outline" onClick={() => { void retryJob(job.id) }}>Retry eligible job</Button></td>
                  </tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section id="cost-budget">
          <SectionTitle title="Cost & budget" description="Budget warnings inform platform operations. Critical healthcare processing is not stopped unless an explicit policy enables blocking of non-critical workloads." />
          <div style={grid()}>
            <Metric title="AI spend today" value={money(data?.usage.today.estimated_cost_minor)} />
            <Metric title="AI spend this month" value={money(data?.usage.month.estimated_cost_minor)} />
            <Metric title="Monthly AI budget" value={data?.budget ? money(data.budget.monthly_budget_minor) : 'Not configured'} />
            <Metric title="Remaining budget" value={data?.budget ? money(data.budget.remaining_minor) : 'Not configured'} />
            <Metric title="Average latency" value={duration(data?.usage.month.average_latency_ms)} />
          </div>
          <div style={{ ...panel, marginTop: 12 }}>
            <h3 style={{ fontSize: 13, margin: '0 0 12px' }}>Monthly budget controls</h3>
            <div style={grid()}>
              <Select label="Budget scope" value={budget.scope} options={[{ value: 'platform', label: 'Entire platform' }, { value: 'provider', label: 'Provider' }, { value: 'project', label: 'Migration project' }]} onChange={event => setBudget(current => ({ ...current, scope: event.target.value, target: '' }))} />
              {budget.scope === 'provider' && <Select label="Provider" value={budget.target} options={[{ value: '', label: 'Select provider' }, ...(data?.providers ?? []).map(provider => ({ value: provider.id, label: provider.name }))]} onChange={event => setBudget(current => ({ ...current, target: event.target.value }))} />}
              {budget.scope === 'project' && <Select label="Migration project" value={budget.target} options={[{ value: '', label: 'Select project' }, ...(data?.usage.projects ?? []).map(project => ({ value: project.id, label: `${project.project_reference} · ${project.name}` }))]} onChange={event => setBudget(current => ({ ...current, target: event.target.value }))} />}
              <Input label="Monthly budget (USD)" type="number" min="0" value={budget.amount} onChange={event => setBudget(current => ({ ...current, amount: event.target.value }))} />
              <Input label="Warning threshold (%)" type="number" min="1" max="100" value={budget.warning} onChange={event => setBudget(current => ({ ...current, warning: event.target.value }))} />
              <Input label="Critical threshold (%)" type="number" min="1" max="100" value={budget.critical} onChange={event => setBudget(current => ({ ...current, critical: event.target.value }))} />
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, fontSize: 11.5 }}>
              <input type="checkbox" checked={budget.block} onChange={event => setBudget(current => ({ ...current, block: event.target.checked }))} />
              Block only explicitly non-critical processing after the critical threshold
            </label>
            <div style={{ marginTop: 12 }}><Button size="sm" disabled={!budget.amount || (budget.scope !== 'platform' && !budget.target)} onClick={() => { void saveBudget() }}>Save budget controls</Button></div>
          </div>
        </section>

        <section id="routing">
          <SectionTitle title="Workload routing & processing strategy" description="Each workload may select a primary and fallback model. OCR engines remain distinct from AI processing providers, while direct multimodal extraction is supported explicitly." />
          <div style={{ ...panel, overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead><tr>{['Workload', 'Strategy', 'Primary', 'Fallback', 'Configuration'].map(item => <th key={item} style={{ textAlign: 'left', padding: 10, color: 'var(--admin-muted)', borderBottom: '1px solid var(--admin-border)' }}>{item}</th>)}</tr></thead>
              <tbody>{(data?.routes ?? []).map(route => (
                <tr key={route.workload}>
                  <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)', fontWeight: 700 }}>{workloadLabels[route.workload]}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}>
                    <select value={route.processing_strategy} onChange={event => { void updateRoute(route.workload, 'processing_strategy', event.target.value) }} style={{ padding: 7, borderRadius: 7, border: '1px solid var(--admin-border)' }}>
                      <option value="ocr_then_ai">OCR → AI processing</option>
                      <option value="direct_multimodal">Direct multimodal</option>
                    </select>
                  </td>
                  <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}>
                    <select value={route.primary_model_id ?? ''} onChange={event => { void updateRoute(route.workload, 'primary_model_id', event.target.value || null) }} style={{ padding: 7, borderRadius: 7, border: '1px solid var(--admin-border)', maxWidth: 240 }}>
                      <option value="">Not assigned</option>
                      {(data?.models ?? []).filter(model => model.status === 'active' && (model.purposes.length === 0 || model.purposes.includes(route.workload))).map(model => <option key={model.id} value={model.id}>{model.provider?.name} · {model.display_name}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}>
                    <select value={route.fallback_model_id ?? ''} onChange={event => { void updateRoute(route.workload, 'fallback_model_id', event.target.value || null) }} style={{ padding: 7, borderRadius: 7, border: '1px solid var(--admin-border)', maxWidth: 240 }}>
                      <option value="">No fallback</option>
                      {(data?.models ?? []).filter(model => model.id !== route.primary_model_id && model.status === 'active' && (model.purposes.length === 0 || model.purposes.includes(route.workload))).map(model => <option key={model.id} value={model.id}>{model.provider?.name} · {model.display_name}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: 10, borderBottom: '1px solid var(--admin-border)' }}>v{route.configuration_version}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </div>

      <Modal open={providerOpen} onClose={() => setProviderOpen(false)} title={providerForm.provider_id ? 'Edit provider' : 'Add provider'}>
        <div style={{ display: 'grid', gap: 12 }}>
          <Input label="Provider name" value={providerForm.name} onChange={event => setProviderForm(current => ({ ...current, name: event.target.value }))} />
          <div style={grid()}>
            <Select label="Provider type" value={providerForm.provider_type} options={providerTypes} onChange={event => setProviderForm(current => ({ ...current, provider_type: event.target.value }))} />
            <Select label="Service category" value={providerForm.provider_kind} options={providerKinds} onChange={event => setProviderForm(current => ({ ...current, provider_kind: event.target.value }))} />
          </div>
          <Input label="API base URL" placeholder="Uses provider default when supported" value={providerForm.api_base_url} onChange={event => setProviderForm(current => ({ ...current, api_base_url: event.target.value }))} />
          <div style={grid()}>
            <Input label="API version" value={providerForm.api_version} onChange={event => setProviderForm(current => ({ ...current, api_version: event.target.value }))} />
            <Input label="Organization / project ID" value={providerForm.project_reference} onChange={event => setProviderForm(current => ({ ...current, project_reference: event.target.value }))} />
          </div>
          <Input label={providerForm.provider_id ? 'Replace API key (leave blank to retain)' : 'API key'} type="password" autoComplete="new-password" value={providerForm.api_key} onChange={event => setProviderForm(current => ({ ...current, api_key: event.target.value }))} />
          <div style={grid()}>
            <Input label="Request timeout (ms)" type="number" value={providerForm.request_timeout_ms} onChange={event => setProviderForm(current => ({ ...current, request_timeout_ms: event.target.value }))} />
            <Input label="Maximum retries" type="number" value={providerForm.max_retry_count} onChange={event => setProviderForm(current => ({ ...current, max_retry_count: event.target.value }))} />
            <Input label="Priority" type="number" value={providerForm.priority} onChange={event => setProviderForm(current => ({ ...current, priority: event.target.value }))} />
          </div>
          <Select label="Status" value={providerForm.status} options={[{ value: 'active', label: 'Active' }, { value: 'degraded', label: 'Degraded' }, { value: 'disabled', label: 'Disabled' }]} onChange={event => setProviderForm(current => ({ ...current, status: event.target.value }))} />
          <div style={{ fontSize: 11, color: 'var(--admin-muted)', lineHeight: 1.5 }}>After saving, only a masked key is visible. The raw credential is encrypted by the backend and excluded from logs, audit metadata, browser storage, and API responses.</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button variant="outline" onClick={() => setProviderOpen(false)}>Cancel</Button><Button loading={saving} onClick={() => { void saveProvider() }}>Save provider</Button></div>
        </div>
      </Modal>

      <Modal open={modelOpen} onClose={() => setModelOpen(false)} title={modelForm.model_config_id ? 'Edit model' : 'Add model'}>
        <div style={{ display: 'grid', gap: 12 }}>
          <Select label="Provider" value={modelForm.provider_id} options={(data?.providers ?? []).map(provider => ({ value: provider.id, label: provider.name }))} onChange={event => setModelForm(current => ({ ...current, provider_id: event.target.value }))} />
          <div style={grid()}>
            <Input label="Model name" value={modelForm.display_name} onChange={event => setModelForm(current => ({ ...current, display_name: event.target.value }))} />
            <Input label="Model ID" value={modelForm.model_id} onChange={event => setModelForm(current => ({ ...current, model_id: event.target.value }))} />
          </div>
          <Input label="Model version" value={modelForm.model_version} onChange={event => setModelForm(current => ({ ...current, model_version: event.target.value }))} />
          <div style={grid()}>
            <Select label="Status" value={modelForm.status} options={[{ value: 'active', label: 'Active' }, { value: 'degraded', label: 'Degraded' }, { value: 'disabled', label: 'Disabled' }]} onChange={event => setModelForm(current => ({ ...current, status: event.target.value }))} />
            <Input label="Priority" type="number" value={modelForm.priority} onChange={event => setModelForm(current => ({ ...current, priority: event.target.value }))} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 7 }}>Usage purpose</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{Object.entries(workloadLabels).map(([value, text]) => <label key={value} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}><input type="checkbox" checked={modelForm.purposes.includes(value as AdminAiWorkload)} onChange={event => setModelForm(current => ({ ...current, purposes: event.target.checked ? [...current.purposes, value as AdminAiWorkload] : current.purposes.filter(item => item !== value) }))} />{text}</label>)}</div>
          </div>
          <div style={grid()}>
            <Input label="Input cost / 1M (minor units)" type="number" value={modelForm.input_cost_per_million_minor} onChange={event => setModelForm(current => ({ ...current, input_cost_per_million_minor: event.target.value }))} />
            <Input label="Output cost / 1M (minor units)" type="number" value={modelForm.output_cost_per_million_minor} onChange={event => setModelForm(current => ({ ...current, output_cost_per_million_minor: event.target.value }))} />
            <Input label="Cost / page (minor units)" type="number" value={modelForm.page_cost_minor} onChange={event => setModelForm(current => ({ ...current, page_cost_minor: event.target.value }))} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><Button variant="outline" onClick={() => setModelOpen(false)}>Cancel</Button><Button loading={saving} onClick={() => { void saveModel() }}>Save model</Button></div>
        </div>
      </Modal>
    </AdminLayout>
  )
}
