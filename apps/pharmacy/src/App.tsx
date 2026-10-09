import React, { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { getIdentityActorContext, identityClient, safeSignOut, type IdentityActorContext, type IdentityFacilityAssignment } from '@hid/identity-browser-client'
import { useConnectivity } from '@hid/offline'
import { captureProductEvent, captureSafeException } from '@hid/telemetry'
import { Badge, Button, Card, Input, Spinner } from '@hid/ui'
import { Layout } from '@hid/ui/Layout'
import { Turnstile } from '@hid/ui/Turnstile'
import { SyncStatus } from '@hid/ui/Offline'
import type { PharmacyImportedMedicationEvidence, PharmacyWorkItem } from '@hid/api-client'
import { canDispense, operationalState, patientReference, pharmacyMetrics } from './lib/domain'
import { createPharmacyApi, PharmacyApiProblem } from './lib/pharmacyApi'

function pharmacyFacility(actor: IdentityActorContext): IdentityFacilityAssignment | null {
  const facilities = actor.facilities.filter(facility => facility.permissions.includes('pharmacy.work-item.read'))
  return facilities.find(facility => facility.isPrimary) ?? facilities[0] ?? null
}

function problemMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export default function App() {
  const [auth, setAuth] = useState<{ loading: boolean; actor: IdentityActorContext | null; facility: IdentityFacilityAssignment | null; error: string }>({ loading: true, actor: null, facility: null, error: '' })
  useEffect(() => {
    let active = true
    void getIdentityActorContext().then(actor => {
      if (!active) return
      if (!actor) return setAuth({ loading: false, actor: null, facility: null, error: '' })
      const facility = pharmacyFacility(actor)
      setAuth({ loading: false, actor, facility, error: facility ? '' : 'Your Identity account has no Pharmacy work-queue permission at an active facility.' })
    }).catch(error => active && setAuth({ loading: false, actor: null, facility: null, error: problemMessage(error, 'Identity session could not be restored.') }))
    return () => { active = false }
  }, [])

  if (auth.loading) return <Layout title="Pharmacy" subtitle="Restoring secure Identity session…"><div style={{ padding: 64, textAlign: 'center' }}><Spinner /></div></Layout>
  if (!auth.actor) return <HostLogin />
  if (!auth.facility) return <Layout title="Pharmacy" subtitle="Access denied"><Card><h2>Pharmacy access is unavailable</h2><p role="alert" style={{ color: 'var(--color-error)' }}>{auth.error}</p><Button variant="secondary" onClick={() => void safeSignOut().finally(() => window.location.assign('/'))}>Sign out</Button></Card></Layout>
  return <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}><PharmacyWorkspace actor={auth.actor} facility={auth.facility} /></BrowserRouter>
}

function HostLogin() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [token, setToken] = useState<string | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false)
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setLoading(true); setError(''); try {
    const result = await identityClient.auth.signInWithPassword({ email: email.trim().toLowerCase(), password,
      options: { captchaToken: token ?? undefined, captchaAction: 'pharmacy-login' } })
    if (result.error) throw result.error
    window.location.reload()
  } catch (caught) { setError(problemMessage(caught, 'Sign-in failed.')) } finally { setLoading(false) } }
  return <Layout title="Pharmacy" subtitle="Identity sign-in required"><Card><h2>Sign in to Pharmacy</h2><p>This host receives its own secure Identity session cookie. No credentials are shared through browser storage.</p><form onSubmit={submit} style={{ display: 'grid', gap: 14 }}><Input label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} /><Input label="Password" type="password" value={password} onChange={event => setPassword(event.target.value)} /><Turnstile action="pharmacy-login" onTokenChange={setToken} />{error && <p role="alert" style={{ color: 'var(--color-error)' }}>{error}</p>}<Button type="submit" loading={loading}>Sign in</Button></form></Card></Layout>
}

