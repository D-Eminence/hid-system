import React, { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { getIdentityActorContext, identityClient, safeSignOut, type IdentityActorContext, type IdentityFacilityAssignment } from '@hid/identity-browser-client'
import { useConnectivity } from '@hid/offline'
import { captureProductEvent, captureSafeException } from '@hid/telemetry'
import { Badge, Button, Card, Input, Spinner } from '@hid/ui'
import { Layout } from '@hid/ui/Layout'
import { Turnstile } from '@hid/ui/Turnstile'
import { SyncStatus } from '@hid/ui/Offline'
import type { OcrExtraction, OcrJob, OcrPublicationResult, OcrValidation } from '@hid/api-client'
import { createOcrApi, OcrBrowserProblem } from './lib/ocrApi'
import { extractionSummary, publicationTruth, retryAllowed } from './lib/presentation'

function ocrFacility(actor: IdentityActorContext): IdentityFacilityAssignment | null {
  const facilities = actor.facilities.filter(facility => facility.permissions.includes('ocr.job.read'))
  return facilities.find(facility => facility.isPrimary) ?? facilities[0] ?? null
}

export default function App() {
  const [auth, setAuth] = useState<{ loading: boolean; actor: IdentityActorContext | null; facility: IdentityFacilityAssignment | null; error: string }>({ loading: true, actor: null, facility: null, error: '' })
  useEffect(() => {
    let active = true
    void getIdentityActorContext().then(actor => {
      if (!active) return
      if (!actor) return setAuth({ loading: false, actor: null, facility: null, error: '' })
      const facility = ocrFacility(actor)
      setAuth({ loading: false, actor, facility, error: facility ? '' : 'Your Identity account has no OCR operations permission at an active facility.' })
    }).catch(error => active && setAuth({ loading: false, actor: null, facility: null, error: error instanceof Error ? error.message : 'Identity session could not be restored.' }))
    return () => { active = false }
  }, [])
  if (auth.loading) return <Layout title="OCR Operations" subtitle="Restoring secure Identity session…"><div style={{ padding: 64, textAlign: 'center' }}><Spinner /></div></Layout>
  if (!auth.actor) return <HostLogin />
  if (!auth.facility) return <Layout title="OCR Operations" subtitle="Access denied"><Card><h2>OCR operations is unavailable</h2><p role="alert" style={{ color: 'var(--color-error)' }}>{auth.error}</p><Button variant="secondary" onClick={() => void safeSignOut().finally(() => window.location.assign('/'))}>Sign out</Button></Card></Layout>
  return <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}><OcrWorkspace actor={auth.actor} facility={auth.facility} /></BrowserRouter>
}

function HostLogin() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [token, setToken] = useState<string | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setLoading(true); setError(''); try {
    const result = await identityClient.auth.signInWithPassword({ email: email.trim().toLowerCase(), password,
      options: { captchaToken: token ?? undefined, captchaAction: 'ocr-login' } })
    if (result.error) throw result.error
    window.location.reload()
  } catch (caught) { setError(caught instanceof Error ? caught.message : 'Sign-in failed.') } finally { setLoading(false) } }
  return <Layout title="OCR Operations" subtitle="Identity sign-in required"><Card><h2>Sign in to OCR Operations</h2><p>This host receives its own secure Identity session cookie. No credentials are shared through browser storage.</p><form onSubmit={submit} style={{ display: 'grid', gap: 14 }}><Input label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} /><Input label="Password" type="password" value={password} onChange={event => setPassword(event.target.value)} /><Turnstile action="ocr-login" onTokenChange={setToken} />{error && <p role="alert" style={{ color: 'var(--color-error)' }}>{error}</p>}<Button type="submit" loading={loading}>Sign in</Button></form></Card></Layout>
}

