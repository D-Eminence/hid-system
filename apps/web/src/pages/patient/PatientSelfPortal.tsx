import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CarePortal, RecordSummary } from '../../components/CarePortal'
import { carePortalApi, type PatientNinVerification, type PatientSelf, type ReleasedRecords } from '../../lib/carePortalApi'
import { canonicalRequest, identityClient } from '../../lib/identityClient'
import { GoogleIdentityButton } from '../../components/GoogleIdentityButton'
import { PasswordField } from '../../components/PasswordField'
import { TurnstileWidget } from '../../components/TurnstileWidget'
import { ImportedMedicalHistory } from '../../../../../packages/ui/src/ImportedMedicalHistory'
import { ensureCaptchaReady } from '../../lib/captcha'

type AccessItem = { consentGrantId: string; scope: string; purpose: string; status: string; startsAt: string; expiresAt: string; reason: string; facilityName: string }
export default function PatientSelfPortal({ page }: { page: 'profile' | 'biodata' | 'records' | 'history' | 'notifications' }) {
  const [profile, setProfile] = useState<PatientSelf | null>(null)
  const [records, setRecords] = useState<ReleasedRecords | null>(null)
  const [activity, setActivity] = useState<AccessItem[] | null>(null)
  const [importedNotifications, setImportedNotifications] = useState<Awaited<ReturnType<typeof carePortalApi.importedNotifications>> | null>(null)
  const [notificationOffset, setNotificationOffset] = useState(0)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [nin, setNin] = useState('')
  const [verification, setVerification] = useState<PatientNinVerification | null>(null)
  const [verificationError, setVerificationError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [pin, setPin] = useState('')
  const [pinConfirmation, setPinConfirmation] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const [pinError, setPinError] = useState('')
  const [pinNotice, setPinNotice] = useState('')
  const [linkPassword, setLinkPassword] = useState('')
  const [linkTurnstileToken, setLinkTurnstileToken] = useState<string | null>(null)
  const [linkTurnstileResetKey, setLinkTurnstileResetKey] = useState(0)
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkError, setLinkError] = useState('')
  const [linkNotice, setLinkNotice] = useState('')
  useEffect(() => {
    let active = true
    setProfile(null); setRecords(null); setActivity(null); setImportedNotifications(null); setError('')
    async function load() {
      const self = await carePortalApi.self()
      if (!active) return
      setProfile(self)
      if (page === 'records' || page === 'biodata') {
        const value = await carePortalApi.ownRecords()
        if (active) setRecords(value)
      }
      if (page === 'history' || page === 'notifications') {
        const value = await canonicalRequest<{ items: AccessItem[] }>('/api/v1/identity/me/access-history')
        if (active) setActivity(value.items)
      }
      if (page === 'notifications') {
        const value = await carePortalApi.importedNotifications(notificationOffset)
        if (active) setImportedNotifications(value)
      }
    }
    void load().catch(reason => { if (active) { setProfile(null); setRecords(null); setActivity(null); setImportedNotifications(null); setError(reason instanceof Error ? reason.message : 'Unable to load your account.') } })
    const subscription = identityClient.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') { active = false; setProfile(null); setRecords(null); setActivity(null); setImportedNotifications(null); setError('Please sign in again.') }
    })
    // Hide medical information when a background tab resumes until authority is checked again.
    const refresh = () => { if (!document.hidden) setReload(value => value + 1) }
    document.addEventListener('visibilitychange', refresh)
    return () => { active = false; subscription.data.subscription.unsubscribe(); document.removeEventListener('visibilitychange', refresh) }
  }, [page, reload, notificationOffset])
  async function verifyNin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setVerification(null); setVerificationError(''); setVerifying(true)
    try {
      const result = await carePortalApi.verifyNin(nin)
      setVerification(result); setNin('')
      if (result.state === 'verified') setReload(value => value + 1)
    } catch (reason) {
      setVerificationError(reason instanceof Error ? reason.message : 'Verification could not be completed.')
    } finally { setVerifying(false) }
  }
  async function savePin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pinBusy) return
    const digits = pin.replace(/\s+/g, '')
    if (!/^\d{4,8}$/.test(digits) || digits !== pinConfirmation.replace(/\s+/g, '')) {
      setPinError('Enter matching Access PINs of 4 to 8 digits.')
      return
    }
    setPinBusy(true); setPinError(''); setPinNotice('')
    try {
      await carePortalApi.configureAccessPin(digits)
      setProfile(current => current ? { ...current, accessPinConfigured: true } : current)
      setPin(''); setPinConfirmation('')
      setPinNotice('Your Access PIN is configured. Earlier PIN access grants were revoked.')
    } catch (reason) {
      setPinError(reason instanceof Error ? reason.message : 'The Access PIN could not be saved.')
    } finally { setPinBusy(false) }
  }
  async function revokePin() {
    if (pinBusy) return
    setPinBusy(true); setPinError(''); setPinNotice('')
    try {
      await carePortalApi.revokeAccessPin()
      setProfile(current => current ? { ...current, accessPinConfigured: false } : current)
      setPin(''); setPinConfirmation('')
      setPinNotice('Your Access PIN was removed. Earlier PIN access grants were revoked.')
    } catch (reason) {
      setPinError(reason instanceof Error ? reason.message : 'The Access PIN could not be removed.')
    } finally { setPinBusy(false) }
  }
  async function linkGoogle(credential: string) {
    if (!profile || linkBusy || !linkPassword || !ensureCaptchaReady(linkTurnstileToken)) return
    setLinkBusy(true); setLinkError(''); setLinkNotice('')
    try {
      await identityClient.auth.linkGoogleIdentity({ token: credential, principal: profile.hid,
        password: linkPassword, turnstileToken: linkTurnstileToken ?? '' })
      setLinkPassword('')
      setLinkNotice('Your Google identity is linked to this Health ID. You can use it on the sign-in page.')
    } catch {
      setLinkError('Google linking could not be completed. Check your password and Google account, then try again.')
    } finally {
      setLinkBusy(false)
      setLinkTurnstileToken(null)
      setLinkTurnstileResetKey(value => value + 1)
    }
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
        {profile.assuranceState === 'NIN_VERIFIED' ? <p role="status">Your NIN is verified for this Health ID.</p> : <>
        <p>Verify your NIN with QoreID while keeping your existing Health ID and records. Your HID account contact can be different from your NIN record phone.</p>
        <form onSubmit={verifyNin}>
          <label htmlFor="patient-nin">NIN</label>
          <input id="patient-nin" value={nin} onChange={event => setNin(event.target.value)}
            inputMode="numeric" autoComplete="off" maxLength={16} required />
          <button type="submit" disabled={verifying}>{verifying ? 'Verifying…' : 'Verify NIN'}</button>
        </form>
        {verificationError && <p role="alert">{verificationError}</p>}
        {verification && <p role="status">Verification result: {verification.state.replace('_', ' ')}. Recorded {new Date(verification.recordedAt).toLocaleString()}.</p>}
        </>}
      </section>}
      {page === 'profile' && <section aria-labelledby="access-pin-title" style={{ marginTop: 28 }}>
        <h2 id="access-pin-title">Access PIN</h2>
        <p role="status">{profile.accessPinConfigured ? 'Access PIN configured' : 'No Access PIN configured'}</p>
        <p>A clinician can use your Health ID and Access PIN to request short-lived, read-only record access. Your PIN is separate from your account password and NIN.</p>
        <form onSubmit={savePin} style={{ display: 'grid', gap: 10, maxWidth: 360 }}>
          <label htmlFor="patient-access-pin">{profile.accessPinConfigured ? 'New Access PIN' : 'Set an Access PIN'}</label>
          <input id="patient-access-pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,8}" minLength={4} maxLength={8} required value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))} />
          <label htmlFor="patient-access-pin-confirm">Confirm Access PIN</label>
          <input id="patient-access-pin-confirm" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,8}" minLength={4} maxLength={8} required value={pinConfirmation} onChange={event => setPinConfirmation(event.target.value.replace(/\D/g, '').slice(0, 8))} />
          <button type="submit" disabled={pinBusy}>{pinBusy ? 'Saving…' : profile.accessPinConfigured ? 'Replace PIN' : 'Set PIN'}</button>
        </form>
        {profile.accessPinConfigured && <button type="button" disabled={pinBusy} onClick={() => { void revokePin() }} style={{ marginTop: 12 }}>Remove Access PIN</button>}
        {pinError && <p role="alert">{pinError} If asked to sign in again, use Sign out above and then sign in to return here.</p>}
        {pinNotice && <p role="status">{pinNotice}</p>}
      </section>}
      {page === 'profile' && import.meta.env.VITE_GOOGLE_CLIENT_ID && <section aria-labelledby="link-google-title" style={{ marginTop: 28, maxWidth: 400 }}>
        <h2 id="link-google-title">Link Google to this Health ID</h2>
        <p>Confirm your current HID password, complete the security check, and choose the Google account you want to link. Matching email addresses alone never link accounts.</p>
        <PasswordField id="google-link-password" label="Current HID password" value={linkPassword} onChange={setLinkPassword} autoComplete="current-password" />
        <TurnstileWidget action="patient-login" onTokenChange={setLinkTurnstileToken} resetKey={linkTurnstileResetKey} />
        <GoogleIdentityButton text="continue_with" disabled={linkBusy || !linkPassword || !ensureCaptchaReady(linkTurnstileToken)}
          onIdentity={identity => linkGoogle(identity.credential)} />
        {linkError && <p role="alert">{linkError}</p>}
        {linkNotice && <p role="status">{linkNotice}</p>}
      </section>}</>}
      {page === 'records' && (records ? <RecordSummary key={profile.patientId} records={records} onDownload={carePortalApi.ownAttachment} /> : <p role="status">Loading released records…</p>)}
      {page === 'biodata' && (records ? <ImportedMedicalHistory records={[]} healthProfile={records.importedHealthProfile} /> : <p role="status">Loading health profile…</p>)}
      {page === 'notifications' && <section aria-label="Preserved notifications"><h2>Earlier notifications</h2>
        {importedNotifications === null ? <p role="status">Loading earlier notifications…</p> : importedNotifications.length === 0 ? <p>No earlier notifications are available.</p>
          : importedNotifications.map(item => <article key={item.id}><h3>{item.title}</h3><p style={{whiteSpace:'pre-wrap'}}>{item.message}</p>
            <p>{new Date(item.createdAt).toLocaleString()} · {item.readAt ? 'Read' : 'Unread'}</p>
            {!item.readAt && <button onClick={() => { void carePortalApi.markImportedNotificationRead(item.id).then(result => {
              setImportedNotifications(current => current?.map(row => row.id === result.id ? {...row,readAt:result.readAt} : row) ?? null)
            }).catch(() => setError('The notification could not be marked as read.')) }}>Mark as read</button>}
          </article>)}
        <div>{notificationOffset > 0 && <button onClick={() => setNotificationOffset(value => Math.max(0,value-50))}>Newer notifications</button>}
          {importedNotifications?.length === 50 && <button onClick={() => setNotificationOffset(value => value+50)}>Older notifications</button>}</div>
      </section>}
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