function PharmacyWorkspace({ actor, facility }: { actor: IdentityActorContext; facility: IdentityFacilityAssignment }) {
  const api = useMemo(() => createPharmacyApi(facility.id), [facility.id])
  const { online } = useConnectivity()
  const [items, setItems] = useState<PharmacyWorkItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    if (!online) { setError('Offline: previously loaded work remains visible in memory, but the authoritative Pharmacy queue cannot refresh.'); return }
    setLoading(true); setError('')
    try { setItems(await api.listWorkItems()) }
    catch (caught) { captureSafeException(caught, { app: 'pharmacy', operation: 'work_queue_load', error_code: caught instanceof PharmacyApiProblem ? String(caught.status) : 'client_error' }); setError(problemMessage(caught, 'Pharmacy queue could not be loaded.')) }
    finally { setLoading(false) }
  }
  useEffect(() => { captureProductEvent('workspace_opened', { workspace: 'pharmacy', offline: !online }); void load() }, [])
  const metrics = pharmacyMetrics(items)
  return <Layout title="Pharmacy" subtitle={`${facility.name} · ${actor.displayName ?? 'Authorized Pharmacy user'}`}>
    <nav className="workspace-nav" aria-label="Pharmacy workspace">
      {[['/', 'Dashboard'], ['/prescriptions', 'Prescriptions'], ['/dispensing', 'Dispensing'], ['/evidence', 'Medication evidence'], ['/activity', 'Activity']].map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}><Button size="sm" variant="secondary">{label}</Button></NavLink>)}
      <Button size="sm" variant="ghost" onClick={() => void safeSignOut().finally(() => window.location.assign('/'))}>Sign out</Button>
    </nav>
    {!online && <div className="safe-note"><SyncStatus status="offline" /> Protected Pharmacy mutations are disabled. Nothing is labeled dispensed until the API confirms it.</div>}
    {error && <p role="alert" style={{ color: 'var(--color-error)' }}>{error}</p>}
    <Routes>
      <Route path="/" element={<Dashboard metrics={metrics} items={items} loading={loading} load={load} />} />
      <Route path="/prescriptions" element={<PrescriptionList items={items} />} />
      <Route path="/dispensing" element={<Dispensing items={items} api={api} online={online} permissions={facility.permissions} onChanged={load} />} />
      <Route path="/evidence" element={<MedicationEvidence api={api} online={online} />} />
      <Route path="/activity" element={<Activity items={items} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </Layout>
}

