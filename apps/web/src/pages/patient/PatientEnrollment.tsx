import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { HIDLogo } from '../../components/HIDLogo'
import { GoogleIdentityButton } from '../../components/GoogleIdentityButton'
import { OtpInputs } from '../../components/OtpInputs'
import { PasswordField } from '../../components/PasswordField'
import { TurnstileWidget } from '../../components/TurnstileWidget'
import { ensureCaptchaReady, isCaptchaBypassAllowed, isTurnstileConfigured } from '../../lib/captcha'
import { identityClient } from '../../lib/identityClient'
import {
  newEnrollmentIdempotencyKey,
  isEnrollmentIdempotencyKey,
  patientEnrollmentApi,
  type EnrollmentContactChannel,
  type PatientContactChallenge,
  type PatientEnrollmentProgress,
} from '../../lib/patientEnrollmentApi'
import './PatientEnrollment.css'

type Screen = 'loading' | 'unavailable' | 'nin' | 'contact' | 'otp' | 'password' | 'complete'
type TimedChallenge = PatientContactChallenge & { expiresAtMs: number; resendAtMs: number }
const START_KEY_STORAGE = 'hid:patient-enrollment-start-key'

function storedStartKey() {
  if (typeof window === 'undefined') return null
  try {
    const value = window.sessionStorage.getItem(START_KEY_STORAGE)
    return value && isEnrollmentIdempotencyKey(value)
      ? value : null
  } catch { return null }
}

function persistStartKey(value: string | null) {
  if (typeof window === 'undefined') return
  if (value && !isEnrollmentIdempotencyKey(value)) return
  try {
    if (value) window.sessionStorage.setItem(START_KEY_STORAGE, value)
    else window.sessionStorage.removeItem(START_KEY_STORAGE)
  } catch { /* Private browsing may disallow session storage; in-memory retry still works. */ }
}

function timedChallenge(value: PatientContactChallenge): TimedChallenge {
  const now = Date.now()
  return {
    ...value,
    expiresAtMs: now + Math.max(0, value.expiresInSeconds) * 1000,
    resendAtMs: now + Math.max(0, value.resendAfterSeconds) * 1000,
  }
}

function requestError(cause: unknown, fallback: string) {
  const status = cause && typeof cause === 'object' && 'status' in cause ? cause.status : null
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
  if (status === 409 && code === 'CONTACT_ALREADY_REGISTERED') return 'This contact is already linked to a Health ID. Choose another contact or sign in.'
  if (status === 409 && code === 'ENROLLMENT_STAGE_INVALID') return 'This enrollment step is no longer current. Refresh to resume.'
  if (status === 409 && code === 'NIN_ALREADY_REGISTERED') return 'This NIN already has a Health ID or a pending enrollment. Sign in or contact support if you believe this is an error.'
  if (status === 409 && code === 'GOOGLE_ONBOARDING_REQUIRES_SIGN_OUT') return 'Sign out of your current Health ID account before starting a new Google enrollment.'
  if (status === 409 && code === 'PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT') return 'Sign out of your current Health ID account before starting a new enrollment.'
  if (status === 409 && code === 'GOOGLE_EXISTING_ACCOUNT_LINK_REQUIRED') return 'This Google identity needs account linking. Sign in to your existing Health ID, then link Google from your profile.'
  if ((status === 401 || status === 404) && (code === 'GOOGLE_ONBOARDING_EXPIRED'
    || code === 'GOOGLE_ONBOARDING_NOT_FOUND')) return 'Google confirmation expired. Continue with Google again to finish this enrollment.'
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return 'A previous enrollment retry key expired. Complete the security check and try again.'
  if (status === 409) return 'This enrollment changed. Refresh the page and try again.'
  if (status === 429) return 'Too many attempts. Wait a while before trying again.'
  if (status === 503) return 'Verification is temporarily unavailable. Your Health ID has not been activated. Try again later.'
  if (cause instanceof Error && status == null) return cause.message
  return fallback
}

