import React, { useEffect, useMemo, useState } from 'react'
import { getIdentityActorContext, identityClient, safeSignOut } from '@hid/identity-browser-client'
import { Layout } from '@hid/ui/Layout'
import { Badge, Button, Card, Input, Spinner } from '@hid/ui'
import { Turnstile } from '@hid/ui/Turnstile'
import { createLabApi } from './lib/labApi'

function authorizedFacility(actor) {
  const facilities = actor.facilities.filter((facility) => facility.permissions.includes('lab.work-item.read'))
  return facilities.find((facility) => facility.isPrimary) ?? facilities[0] ?? null
}

export default function App() {
  const [state, setState] = useState({ loading: true, actor: null, facility: null, error: '' })
  useEffect(() => {
    let active = true
    void getIdentityActorContext().then((actor) => {
      if (!active) return
      if (!actor) { setState({ loading: false, actor: null, facility: null, error: '' }); return }
      const facility = authorizedFacility(actor)
      setState({ loading: false, actor, facility, error: facility ? '' : 'Your Identity account has no Lab work-queue permission at an active facility.' })
    }).catch((error) => {
      if (active) setState({ loading: false, actor: null, facility: null, error: error instanceof Error ? error.message : 'Unable to open Laboratory.' })
    })
    return () => { active = false }
  }, [])

  if (state.loading) return <Layout title="Laboratory" subtitle="Restoring secure Identity session…"><div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}><Spinner /></div></Layout>
  if (!state.actor) return <HostLogin />
  if (!state.facility) return <Layout title="Laboratory" subtitle="Facility access required"><Card><h2>Laboratory access is unavailable</h2><p style={{ color: 'var(--color-error)' }}>{state.error}</p><Button variant="secondary" onClick={() => { void safeSignOut().finally(() => window.location.assign('/')) }}>Sign out</Button></Card></Layout>
  return <LaboratoryWorkspace actor={state.actor} facility={state.facility} />
}

function HostLogin() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [token, setToken] = useState(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false)
  const submit = async (event) => { event.preventDefault(); setLoading(true); setError(''); try {
    const result = await identityClient.auth.signInWithPassword({ email: email.trim().toLowerCase(), password,
      options: { captchaToken: token ?? undefined, captchaAction: 'lab-login' } })
    if (result.error) throw result.error
    window.location.reload()
  } catch (caught) { setError(caught instanceof Error ? caught.message : 'Sign-in failed.') } finally { setLoading(false) } }
  return <Layout title="Laboratory" subtitle="Identity sign-in required"><Card><h2>Sign in to Laboratory</h2><p>This host receives its own secure Identity session cookie. No credentials are shared through browser storage.</p><form onSubmit={submit} style={{ display: 'grid', gap: 14 }}><Input label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} /><Input label="Password" type="password" value={password} onChange={event => setPassword(event.target.value)} /><Turnstile action="lab-login" onTokenChange={setToken} />{error && <p role="alert" style={{ color: 'var(--color-error)' }}>{error}</p>}<Button type="submit" loading={loading}>Sign in</Button></form></Card></Layout>
}

