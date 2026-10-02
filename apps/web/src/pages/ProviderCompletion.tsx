import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { TurnstileWidget } from '../components/TurnstileWidget'
import { CommercialLayout } from '../features/commercial/CommercialLayout'
import { ensureCaptchaReady, isCaptchaBypassAllowed, isTurnstileConfigured } from '../lib/captcha'
import { normalizeCacRegistrationNumber, type ProductCode } from '../lib/organizationApplicationApi'
import {
  getOrganizationCompletionProfile, saveOrganizationCompletionProfile,
  startOrganizationCompletion, verifyOrganizationCompletion,
  type OrganizationCompletionProfile, type OrganizationProfileFieldName,
  type OrganizationProfilePatch,
} from '../lib/organizationCompletionApi'

const products: Array<{ value: ProductCode; label: string }> = [
  { value: 'ehr', label: 'HID EHR' },
  { value: 'migrate', label: 'HID Migrate' },
  { value: 'laboratory', label: 'HID Laboratory' },
  { value: 'pharmacy', label: 'HID Pharmacy' },
]
const fields: Array<{ name: OrganizationProfileFieldName; label: string; hint: string }> = [
  { name: 'companyName', label: 'Registered organization name', hint: 'Use the name on your CAC record.' },
  { name: 'entityType', label: 'Legal entity type', hint: 'For example, business name or limited company.' },
  { name: 'registrationDate', label: 'Registration date', hint: 'Use the date on your CAC record.' },
  { name: 'address', label: 'Registered address', hint: 'Use the organization’s registered address.' },
  { name: 'registryStatus', label: 'Registry status', hint: 'Self-reported status is reviewed by HID.' },
]