function OcrWorkspace({ actor, facility }: { actor: IdentityActorContext; facility: IdentityFacilityAssignment }) {
  const api = useMemo(() => createOcrApi(facility.id), [facility.id])
  const { online } = useConnectivity()
  useEffect(() => captureProductEvent('workspace_opened', { workspace: 'ocr', offline: !online }), [])
  return <Layout title="OCR Operations" subtitle={`${facility.name} · ${actor.displayName ?? 'Authorized OCR user'}`}>
    <nav className="ocr-nav" aria-label="OCR workspace"><NavLink to="/" end><Button size="sm" variant="secondary">Dashboard</Button></NavLink><NavLink to="/jobs"><Button size="sm" variant="secondary">Jobs</Button></NavLink><NavLink to="/document-processing"><Button size="sm" variant="secondary">Document processing</Button></NavLink><Button size="sm" variant="ghost" onClick={() => void safeSignOut().finally(() => window.location.assign('/'))}>Sign out</Button></nav>
    {!online && <div className="ocr-safe"><SyncStatus status="offline" /> OCR execution, retry, validation, and publication are not simulated offline.</div>}
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/jobs" element={<JobLookup api={api} online={online} />} />
      <Route path="/jobs/:jobId" element={<JobDetail api={api} online={online} permissions={facility.permissions} />} />
      <Route path="/document-processing" element={<DocumentProcessing api={api} online={online} permissions={facility.permissions} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </Layout>
}

function Dashboard() {
  return <div className="ocr-grid"><Card><h2>Digitization operations</h2><p>Register exact clean document references, inspect actual job lifecycle, retry eligible failures, and monitor validation/publication evidence.</p></Card><div className="ocr-metrics"><div className="ocr-metric"><span>Global queue</span><strong>Not exposed</strong></div><div className="ocr-metric"><span>Provider readiness</span><strong>Not claimed</strong></div><div className="ocr-metric"><span>Clinical review</span><strong>HID EHR</strong></div></div><Card><p className="ocr-safe">The current OCR API supports exact document/job lookup, not a global queue aggregate. Worker/provider state is intentionally not fabricated. Clinical source-text correction and patient-context publication remain in EHR.</p></Card></div>
}

type OcrApi = ReturnType<typeof createOcrApi>

function JobLookup({ api, online }: { api: OcrApi; online: boolean }) {
  const [documentId, setDocumentId] = useState('')
  const [jobId, setJobId] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const find = async () => { setError(''); if (!online) return setError('Reconnect to query authoritative OCR job state.'); try { const job = await api.findJob(documentId.trim()); if (!job) return setError('No OCR job exists for that exact document reference.'); navigate(`/jobs/${job.id}`) } catch (caught) { setError(caught instanceof Error ? caught.message : 'OCR job lookup failed.') } }
  return <Card><h2>Exact job lookup</h2><p>No global processing queue endpoint exists. Use an exact non-PHI document or job UUID.</p><div className="ocr-form"><Input label="Document identifier" value={documentId} onChange={event => setDocumentId(event.target.value)} /><Button disabled={!documentId.trim() || !online} onClick={() => void find()}>Find by document</Button><Input label="Job identifier" value={jobId} onChange={event => setJobId(event.target.value)} /><Button disabled={!jobId.trim()} onClick={() => navigate(`/jobs/${jobId.trim()}`)}>Open job</Button></div>{error && <p role="alert" style={{ color: 'var(--color-error)' }}>{error}</p>}</Card>
}

function DocumentProcessing({ api, online, permissions }: { api: OcrApi; online: boolean; permissions: string[] }) {
  const [documentId, setDocumentId] = useState('')
  const [provider, setProvider] = useState('provider-neutral')
  const [message, setMessage] = useState('')
  const navigate = useNavigate()
  const create = async () => {
    if (!online) return setMessage('Document capture metadata is not queued by this API. Reconnect before creating the server OCR job.')
    setMessage('')
    try { const job = await api.createJob({ documentId: documentId.trim(), provider: provider.trim(), purpose: 'healthcare-operations' }, crypto.randomUUID()); captureProductEvent('ocr_job_created', { workspace: 'ocr', result: 'server_confirmed', offline: false }); navigate(`/jobs/${job.id}`) }
    catch (caught) { setMessage(caught instanceof Error ? caught.message : 'OCR job could not be created.') }
  }
  const authorized = permissions.includes('ocr.job.write')
  return <Card><h2>Document processing</h2><p>Creates a real OCR job for an existing secured document reference. It does not upload a file, create a patient, or simulate provider success.</p><div className="ocr-form"><Input label="Clean document identifier" value={documentId} onChange={event => setDocumentId(event.target.value)} /><Input label="Configured provider" value={provider} onChange={event => setProvider(event.target.value)} /><Button disabled={!authorized || !online || !documentId.trim() || !provider.trim()} onClick={() => void create()}>Create OCR job</Button></div>{!authorized && <p role="alert">Your facility role can read OCR jobs but cannot create them.</p>}{message && <p role="status">{message}</p>}</Card>
}

function JobDetail({ api, online, permissions }: { api: OcrApi; online: boolean; permissions: string[] }) {
  const { jobId = '' } = useParams()
  const [job, setJob] = useState<OcrJob | null>(null)
  const [extractions, setExtractions] = useState<OcrExtraction[]>([])
  const [validations, setValidations] = useState<OcrValidation[]>([])
  const [publications, setPublications] = useState<OcrPublicationResult[]>([])
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = async () => {
    if (!online) return setError('Offline: current authoritative OCR state cannot be refreshed.')
    setLoading(true); setError('')
    try {
      const nextJob = await api.getJob(jobId)
      const [nextExtractions, nextValidations] = await Promise.all([api.listExtractions(jobId), api.listValidations(jobId)])
      const latestValidation = nextValidations.at(-1)
      const nextPublications = latestValidation ? await api.listPublications(latestValidation.id) : []
      setJob(nextJob); setExtractions(nextExtractions); setValidations(nextValidations); setPublications(nextPublications)
      captureProductEvent('ocr_job_opened', { workspace: 'ocr', status: nextJob.status, offline: false })
    } catch (caught) {
      const problem = caught instanceof OcrBrowserProblem ? caught : null
      captureSafeException(caught, { app: 'ocr', operation: 'job_load', error_code: problem?.code ?? 'client_error', correlation_id: problem?.correlationId ?? undefined })
      setError(caught instanceof Error ? caught.message : 'OCR job could not be loaded.')
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [jobId])
  const retry = async () => {
    if (!job || reason.trim().length < 8) return setError('Enter a retry reason of at least 8 characters.')
    setLoading(true); setError('')
    try { await api.retryJob(job.id, { expectedVersion: job.version, reason: reason.trim(), purpose: 'healthcare-operations' }); captureProductEvent('ocr_job_retry_requested', { workspace: 'ocr', result: 'server_confirmed', retry_count_bucket: String(job.attemptCount) }); await load() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'OCR retry failed.') }
    finally { setLoading(false) }
  }
  return <div className="ocr-grid"><Card><div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><div><h2>OCR job</h2>{job && <><Badge>{job.status}</Badge><p>Provider: {job.provider} · attempt {job.attemptCount} of {job.maxAttempts} · version {job.version}</p><p>Patient association: {job.patientConfirmation ? 'governed confirmation recorded' : 'not confirmed'}</p></>}</div><Button loading={loading} onClick={() => void load()}>Refresh</Button></div>{error && <p role="alert" style={{ color: 'var(--color-error)' }}>{error}</p>}{job && retryAllowed(job, online, permissions) && <div className="ocr-form"><Input label="Retry reason" value={reason} onChange={event => setReason(event.target.value)} /><Button onClick={() => void retry()}>Retry failed job</Button></div>}</Card><Card><h3>Extraction evidence</h3><p className="ocr-safe">Raw OCR text and structured clinical payloads are intentionally not rendered or emitted by this operations view. Clinical review remains in EHR.</p>{extractions.map(extraction => { const summary = extractionSummary(extraction); return <div className="ocr-row" key={extraction.id}>Extraction v{summary.version} · attempt {summary.attempt} · {summary.provider} · confidence {summary.confidence ?? 'not supplied'}</div> })}{extractions.length === 0 && <p>No extraction exists.</p>}</Card><Card><h3>Validation state</h3>{validations.map(validation => <div className="ocr-row" key={validation.id}><Badge>{validation.disposition}</Badge> {validation.targetDomain} · {validation.candidateType} · version {validation.version}</div>)}{validations.length === 0 && <p>Awaiting human validation. Contextual review remains in EHR.</p>}</Card><Card><h3>Publication state</h3>{publications.map(publication => <div className="ocr-row" key={publication.id}><Badge>{publication.status}</Badge> {publication.targetDomain} · {publication.targetOperation}<div>{publicationTruth(publication)}</div>{publication.failureCode && <div>Safe failure code: {publication.failureCode}</div>}</div>)}{publications.length === 0 && <p>{publicationTruth(null)}</p>}</Card></div>
}
