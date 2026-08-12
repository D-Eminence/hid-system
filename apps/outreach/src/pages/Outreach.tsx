import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layout } from '@hid/ui/Layout'
import { Badge, Button, Card, Input, Select, Spinner, Textarea } from '@hid/ui'
import { useOutreach } from '../hooks/useOutreach'
import { OUTREACH_LOGIN_PATH } from '../lib/outreachRoutes'

const sexOptions = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
  { value: 'unknown', label: 'Unknown' },
]

export default function OutreachPage() {
  const navigate = useNavigate()
  const outreach = useOutreach()
  const [form, setForm] = useState({ fullName: '', sex: 'unknown', ageYears: 0,
    phone: '', operationalNotes: '' })
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  React.useEffect(() => {
    if (outreach.needsAuth) navigate(OUTREACH_LOGIN_PATH, { replace: true })
  }, [navigate, outreach.needsAuth])

  const recent = useMemo(() => outreach.serverCases.slice(0, 8), [outreach.serverCases])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    if (!form.fullName.trim()) { setFormError('Enter the person’s name.'); return }
    if (!Number.isInteger(form.ageYears) || form.ageYears < 0 || form.ageYears > 130) {
      setFormError('Enter an age from 0 to 130.'); return
    }
    setSubmitting(true)
    try {
      await outreach.addRegistration({
        fullName: form.fullName.trim(),
        sex: form.sex as 'female' | 'male' | 'other' | 'unknown',
        ageYears: form.ageYears,
        phone: form.phone.trim() || null,
        operationalNotes: form.operationalNotes.trim() || null,
      })
      setForm({ fullName: '', sex: 'unknown', ageYears: 0, phone: '', operationalNotes: '' })
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'Unable to save this registration.')
    } finally { setSubmitting(false) }
  }

  if (outreach.loading) return (
    <Layout title="Outreach" subtitle="Opening secure field registration…">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner /></div>
    </Layout>
  )

  if (outreach.error && !outreach.facility) return (
    <Layout title="Outreach" subtitle="Facility access required">
      <Card style={{ maxWidth: 640, margin: '0 auto', padding: 32 }}>
        <h2>Unable to open Outreach</h2><p style={{ color: '#4b5563' }}>{outreach.error}</p>
        <Button variant="primary" onClick={() => window.location.reload()}>Retry</Button>
      </Card>
    </Layout>
  )

  return (
    <Layout title="Outreach" subtitle="Temporary field registration and Identity resolution">
      <div style={{ display: 'grid', gap: 24 }}>
        <Card style={{ padding: 24 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <p style={{ margin: 0, color: '#1a6fd4', fontWeight: 700 }}>AUTHORIZED FACILITY</p>
              <h2 style={{ margin: '8px 0 0' }}>{outreach.facility?.name}</h2>
              <p style={{ color: '#6b7280' }}>Signed in as {outreach.actor?.displayName ?? 'Outreach staff'}</p>
            </div>
            <Badge color={outreach.connection === 'online' ? 'green' : 'amber'}>{outreach.connection}</Badge>
          </div>
          <p style={{ color: '#4b5563' }}>
            A temporary ID is generated locally and is never an HID or canonical patient UUID.
            Unresolved records remain pending until Identity explicitly authorizes a match.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
            <Metric label="Server received" value={outreach.metrics.serverReceived} />
            <Metric label="Pending sync" value={outreach.metrics.pending} />
            <Metric label="Needs attention" value={outreach.metrics.attention} />
            <Metric label="Acknowledged here" value={outreach.metrics.acknowledged} />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
            <Button variant="primary" loading={outreach.syncing} disabled={outreach.connection === 'offline'}
              onClick={outreach.syncNow}>Sync pending</Button>
            <Button variant="secondary" onClick={outreach.signOut}>Clear device data and sign out</Button>
          </div>
          {outreach.error && <p role="alert" style={{ color: '#b91c1c' }}>{outreach.error}</p>}
        </Card>

        <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
          <Card style={{ padding: 24 }}>
            <h3 style={{ marginTop: 0 }}>New temporary registration</h3>
            <p style={{ color: '#6b7280' }}>Saved encrypted on this device first; clinical care is not recorded here.</p>
            <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
              <Input label="Full name" value={form.fullName}
                onChange={(event) => setForm({ ...form, fullName: event.target.value })} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <Select label="Sex" options={sexOptions} value={form.sex}
                  onChange={(event) => setForm({ ...form, sex: event.target.value })} />
                <Input label="Age" type="number" min={0} max={130} value={form.ageYears}
                  onChange={(event) => setForm({ ...form, ageYears: Number(event.target.value) })} />
              </div>
              <Input label="Phone (optional)" value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })} />
              <Textarea label="Operational notes (optional)" rows={3} value={form.operationalNotes}
                onChange={(event) => setForm({ ...form, operationalNotes: event.target.value })} />
              {formError && <p role="alert" style={{ color: '#b91c1c' }}>{formError}</p>}
              <Button type="submit" loading={submitting}>Save temporary registration</Button>
            </form>
          </Card>

          <div style={{ display: 'grid', gap: 24 }}>
            <Card style={{ padding: 24 }}>
              <h3 style={{ marginTop: 0 }}>Device queue</h3>
              {outreach.commands.length === 0 ? <p style={{ color: '#6b7280' }}>No encrypted commands waiting.</p>
                : outreach.commands.map((command) => (
                  <div key={command.commandId} style={{ padding: 12, borderTop: '1px solid #e5e7eb' }}>
                    <strong>{command.input.fullName}</strong>
                    <div style={{ fontSize: 12, color: '#6b7280', overflowWrap: 'anywhere' }}>{command.temporaryPatientId}</div>
                    <Badge color={command.state === 'terminal' ? 'red' : 'amber'}>{command.state}</Badge>
                    {command.lastError && <p style={{ color: '#b91c1c', fontSize: 13 }}>{command.lastError}</p>}
                  </div>
                ))}
            </Card>
            <Card style={{ padding: 24 }}>
              <h3 style={{ marginTop: 0 }}>Recent server cases</h3>
              {recent.length === 0 ? <p style={{ color: '#6b7280' }}>No server receipts yet.</p>
                : recent.map((item) => (
                  <div key={item.id} style={{ padding: 12, borderTop: '1px solid #e5e7eb' }}>
                    <strong>{item.fullName}</strong>
                    <div style={{ fontSize: 12, color: '#6b7280', overflowWrap: 'anywhere' }}>{item.temporaryPatientId}</div>
                    <Badge color={item.status === 'identity_resolved' ? 'green' : 'blue'}>{item.status}</Badge>
                  </div>
                ))}
            </Card>
          </div>
        </div>
      </div>
    </Layout>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div style={{ padding: 14, borderRadius: 12, background: '#f8fafc' }}>
    <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
  </div>
}