export default function ProviderCompletion() {
  const [productCode, setProductCode] = useState<ProductCode>('ehr')
  const [cacRegistrationNumber, setCacRegistrationNumber] = useState('')
  const [administratorEmail, setAdministratorEmail] = useState('')
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileResetKey, setTurnstileResetKey] = useState(0)
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [profile, setProfile] = useState<OrganizationCompletionProfile | null>(null)
  const [entries, setEntries] = useState<OrganizationProfilePatch>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const securityCheckAvailable = isTurnstileConfigured() || isCaptchaBypassAllowed()

  useEffect(() => {
    let active = true
    void getOrganizationCompletionProfile().then(result => {
      if (active) setProfile(result)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  async function start(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError('')
    if (!ensureCaptchaReady(turnstileToken)) {
      setError('Complete the security check before requesting an email code.')
      return
    }
    setBusy(true)
    try {
      const result = await startOrganizationCompletion({
        productCode, cacRegistrationNumber, administratorEmail, turnstileToken: turnstileToken ?? '',
      })
      setChallengeId(result.challengeId)
      setNotice('If this application is eligible for profile completion, a code was sent to the administrator email on the application.')
    } catch {
      setError('The code request could not be completed. Check your details and try again later.')
    } finally {
      setTurnstileToken(null)
      setTurnstileResetKey(value => value + 1)
      setBusy(false)
    }
  }

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!challengeId || busy) return
    setError('')
    setBusy(true)
    try {
      await verifyOrganizationCompletion(challengeId, code)
      const result = await getOrganizationCompletionProfile()
      setProfile(result)
      setNotice('')
      setCode('')
    } catch {
      setError('The email code is invalid or expired. Request a new code if needed.')
    } finally { setBusy(false) }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!profile || busy) return
    setError('')
    setBusy(true)
    try {
      const result = await saveOrganizationCompletionProfile(profile, entries)
      setProfile(result)
      setEntries({})
      setNotice(result.status === 'ready_for_review'
        ? 'Your organization profile is complete and awaiting HID review.'
        : 'Your details were saved. Complete the remaining fields to continue.')
    } catch {
      setError('The profile could not be saved. Reload your profile and try again.')
    } finally { setBusy(false) }
  }

  return <CommercialLayout><main>
    <section className="commercial-hero"><div className="commercial-shell">
      <div className="commercial-eyebrow">Organization onboarding</div>
      <h1>Complete your organization profile.</h1>
      <p>After HID verifies your CAC identifier, you can supply details that QoreID did not return. Each field keeps its source for HID review.</p>
    </div></section>
    <section className="commercial-section"><div className="commercial-shell provider-application-shell">
      {error && <div className="provider-application-error" role="alert">{error}</div>}
      {notice && <div className="commercial-card" role="status">{notice}</div>}
      {profile ? <div className="commercial-card provider-application-form">
        <h2>{profile.status === 'ready_for_review' ? 'Profile submitted for review' : 'Organization details'}</h2>
        <p>QoreID verified the CAC lookup for <strong>{profile.registrationNumber}</strong>. A provider value is locked; a value you enter is marked user provided.</p>
        <form onSubmit={event => { void save(event) }}>
          {fields.map(({ name, label, hint }) => {
            const field = profile.fields[name]
            const editable = profile.status === 'pending_verification' && field.source !== 'qoreid'
            return <label key={name}>{label}
              {editable
                ? name === 'registryStatus'
                  ? <select className="commercial-input" value={entries[name] ?? field.value ?? ''} onChange={event => setEntries(current => ({ ...current, [name]: event.target.value }))}>
                      <option value="">Select status</option><option value="active">Active (self-reported)</option>
                    </select>
                  : <input className="commercial-input" value={entries[name] ?? field.value ?? ''}
                      onChange={event => setEntries(current => ({ ...current, [name]: event.target.value }))}
                      type={name === 'registrationDate' ? 'date' : 'text'}
                      maxLength={name === 'address' ? 1000 : name === 'companyName' ? 200 : 120} />
                : <input className="commercial-input" value={field.value ?? ''} readOnly />}
              <span className="provider-application-help">{field.source === 'qoreid'
                ? 'Provided by QoreID'
                : field.source === 'user_provided' ? 'Provided by applicant; subject to HID review' : hint}</span>
            </label>
          })}
          {profile.status === 'pending_verification' && <button className="commercial-button primary"
            type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save missing details'}</button>}
        </form>
        <p className="provider-application-help">CAC lookup verification does not establish an applicant’s authority to act for the organization. HID reviews that separately before granting access.</p>
        <Link className="commercial-button" to="/">Return to home</Link>
      </div> : challengeId ? <form className="commercial-card provider-application-form" onSubmit={event => { void verify(event) }}>
        <h2>Confirm administrator email</h2>
        <p>Enter the six-digit code if one was sent. This confirms access to the application contact email.</p>
        <label>Email code <input className="commercial-input" value={code} onChange={event => setCode(event.target.value)}
          inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required /></label>
        <button className="commercial-button primary" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
        <button className="commercial-button" type="button" onClick={() => { setChallengeId(null); setCode(''); setNotice('') }}>Request a new code</button>
      </form> : <form className="commercial-card provider-application-form" onSubmit={event => { void start(event) }}>
        <h2>Find your application</h2>
        <p>Use the same product, CAC identifier, and administrator email from your application. Completion is available after a successful CAC check.</p>
        <label>Product <select className="commercial-input" value={productCode}
          onChange={event => setProductCode(event.target.value as ProductCode)}>
          {products.map(product => <option key={product.value} value={product.value}>{product.label}</option>)}
        </select></label>
        <label>CAC registration identifier <input className="commercial-input" value={cacRegistrationNumber}
          onChange={event => setCacRegistrationNumber(normalizeCacRegistrationNumber(event.target.value))}
          autoCapitalize="characters" autoComplete="off" spellCheck={false}
          pattern="(RC|BN|IT)[0-9]{4,20}" maxLength={22} required /></label>
        <label>Administrator email <input className="commercial-input" type="email" value={administratorEmail}
          onChange={event => setAdministratorEmail(event.target.value)} maxLength={254} required /></label>
        {!securityCheckAvailable && <div className="provider-application-error" role="status">The security check is unavailable. Try again later.</div>}
        <TurnstileWidget action="organization-completion" onTokenChange={setTurnstileToken} resetKey={turnstileResetKey} />
        <button className="commercial-button primary" type="submit" disabled={busy || !securityCheckAvailable}>{busy ? 'Requesting…' : 'Send email code'}</button>
      </form>}
    </div></section>
  </main></CommercialLayout>
}