function Dashboard({ metrics, items, loading, load }: { metrics: ReturnType<typeof pharmacyMetrics>; items: PharmacyWorkItem[]; loading: boolean; load: () => Promise<void> }) {
  return <div className="workspace-grid"><Card><div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><div><h2>Pharmacy operations</h2><p>Prescription acceptance, dispensing, reversal, and imported historical evidence remain distinct authoritative facts.</p></div><Button loading={loading} onClick={() => void load()}>Refresh</Button></div></Card><div className="metrics">{[['Pending dispensing', metrics.acceptedPending], ['Dispensed', metrics.dispensed], ['Reversed', metrics.reversed], ['Accepted total', metrics.total]].map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>{items.length === 0 && !loading && <Card>No accepted prescriptions are currently visible for this authorized facility.</Card>}</div>
}

function PrescriptionList({ items }: { items: PharmacyWorkItem[] }) {
  return <Card><h2>Prescriptions accepted by Pharmacy</h2><p className="safe-note">Prescribed in EHR is not accepted by Pharmacy; accepted is not dispensed; dispensed is not administered.</p>{items.map(item => <WorkItem key={item.id} item={item} />)}{items.length === 0 && <p>No accepted prescriptions are visible.</p>}</Card>
}

function WorkItem({ item, actions }: { item: PharmacyWorkItem; actions?: React.ReactNode }) {
  const state = operationalState(item)
  return <article className="work-item"><div><strong>{item.medication.display}</strong> <Badge>{state}</Badge></div><div>{patientReference(item.patientId)} · accepted {new Date(item.acceptedAt).toLocaleString()}</div><div>{item.doseQuantity ?? 'Dose not structured'} {item.doseUnit ?? ''} · {item.frequency}</div><div>{state === 'accepted' ? 'Pending an explicit Pharmacy dispensing command.' : state === 'dispensed' ? 'Dispensing confirmed by Pharmacy API; this is not administration.' : 'Original dispensing preserved with a reasoned reversal.'}</div>{actions}</article>
}

type PharmacyApi = ReturnType<typeof createPharmacyApi>

function Dispensing({ items, api, online, permissions, onChanged }: { items: PharmacyWorkItem[]; api: PharmacyApi; online: boolean; permissions: string[]; onChanged: () => Promise<void> }) {
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('unit')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const command = async (item: PharmacyWorkItem, reverse = false) => {
    if (!online) return setMessage('Pending synchronization is not enabled for dispensing in this version. Reconnect before changing authoritative state.')
    if (reason.trim().length < 8) return setMessage('Enter an operational reason of at least 8 characters.')
    setBusy(item.id); setMessage('')
    try {
      if (reverse && item.dispensing) {
        const dispensing = await api.getDispensing(item.dispensing.id)
        await api.reverse(dispensing.id, { expectedDispensingVersion: dispensing.version, reason: reason.trim() }, crypto.randomUUID())
        captureProductEvent('pharmacy_reversal_confirmed', { workspace: 'pharmacy', result: 'server_confirmed', offline: false })
        setMessage('Reversal confirmed by Pharmacy. The original dispensing remains preserved.')
      } else {
        const parsedQuantity = Number(quantity)
        if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0 || !unit.trim()) throw new Error('Enter a positive quantity and unit.')
        await api.dispense(item.id, { expectedWorkItemVersion: item.version, quantityDispensed: parsedQuantity, quantityUnit: unit.trim(), reason: reason.trim() }, crypto.randomUUID())
        captureProductEvent('pharmacy_dispensing_confirmed', { workspace: 'pharmacy', result: 'server_confirmed', offline: false })
        setMessage('Dispensing confirmed by Pharmacy API. This does not claim medication administration.')
      }
      await onChanged()
    } catch (caught) { setMessage(problemMessage(caught, 'Pharmacy command failed.')) }
    finally { setBusy('') }
  }
  return <Card><h2>Dispensing</h2><p>All changes require live Identity reauthorization and server confirmation.</p><div className="inline-form"><Input label="Quantity dispensed" type="number" min="0.0001" step="any" value={quantity} onChange={event => setQuantity(event.target.value)} /><Input label="Quantity unit" value={unit} onChange={event => setUnit(event.target.value)} /><Input label="Reason" value={reason} onChange={event => setReason(event.target.value)} /></div>{message && <p role="status">{message}</p>}{items.map(item => <WorkItem key={item.id} item={item} actions={canDispense(item, online, permissions) ? <Button loading={busy === item.id} onClick={() => void command(item)}>Confirm full dispensing</Button> : item.dispensing && !item.dispensing.reversed && permissions.includes('pharmacy.dispensing.reverse') ? <Button variant="danger" loading={busy === item.id} disabled={!online} onClick={() => void command(item, true)}>Reverse dispensing</Button> : undefined} />)}</Card>
}

function MedicationEvidence({ api, online }: { api: PharmacyApi; online: boolean }) {
  const [id, setId] = useState('')
  const [evidence, setEvidence] = useState<PharmacyImportedMedicationEvidence | null>(null)
  const [error, setError] = useState('')
  const lookup = async () => { setError(''); setEvidence(null); if (!online) return setError('Reconnect to read authoritative medication evidence.'); try { setEvidence(await api.getImport(id.trim())) } catch (caught) { setError(problemMessage(caught, 'Evidence could not be loaded.')) } }
  return <Card><h2>Imported medication evidence</h2><p className="safe-note">Historical OCR evidence has activity status unknown. It is not an active prescription, HID dispensing, refill, or administration record.</p><div className="inline-form"><Input label="Evidence identifier" value={id} onChange={event => setId(event.target.value)} /><Button disabled={!id.trim() || !online} onClick={() => void lookup()}>Look up evidence</Button></div>{error && <p role="alert" style={{ color: 'var(--color-error)' }}>{error}</p>}{evidence && <article className="work-item"><strong>{evidence.medicationText}</strong><Badge>{evidence.activityStatus}</Badge><div>{evidence.strengthText ?? 'Strength unavailable'} · {evidence.doseText ?? 'Dose unavailable'} · {evidence.frequencyText ?? 'Frequency unavailable'}</div><div>Imported {new Date(evidence.createdAt).toLocaleString()} from governed OCR publication.</div></article>}</Card>
}

function Activity({ items }: { items: PharmacyWorkItem[] }) {
  return <Card><h2>Operational activity</h2><p>This view derives only from the current Pharmacy work queue; the backend does not expose a separate global activity feed.</p>{[...items].reverse().map(item => <WorkItem key={item.id} item={item} />)}{items.length === 0 && <p>No activity is visible.</p>}</Card>
}
