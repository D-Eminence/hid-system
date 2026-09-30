import React, { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { TurnstileWidget } from '../components/TurnstileWidget'
import { CommercialLayout } from '../features/commercial/CommercialLayout'
import { ensureCaptchaReady, isCaptchaBypassAllowed, isTurnstileConfigured } from '../lib/captcha'
import { PROVIDER_ACCESS_HREF } from '../lib/providerAccess'
import {
  normalizeCacRegistrationNumber,
  productOptions,
  submitOrganizationApplication,
  type OrganizationApplicationInput,
  type OrganizationType,
  type ProductCode,
} from '../lib/organizationApplicationApi'

const organizationTypes: Array<{ value: OrganizationType; label: string }> = [
  { value: 'hospital', label: 'Hospital' },
  { value: 'clinic', label: 'Clinic' },
  { value: 'laboratory', label: 'Laboratory' },
  { value: 'pharmacy', label: 'Pharmacy' },
]
const productLabels: Record<ProductCode, string> = {
  ehr: 'HID EHR',
  migrate: 'HID Migrate',
  laboratory: 'HID Laboratory',
  pharmacy: 'HID Pharmacy',
}

function initialSelection(product: string | null): { organizationType: OrganizationType; productCode: ProductCode } {
  if (product === 'laboratory') return { organizationType: 'laboratory', productCode: 'laboratory' }
  if (product === 'pharmacy') return { organizationType: 'pharmacy', productCode: 'pharmacy' }
  if (product === 'migrate') return { organizationType: 'hospital', productCode: 'migrate' }
  return { organizationType: 'hospital', productCode: 'ehr' }
}

export default function ProviderApplication() {
  const [searchParams] = useSearchParams()
  const [selection, setSelection] = useState(() => initialSelection(searchParams.get('product')))
  const [organizationName, setOrganizationName] = useState('')
  const [cacRegistrationNumber, setCacRegistrationNumber] = useState('')
  const [administratorName, setAdministratorName] = useState('')
  const [administratorEmail, setAdministratorEmail] = useState('')
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileResetKey, setTurnstileResetKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState(false)
  const securityCheckAvailable = isTurnstileConfigured() || isCaptchaBypassAllowed()

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || accepted) return
    setError('')
    if (!ensureCaptchaReady(turnstileToken)) {
      setError('Complete the security check before submitting your application.')
      return
    }
    const input: OrganizationApplicationInput = {
      ...selection,
      organizationName,
      cacRegistrationNumber,
      administratorName,
      administratorEmail,
      turnstileToken: turnstileToken ?? '',
    }
    setBusy(true)
    try {
      await submitOrganizationApplication(input)
      setAccepted(true)
      setOrganizationName('')
      setCacRegistrationNumber('')
      setAdministratorName('')
      setAdministratorEmail('')
    } catch (cause) {
      const message = cause instanceof Error && !('status' in cause)
        ? cause.message
        : 'The application could not be received right now. Check your details and try again.'
      setError(message)
    } finally {
      setTurnstileToken(null)
      setTurnstileResetKey(value => value + 1)
      setBusy(false)
    }
  }

  return <CommercialLayout><main>
    <section className="commercial-hero"><div className="commercial-shell">
      <div className="commercial-eyebrow">Join the HID provider network</div>
      <h1>Apply for organization access.</h1>
      <p>Tell us about your hospital, clinic, laboratory, or pharmacy. HID reviews each organization before any staff access is created.</p>
      <div className="commercial-actions"><a className="commercial-button" href={PROVIDER_ACCESS_HREF}>Already have access? Sign in</a></div>
    </div></section>
    <section className="commercial-section"><div className="commercial-shell provider-application-shell">
      {accepted ? <div className="commercial-card" role="status">
        <h2>Application received</h2>
        <p>We received your request. If eligible, HID will verify the registered organization and review access. Submission does not create an account or grant clinical access.</p>
        <Link className="commercial-button" to="/">Return to home</Link>
      </div> : <form className="commercial-card provider-application-form" onSubmit={event => { void submit(event) }}>
        <h2>Organization details</h2>
        <p>Use the legal organization name and CAC registration number. The registered entity must be verified before an administrator can approve access.</p>
        {error && <div className="provider-application-error" role="alert">{error}</div>}
        <label>Organization type
          <select className="commercial-input" value={selection.organizationType} onChange={event => {
            const organizationType = event.target.value as OrganizationType
            setSelection({ organizationType, productCode: productOptions[organizationType][0] })
          }} required>
            {organizationTypes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>Product of interest
          <select className="commercial-input" value={selection.productCode} onChange={event => setSelection(current => ({ ...current, productCode: event.target.value as ProductCode }))} required>
            {productOptions[selection.organizationType].map(product => <option key={product} value={product}>{productLabels[product]}</option>)}
          </select>
        </label>
        <label>Legal organization name
          <input className="commercial-input" value={organizationName} onChange={event => setOrganizationName(event.target.value)} type="text" autoComplete="organization" minLength={2} maxLength={200} required />
        </label>
        <label>CAC registration number
          <input className="commercial-input" value={cacRegistrationNumber} onChange={event => setCacRegistrationNumber(normalizeCacRegistrationNumber(event.target.value))} type="text" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={22} pattern="(RC|BN|IT)[0-9]{4,20}" title="Include the RC, BN, or IT prefix followed by 4 to 20 digits" placeholder="RC123456" required />
          <span className="provider-application-help">Include the RC, BN, or IT prefix. Spaces are removed as you type.</span>
        </label>
        <h2>Administrator contact</h2>
        <label>Administrator full name
          <input className="commercial-input" value={administratorName} onChange={event => setAdministratorName(event.target.value)} type="text" autoComplete="name" minLength={2} maxLength={200} required />
        </label>
        <label>Administrator email
          <input className="commercial-input" value={administratorEmail} onChange={event => setAdministratorEmail(event.target.value)} type="email" autoComplete="email" maxLength={254} required />
        </label>
        <p className="provider-application-help">Submitting this form does not verify your identity or create credentials. HID may need additional evidence before approving access.</p>
        {!securityCheckAvailable && <div className="provider-application-error" role="status">The security check is unavailable. Please try again later.</div>}
        <TurnstileWidget action="organization-application" onTokenChange={setTurnstileToken} resetKey={turnstileResetKey} />
        <button className="commercial-button primary" type="submit" disabled={busy || !securityCheckAvailable}>{busy ? 'Submitting…' : 'Submit application'}</button>
      </form>}
    </div></section>
  </main></CommercialLayout>
}