function screenFromProgress(progress: PatientEnrollmentProgress): Screen {
  if (progress.stage === 'set_password') return 'password'
  if (progress.stage === 'active') return 'complete'
  return progress.challengeId ? 'otp' : 'contact'
}

export default function PatientEnrollment() {
  const navigate = useNavigate()
  const [screen, setScreen] = useState<Screen>('loading')
  const [nin, setNin] = useState('')
  const [channel, setChannel] = useState<EnrollmentContactChannel | null>(null)
  const [contact, setContact] = useState('')
  const [maskedContact, setMaskedContact] = useState('')
  const [challenge, setChallenge] = useState<TimedChallenge | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [hidCode, setHidCode] = useState('')
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileResetKey, setTurnstileResetKey] = useState(0)
  const [googleTurnstileToken, setGoogleTurnstileToken] = useState<string | null>(null)
  const [googleTurnstileResetKey, setGoogleTurnstileResetKey] = useState(0)
  const [googlePendingExpiresAt, setGooglePendingExpiresAt] = useState<number | null>(null)
  const [googleRequired, setGoogleRequired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const startKey = useRef<string | null>(storedStartKey())
  const submittedNin = useRef<string | null>(null)
  const verifyingCode = useRef(false)
  const lastGoogleBindExpiry = useRef<number | null>(null)
  const captchaAvailable = isTurnstileConfigured() || isCaptchaBypassAllowed()
  const googlePending = googlePendingExpiresAt !== null && googlePendingExpiresAt > now

  useEffect(() => {
    let active = true
    void patientEnrollmentApi.current().then(progress => {
      if (!active) return
      if (progress.stage === 'active') { startKey.current = null; persistStartKey(null) }
      if (progress.hidCode) setHidCode(progress.hidCode)
      setGoogleRequired(progress.googleOnboardingRequired === true)
      setChannel(progress.contactChannel ?? null)
      setMaskedContact(progress.maskedContact ?? '')
      if (progress.challengeId && typeof progress.expiresInSeconds === 'number') {
        setChallenge(timedChallenge({
          challengeId: progress.challengeId,
          expiresInSeconds: progress.expiresInSeconds,
          resendAfterSeconds: progress.resendAfterSeconds ?? 0,
        }))
      }
      setScreen(screenFromProgress(progress))
    }).catch(cause => {
      if (!active) return
      if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 404) {
        setScreen('nin')
      } else {
        setError('We could not check your pending enrollment. Try again.')
        setScreen('unavailable')
      }
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    void identityClient.auth.googleOnboarding()
      .then(result => {
        const expiresAt = Date.parse(result.expiresAt)
        if (active) setGooglePendingExpiresAt(Number.isFinite(expiresAt) && expiresAt > Date.now()
          ? expiresAt : null)
      })
      .catch(() => { if (active) setGooglePendingExpiresAt(null) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (screen !== 'otp' && googlePendingExpiresAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [screen, googlePendingExpiresAt])

  useEffect(() => {
    if (!googleRequired || !googlePending || googlePendingExpiresAt === null
      || screen === 'loading' || screen === 'unavailable' || screen === 'nin'
      || screen === 'complete' || lastGoogleBindExpiry.current === googlePendingExpiresAt) return
    lastGoogleBindExpiry.current = googlePendingExpiresAt
    void patientEnrollmentApi.bindGoogle().catch(cause => {
      lastGoogleBindExpiry.current = null
      setGooglePendingExpiresAt(null)
      setError(requestError(cause, 'Google confirmation could not be attached to this enrollment.'))
    })
  }, [googlePending, googlePendingExpiresAt, googleRequired, screen])

  async function run(task: () => Promise<void>, fallback: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try { await task() }
    catch (cause) { setError(requestError(cause, fallback)) }
    finally { setBusy(false) }
  }

  function submitNin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (googleRequired && !googlePending) {
      setError('Continue with Google again before verifying your NIN.')
      return
    }
    if (!ensureCaptchaReady(turnstileToken)) {
      setError('Complete the security check before verifying your NIN.')
      return
    }
    void run(async () => {
      const key = startKey.current ?? newEnrollmentIdempotencyKey()
      startKey.current = key
      submittedNin.current = nin
      persistStartKey(key)
      try {
        const progress = await patientEnrollmentApi.start(nin, turnstileToken, key)
        setNin('')
        setGoogleRequired(progress.googleOnboardingRequired === true || googleRequired)
        setChannel(progress.contactChannel ?? null)
        setMaskedContact(progress.maskedContact ?? '')
        setScreen(screenFromProgress(progress))
      } catch (cause) {
        if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'IDEMPOTENCY_KEY_REUSED') {
          startKey.current = null
          persistStartKey(null)
        }
        throw cause
      } finally {
        setTurnstileToken(null)
        setTurnstileResetKey(value => value + 1)
      }
    }, 'Your NIN could not be verified. Check it and try again.')
  }

  async function continueWithGoogle(credential: string) {
    if (!ensureCaptchaReady(googleTurnstileToken)) {
      setError('Complete the Google security check first.')
      return
    }
    await run(async () => {
      try {
        const result = await identityClient.auth.beginGooglePatientEnrollment({
          token: credential, turnstileToken: googleTurnstileToken ?? '',
        })
        if (result.stage === 'linked') {
          navigate('/patient/profile', { replace: true })
          return
        }
        const expiresAt = Date.parse(result.expiresAt)
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          throw new Error('Google confirmation expired. Continue with Google again.')
        }
        if (screen !== 'nin') await patientEnrollmentApi.bindGoogle()
        lastGoogleBindExpiry.current = expiresAt
        setGooglePendingExpiresAt(expiresAt)
        setGoogleRequired(true)
      } finally {
        setGoogleTurnstileToken(null)
        setGoogleTurnstileResetKey(value => value + 1)
      }
    }, 'Google identity confirmation could not be completed.')
  }

  function submitContact(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!channel) { setError('Choose phone or email.'); return }
    void run(async () => {
      const result = await patientEnrollmentApi.contact(channel, contact)
      setChallenge(timedChallenge(result))
      setMaskedContact('')
      setCode('')
      setScreen('otp')
    }, 'We could not send a code to that contact. Check it and try again.')
  }

  function verifySubmittedCode(submittedCode: string) {
    if (busy || verifyingCode.current || !/^\d{6}$/.test(submittedCode)) return
    verifyingCode.current = true
    void run(async () => {
      if (!challenge || now >= challenge.expiresAtMs) throw new Error('This code has expired. Request another code.')
      await patientEnrollmentApi.verifyContact(challenge.challengeId, submittedCode)
      setCode('')
      setContact('')
      setChallenge(null)
      setScreen('password')
    }, 'That code could not be verified. Check it or request another code.')
      .finally(() => { verifyingCode.current = false })
  }

  function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    verifySubmittedCode(code)
  }

  function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (password !== confirmation) { setError('Passwords do not match.'); return }
    if (googleRequired && !googlePending) {
      setError('Continue with Google again before activating your Health ID.')
      return
    }
    void run(async () => {
      const result = await patientEnrollmentApi.activate(password)
      setPassword('')
      setConfirmation('')
      setHidCode(result.hidCode)
      setGooglePendingExpiresAt(null)
      setGoogleRequired(false)
      startKey.current = null
      persistStartKey(null)
      setScreen('complete')
    }, 'Your account could not be activated. Your verified enrollment can be resumed.')
  }

  const challengeExpired = Boolean(challenge && now >= challenge.expiresAtMs)
  const remainingSeconds = challenge ? Math.max(0, Math.ceil((challenge.expiresAtMs - now) / 1000)) : 0
  const accountContactLabel = channel === 'phone' ? 'HID account phone' : 'HID account email'

  return <main className="patient-enrollment-page">
    <div className="patient-enrollment-card">
      <div className="patient-enrollment-brand"><Link to="/" aria-label="Health Identity Directory home"><HIDLogo size="sm" /></Link></div>
      <div className="patient-enrollment-heading">
        <span className="patient-enrollment-eyebrow">Patient enrollment</span>
        <h1>Get your Health ID</h1>
        <p>Verify your identity, choose one HID account contact, and set a password.</p>
      </div>
      {screen !== 'loading' && screen !== 'unavailable' && screen !== 'complete' && <ol className="patient-enrollment-steps" aria-label="Enrollment progress">
        {['Verify identity', 'Verify contact', 'Set password'].map((label, index) => {
          const current = screen === 'nin' ? 0 : screen === 'contact' || screen === 'otp' ? 1 : 2
          return <li key={label} className={index === current ? 'current' : index < current ? 'done' : ''} aria-current={index === current ? 'step' : undefined}><span>{index + 1}</span>{label}</li>
        })}
      </ol>}

      {error && <div className="patient-enrollment-error" role="alert">{error}</div>}
      {googlePending && (googleRequired || screen === 'nin') && screen !== 'complete'
        && <p role="status">Google authentication is current. Complete NIN, contact, and password verification before it expires.</p>}
      {googleRequired && !googlePending && screen !== 'complete' && <p role="alert">Google confirmation is required for this enrollment. Continue with Google again before activation.</p>}
      {screen === 'loading' && <p role="status">Checking for a pending enrollment…</p>}
      {screen === 'unavailable' && <div className="patient-enrollment-section"><h2>Enrollment unavailable</h2><p>Refresh this page to check your pending enrollment.</p><button type="button" onClick={() => window.location.reload()}>Try again</button></div>}

      {screen === 'nin' && <form className="patient-enrollment-section" onSubmit={submitNin}>
        <h2>Verify your identity</h2>
        <p>Enter your NIN. HID uses the verified identity returned by QoreID to prepare your account.</p>
        <label htmlFor="enrollment-nin">National Identification Number (NIN)</label>
        <input id="enrollment-nin" type="text" inputMode="numeric" pattern="[0-9]{11}" maxLength={11} autoComplete="off" spellCheck={false} placeholder="11-digit NIN" required value={nin} onChange={event => {
          const next = event.target.value.replace(/\D/g, '').slice(0, 11)
          setNin(next)
          if (submittedNin.current && submittedNin.current !== next) {
            submittedNin.current = null
            startKey.current = null
            persistStartKey(null)
          }
        }} />
        <p className="patient-enrollment-help">Your NIN is used for identity verification. A Health ID is issued only after contact verification and password setup.</p>
        {!captchaAvailable && <p role="status" className="patient-enrollment-error">The security check is unavailable. Please try again later.</p>}
        <TurnstileWidget action="patient-enrollment" onTokenChange={setTurnstileToken} resetKey={turnstileResetKey} />
        <button type="submit" disabled={busy || !captchaAvailable || (googleRequired && !googlePending)}>{busy ? 'Verifying…' : 'Verify NIN'}</button>
      </form>}
      {!googlePending && import.meta.env.VITE_GOOGLE_CLIENT_ID
        && (screen === 'nin' || (googleRequired && ['contact', 'otp', 'password'].includes(screen)))
        && <section className="patient-enrollment-section" aria-label="Continue with Google">
        <h2>{googleRequired ? 'Reconnect Google' : 'Continue with Google'}</h2>
        <p>{googleRequired
          ? 'Confirm the same Google identity again so HID can finish the existing verified enrollment.'
          : 'Google confirms your sign-in. You will still verify your NIN with QoreID and your chosen HID contact before a Health ID is activated.'}</p>
        <TurnstileWidget action="patient-login" onTokenChange={setGoogleTurnstileToken} resetKey={googleTurnstileResetKey} />
        <GoogleIdentityButton text="signup_with" disabled={busy || !ensureCaptchaReady(googleTurnstileToken)}
          onIdentity={identity => continueWithGoogle(identity.credential)} />
      </section>}

      {screen === 'contact' && <form className="patient-enrollment-section" onSubmit={submitContact}>
        <h2>Verify your contact</h2>
        <p>Choose how you want to receive your verification code.</p>
        <fieldset className="patient-enrollment-choices"><legend>HID account contact</legend>
          <label><input type="radio" name="contact-method" value="phone" checked={channel === 'phone'} onChange={() => { setChannel('phone'); setContact(''); setMaskedContact('') }} />Phone</label>
          <label><input type="radio" name="contact-method" value="email" checked={channel === 'email'} onChange={() => { setChannel('email'); setContact(''); setMaskedContact('') }} />Email</label>
        </fieldset>
        {channel && <><label htmlFor="enrollment-contact">{channel === 'phone' ? 'Phone number' : 'Email address'}</label>
          <input id="enrollment-contact" type={channel === 'phone' ? 'tel' : 'email'} autoComplete={channel === 'phone' ? 'tel' : 'email'} placeholder={channel === 'phone' ? '+2348012345678' : 'you@example.com'} maxLength={254} required value={contact} onChange={event => setContact(event.target.value)} />
          <p className="patient-enrollment-help">This is your HID account contact. Your phone number can differ from the number in your NIN record.</p></>}
        <button type="submit" disabled={busy || !channel}>{busy ? 'Sending…' : 'Send verification code'}</button>
      </form>}

      {screen === 'otp' && <form className="patient-enrollment-section" onSubmit={submitCode}>
        <h2>Enter your verification code</h2>
        <p>Enter the six-digit code sent to {maskedContact || (channel === 'phone' ? 'your phone' : 'your email')}.</p>
        <div role="group" aria-label="Verification code">
          <OtpInputs value={code} onChange={setCode} onComplete={verifySubmittedCode} />
        </div>
        <p className="patient-enrollment-help" role="status">{challengeExpired ? 'This code has expired. Request another code.' : `Code expires in ${remainingSeconds} seconds.`}</p>
        <button type="submit" disabled={busy || challengeExpired || !challenge}>{busy ? 'Checking…' : 'Verify code'}</button>
        <button className="patient-enrollment-text-button" type="button" disabled={busy} onClick={() => { setCode(''); setChallenge(null); setContact(''); setScreen('contact'); setError('') }}>Request another code or change contact</button>
      </form>}

      {screen === 'password' && <form className="patient-enrollment-section" onSubmit={submitPassword}>
        <h2>Set your password</h2>
        <p>{accountContactLabel} verified. Set a password to activate your Health ID.</p>
        <PasswordField id="enrollment-password" label="Password" autoComplete="new-password" minLength={12} value={password} onChange={setPassword} />
        <PasswordField id="enrollment-confirm-password" label="Confirm password" autoComplete="new-password" minLength={12} value={confirmation} onChange={setConfirmation} />
        <p className="patient-enrollment-help">Use at least 12 characters. Your identity, contact, and password must all be complete before activation.</p>
        <button type="submit" disabled={busy || (googleRequired && !googlePending)}>{busy ? 'Activating…' : 'Activate Health ID'}</button>
      </form>}

      {screen === 'complete' && <section className="patient-enrollment-section" role="status">
        <h2>Your Health ID is active</h2>
        {hidCode && <p className="patient-enrollment-hid">{hidCode}</p>}
        <p>Use your Health ID or verified email and password to sign in.</p>
        <Link className="patient-enrollment-primary-link" to="/patient">Sign in to your Health ID</Link>
      </section>}
      <p className="patient-enrollment-signin">I already have a Health ID. <Link to="/patient">Sign in</Link></p>
    </div>
  </main>
}
