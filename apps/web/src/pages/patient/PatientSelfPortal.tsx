import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CarePortal, RecordSummary } from '../../components/CarePortal'
import { carePortalApi, type PatientNinVerification, type PatientSelf, type ReleasedRecords } from '../../lib/carePortalApi'
import { canonicalRequest, identityClient } from '../../lib/identityClient'

type AccessItem = { consentGrantId: string; scope: string; purpose: string; status: string; startsAt: string; expiresAt: string; reason: string; facilityName: string }
export default function PatientSelfPortal({ page }: { page: 'profile' | 'biodata' | 'records' | 'history' | 'notifications' }) {
  const [profile, setProfile] = useState<PatientSelf | null>(null)
  const [records, setRecords] = useState<ReleasedRecords | null>(null)
  const [activity, setActivity] = useState<AccessItem[] | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [nin, setNin] = useState('')
  const [verification, setVerification] = useState<PatientNinVerification | null>(null)
  const [verificationError, setVerificationError] = useState('')
  const [verifying, setVerifying] = useState(false)
  useEffect(() => {
    let active = true
    setProfile(null); setRecords(null); setActivity(null); setError('')
    async function load() {
      const self = await carePortalApi.self()
      if (!active) return
      setProfile(self)
      if (page === 'records') {
        const value = await carePortalApi.ownRecords()
        if (active) setRecords(value)
      }
      if (page === 'history' || page === 'notifications') {
        const value = await canonicalRequest<{ items: AccessItem[] }>('/api/v1/identity/me/access-history')
        if (active) setActivity(value.items)
      }
    }
    void load().catch(reason => { if (active) { setProfile(null); setRecords(null); setActivity(null); setError(reason instanceof Error ? reason.message : 'Unable to load your account.') } })
    const subscription = identityClient.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') { active = false; setProfile(null); setRecords(null); setActivity(null); setError('Please sign in again.') }
    })
    // Hide medical information when a background tab resumes until authority is checked again.
    const refresh = () => { if (!document.hidden) setReload(value => value + 1) }
    document.addEventListener('visibilitychange', refresh)
    return () => { active = false; subscription.data.subscription.unsubscribe(); document.removeEventListener('visibilitychange', refresh) }
  }, [page, reload])
  async function verifyNin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setVerification(null); setVerificationError(''); setVerifying(true)
    try {
      const result = await carePortalApi.verifyNin(nin)
      setVerification(result); setNin('')
    } catch (reason) {
      setVerificationError(reason instanceof Error ? reason.message : 'Verification could not be completed.')
    } finally { setVerifying(false) }
  }
  const title = { profile: 'Your profile and HID', biodata: 'Your bio data', records: 'Your medical records', history: 'Your access history', notifications: 'Your access notifications' }[page]
  return <CarePortal title={title} patient>
    {error ? <div role="alert"><p>{error}</p><Link to="/patient">Sign in</Link> <button onClick={() => setReload(value => value + 1)}>Retry</button></div> : !profile ? <p role="status">Loading your account…</p> : <>
      <p>{profile.fullName} · <strong>{profile.hid}</strong></p>
      {(page === 'profile' || page === 'biodata') && <><dl>
        <dt>First name</dt><dd>{profile.firstName}</dd><dt>Last name</dt><dd>{profile.lastName}</dd>
        <dt>Date of birth</dt><dd>{profile.dateOfBirth?.slice(0, 10) || 'Not recorded'}</dd>
        <dt>Gender</dt><dd>{profile.gender || 'Not recorded'}</dd><dt>Country</dt><dd>{profile.country || 'Not recorded'}</dd><dt>State</dt><dd>{profile.state || 'Not recorded'}</dd>
      </dl><p>Contact your registering facility to request a verified identity correction.</p>
      {page === 'profile' && <section aria-labelledby="nin-verification-title">
        <h2 id="nin-verification-title">Verify your NIN</h2>
        <p>We use only your 11-digit NIN for this check. It does not change your HID or profile.</p>
        <form onSubmit={verifyNin}>
          <label htmlFor="patient-nin">NIN</label>
          <input id="patient-nin" value={nin} onChange={event => setNin(event.target.value)}
            inputMode="numeric" autoComplete="off" maxLength={16} required />
          <button type="submit" disabled={verifying}>{verifying ? 'Verifying…' : 'Verify NIN'}</button>
        </form>
        {verificationError && <p role="alert">{verificationError}</p>}
        {verification && <p role="status">Verification result: {verification.state.replace('_', ' ')}. Recorded {new Date(verification.recordedAt).toLocaleString()}.</p>}
      </section>}</>}
      {page === 'records' && (records ? <RecordSummary records={records} /> : <p role="status">Loading released records…</p>)}
      {(page === 'history' || page === 'notifications') && <>
        {page === 'notifications' && <p>Emergency access notices recorded in your account. Email delivery status is not shown here.</p>}
        {!activity ? <p role="status">Loading access activity…</p> : (page === 'notifications' ? activity.filter(item => item.scope === 'break_glass') : activity).length === 0 ? <p>No access activity is recorded.</p> :
          (page === 'notifications' ? activity.filter(item => item.scope === 'break_glass') : activity).map(item => <article key={item.consentGrantId} style={{ borderTop: '1px solid #dbe3ef' }}>
            <h3>{item.scope === 'break_glass' ? 'Emergency access' : 'Record access'} · {item.status}</h3>
            <p>{item.facilityName} · {item.purpose}</p><p>{item.reason}</p>
            <p>From {new Date(item.startsAt).toLocaleString()} until {new Date(item.expiresAt).toLocaleString()}</p>
            {item.scope === 'break_glass' && <p>This emergency activation requires facility review. Contact your facility if you do not recognize this activity.</p>}
          </article>)}
      </>}
    </>}
  </CarePortal>
}