function LaboratoryWorkspace({ actor, facility }) {
  const api = useMemo(() => createLabApi(facility.id), [facility.id])
  const [items, setItems] = useState([]); const [selected, setSelected] = useState(null)
  const [specimenType, setSpecimenType] = useState(''); const [containerType, setContainerType] = useState('')
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false)
  const [execution, setExecution] = useState(null); const [resultValue, setResultValue] = useState(''); const [unit, setUnit] = useState('')
  const load = async () => { setLoading(true); setError(''); try { const value = await api.listWorkItems(); setItems(value.items || []); if (selected?.id) { const current = (value.items || []).find((item) => item.id === selected.id); if (current?.accessionId) setSelected(await api.getAccession(current.accessionId)) } } catch (caught) { setError(caught instanceof Error ? caught.message : 'Lab queue could not be loaded.') } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  const accession = async (item) => { if (!specimenType.trim() || !reason.trim()) { setError('Specimen type and accession reason are required.'); return } setLoading(true); setError(''); try { setSelected(await api.createAccession(item.id, { requirements: [{ specimenType: specimenType.trim(), containerType: containerType.trim() || undefined }], reason: reason.trim() })); await load() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Accession could not be created.') } finally { setLoading(false) } }
  const transition = async (specimen, action) => { setLoading(true); setError(''); try { const now = new Date().toISOString(); if (action === 'collect') await api.collectSpecimen(specimen.accessionId, specimen.id, { expectedVersion: specimen.version, collectedAt: now }); else if (action === 'receive') await api.receiveSpecimen(specimen.accessionId, specimen.id, { expectedVersion: specimen.version, receivedAt: now, condition: 'Received condition recorded' }); else { const rejection = reason.trim(); if (!rejection) throw new Error('Enter a rejection reason first.'); await api.rejectSpecimen(specimen.accessionId, specimen.id, { expectedVersion: specimen.version, reason: rejection }) } setSelected(await api.getAccession(specimen.accessionId)); await load() } catch (caught) { setError(caught instanceof Error ? caught.message : 'Specimen command failed.') } finally { setLoading(false) } }
  const openExecution = async (specimen) => { setLoading(true); try { const list = await api.listExecutions(specimen.id); setExecution(list.items?.[0] || null); if (!list.items?.[0]) setExecution(await api.startExecution(specimen.id, { expectedSpecimenVersion: specimen.version, startedAt: new Date().toISOString(), reason: 'Manual analytical execution started' })) } catch (caught) { setError(caught instanceof Error ? caught.message : 'Execution could not be opened.') } finally { setLoading(false) } }
  const complete = async () => { setLoading(true); try { setExecution(await api.completeExecution(execution.id, { expectedVersion: execution.version, completedAt: new Date().toISOString() })) } catch (caught) { setError(caught instanceof Error ? caught.message : 'Execution could not be completed.') } finally { setLoading(false) } }
  const saveResult = async (correction) => { setLoading(true); try { const numeric = Number(resultValue); const isNumeric = resultValue.trim() !== '' && Number.isFinite(numeric); const input = { expectedExecutionVersion: execution.version, resultType: isNumeric ? 'numeric' : 'text', numericValue: isNumeric ? numeric : undefined, textValue: isNumeric ? undefined : resultValue.trim(), unit: unit.trim() || undefined, abnormalFlag: 'unknown', ...(correction ? { expectedResultVersion: execution.result.currentVersion, reason: reason.trim() || 'Corrected manual entry' } : {}) }; const result = correction ? await api.correctResult(execution.id, execution.result.id, input) : await api.enterResult(execution.id, input); setExecution({ ...execution, result }) } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unverified result could not be saved.') } finally { setLoading(false) } }
  const governResult = async (action) => { setLoading(true); setError(''); try { const input = { expectedResultVersion: execution.result.currentVersion, occurredAt: new Date().toISOString(), reason: reason.trim() || `Manual result ${action}` }; const result = action === 'verified' ? await api.verifyResult(execution.result.id, input) : await api.releaseResult(execution.result.id, input); setExecution({ ...execution, result }) } catch (caught) { setError(caught instanceof Error ? caught.message : `Result could not be ${action}.`) } finally { setLoading(false) } }
  return <Layout title="Laboratory" subtitle={`${facility.name} · ${actor.displayName ?? 'Authorized laboratory staff'}`}><div style={{ display: 'grid', gap: 20 }}>
    <Card><div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}><div><h2 style={{ margin: 0 }}>Laboratory operations</h2><p style={{ color: 'var(--color-text-muted)' }}>Custody, execution, and manual result entry. Verification and release remain explicit governed actions.</p></div><Button variant="secondary" onClick={() => { void safeSignOut().finally(() => window.location.assign('/')) }}>Sign out</Button></div></Card>
    {error && <p role="alert" style={{ color: 'var(--color-error)', margin: 0 }}>{error}</p>}
    <Card><div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><h3 style={{ margin: 0 }}>Lab work queue</h3><Button size="sm" variant="secondary" loading={loading} onClick={load}>Refresh</Button></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, margin: '20px 0' }}><Input label="Specimen type" value={specimenType} onChange={(event) => setSpecimenType(event.target.value)} /><Input label="Container type" value={containerType} onChange={(event) => setContainerType(event.target.value)} /><Input label="Operational / rejection reason" value={reason} onChange={(event) => setReason(event.target.value)} /></div><div style={{ display: 'grid', gap: 12 }}>{items.map((item) => <div key={item.id} style={{ padding: 16, border: '1px solid var(--color-border)', borderRadius: 12 }}><strong>{item.testName}</strong> <Badge>{item.accessionNumber ? 'Accessioned' : 'Accepted by Lab'}</Badge><div style={{ color: 'var(--color-text-muted)', fontSize: 12, margin: '8px 0' }}>{item.accessionNumber || item.id}</div>{item.accessionId ? <Button size="sm" onClick={async () => setSelected(await api.getAccession(item.accessionId))}>View specimens</Button> : <Button size="sm" loading={loading} onClick={() => accession(item)}>Create accession</Button>}</div>)}</div>{!loading && items.length === 0 && <p>No authorized accepted Lab work is currently visible.</p>}</Card>
    {selected && <Card><h3 style={{ marginTop: 0 }}>Accession {selected.accessionNumber}</h3><p style={{ color: 'var(--color-text-muted)' }}>Accession does not mean collection; receipt does not mean testing.</p>{(selected.specimens || []).map((specimen) => <div key={specimen.id} style={{ padding: '16px 0', borderTop: '1px solid var(--color-border)' }}><strong>{specimen.specimenType}</strong> <Badge>{specimen.status}</Badge><div style={{ color: 'var(--color-text-muted)', fontSize: 12, margin: '8px 0' }}>{specimen.specimenIdentifier}</div>{specimen.status === 'required' && <Button size="sm" loading={loading} onClick={() => transition(specimen, 'collect')}>Record collection</Button>}{specimen.status === 'collected' && <><Button size="sm" loading={loading} onClick={() => transition(specimen, 'receive')}>Record receipt</Button> <Button size="sm" variant="secondary" loading={loading} onClick={() => transition(specimen, 'reject')}>Reject specimen</Button></>}{specimen.status === 'received' && <Button size="sm" loading={loading} onClick={() => openExecution(specimen)}>Open test execution</Button>}</div>)}</Card>}
    {execution && <Card>
      <h3 style={{ marginTop: 0 }}>{execution.test?.name || 'Requested test execution'}</h3>
      <p><Badge>{execution.status.replaceAll('_', ' ')}</Badge></p>
      {execution.status === 'in_progress' && <Button loading={loading} onClick={complete}>Complete analytical execution</Button>}
      {execution.status === 'completed' && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, margin: '20px 0' }}>
          <Input label="Manual numeric or text result" value={resultValue} onChange={(event) => setResultValue(event.target.value)} />
          <Input label="Unit" value={unit} onChange={(event) => setUnit(event.target.value)} />
        </div>
        <Badge>{execution.result?.status?.replaceAll('_', ' ') || 'No result entered'}</Badge>{' '}
        <Button loading={loading} onClick={() => saveResult(Boolean(execution.result))}>{execution.result ? 'Create corrected revision' : 'Enter unverified result'}</Button>
        {execution.result?.status === 'entered_unverified' && <Button loading={loading} onClick={() => governResult('verified')}>Verify version {execution.result.currentVersion}</Button>}
        {execution.result?.status === 'verified_not_released' && <Button loading={loading} onClick={() => governResult('released')}>Release version {execution.result.currentVersion}</Button>}
        {execution.result && <div style={{ marginTop: 16 }}><strong>Unverified result history</strong>{execution.result.revisions.map((revision) => <div key={revision.version}>v{revision.version}: {revision.numericValue ?? revision.textValue} {revision.unit || ''} — unverified manual</div>)}</div>}
      </>}
    </Card>}
  </div></Layout>
}
