import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { identityClient, getSafeSession } from '../lib/identityClient'
import { TurnstileWidget } from './TurnstileWidget'
import { useCaptchaGate } from '../hooks/useCaptchaGate'

type Challenge = { challengeId: string; expiresAt: number; resendAt: number }
export function AccountAccess({ patient }: { patient: boolean }) {
  const navigate = useNavigate()
  const [step, setStep] = useState<'login' | 'start' | 'verify' | 'complete'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [verification, setVerification] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now())
  const captcha = useCaptchaGate()
  const purpose = 'PASSWORD_RESET' as const
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!patient) return
    let active = true
    void getSafeSession().then(session => {
      if (active && session?.user.user_metadata.requested_role === 'patient') navigate('/patient/profile', { replace: true })
    }).catch(() => undefined)
    return () => { active = false }
  }, [navigate, patient])
  function changeStep(value: typeof step) {
    setStep(value); setPassword(''); setConfirmation(''); setCode(''); setVerification(''); setError(''); captcha.resetCaptcha()
    if (value === 'login' || value === 'start') setChallenge(null)
  }
  async function run(task: () => Promise<void>) {
    setBusy(true); setError('')
    try { await task() } catch (reason) { setError(reason instanceof Error ? reason.message : 'The request could not be completed.') }
    finally { setBusy(false) }
  }
  function startRecovery() {
    captcha.runWithCaptcha(token => run(async () => {
      try {
        const result = await identityClient.auth.startRecoveryOtp({ identifier: email.trim(), purpose,
          turnstileAction: patient ? 'patient-reset-start' : 'staff-reset', turnstileToken: token || undefined })
        if (result.error) throw result.error
        if (!result.data?.accepted) throw new Error('Recovery could not be started.')
        setChallenge({ challengeId: result.data.challengeId, expiresAt: Date.now() + result.data.expiresInSeconds * 1000, resendAt: Date.now() + result.data.resendAfterSeconds * 1000 })
        setCode(''); setVerification(''); setPassword(''); setStep('verify')
        setNotice('If this account is eligible, a recovery code will arrive at its registered email address.')
      } finally { captcha.resetCaptcha() }
    }))
  }
  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    if (step === 'login') {
      captcha.runWithCaptcha(token => run(async () => {
        try {
          const result = patient
            ? await identityClient.auth.signInPatientWithPassword({ email: email.trim(), password, turnstileToken: token || undefined })
            : await identityClient.auth.signInWithPassword({ email: email.trim(), password, options: { captchaToken: token || undefined, captchaAction: 'staff-login' } })
          if (result.error) throw result.error
          if (!result.data.session) throw new Error('A valid session was not returned.')
          setPassword('')
          navigate(patient ? '/patient/profile' : '/hospital/emergency', { replace: true })
        } finally { captcha.resetCaptcha() }
      }))
    } else if (step === 'start') startRecovery()
    else if (step === 'verify') void run(async () => {
      if (!challenge || challenge.expiresAt <= Date.now()) throw new Error('This code has expired. Request another code.')
      const result = await identityClient.auth.verifyRecoveryOtp({ challengeId: challenge.challengeId, purpose, code })
      if (result.error) throw result.error
      if (!result.data?.verified) throw new Error('Code verification failed.')
      setVerification(result.data.verificationToken); setCode(''); setStep('complete'); setNotice('Code verified. Set your new password.')
    })
    else void run(async () => {
      if (!challenge || !verification) throw new Error('Verify a recovery code first.')
      if (password.length < 12 || password.length > 256 || password !== confirmation) throw new Error('Use matching passwords of 12–256 characters.')
      const result = await identityClient.auth.completeRecoveryOtp({ challengeId: challenge.challengeId, purpose, verificationToken: verification, newPassword: password })
      if (result.error) throw result.error
      if (!result.data?.completed) throw new Error('Password recovery did not complete.')
      changeStep('login'); setNotice('Password saved. Sign in using your new password.')
    })
  }
  return <main style={{ maxWidth: 520, margin: '0 auto', padding: 24, lineHeight: 1.6 }}>
    <Link to="/">Health Identity Directory</Link>
    <h1>{patient ? 'Patient account' : 'Clinical account'}</h1>
    <h2>{step === 'login' ? 'Sign in' : step === 'start' ? 'Recover or activate your account' : step === 'verify' ? 'Verify your email code' : 'Set your password'}</h2>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
      {(step === 'login' || step === 'start') && <label>{step === 'login' ? 'Email' : 'Email or HID'}<input required type={step === 'login' ? 'email' : 'text'} autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>}
      {(step === 'login' || step === 'complete') && <label>Password<input required type="password" minLength={step === 'complete' ? 12 : undefined} maxLength={256} autoComplete={step === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>}
      {step === 'complete' && <label>Confirm password<input required type="password" minLength={12} maxLength={256} autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} style={{ display: 'block', width: '100%' }} /></label>}
      {step === 'verify' && <><label>Six-digit code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} style={{ display: 'block', width: '100%' }} /></label>
        <p>{challenge && now < challenge.expiresAt ? `Code expires in ${Math.ceil((challenge.expiresAt - now) / 1000)} seconds.` : 'Code expired. Request another code.'}</p></>}
      <TurnstileWidget action={step === 'login' ? patient ? 'patient-login' : 'staff-login' : patient ? 'patient-reset-start' : 'staff-reset'} onTokenChange={captcha.onTokenChange} resetKey={captcha.captchaResetKey} visible={captcha.captchaVisible} message={captcha.captchaNotice?.message} messageTone={captcha.captchaNotice?.tone} />
      <button disabled={busy || (step === 'verify' && (!challenge || now >= challenge.expiresAt))} type="submit">{busy ? 'Working…' : step === 'login' ? 'Sign in' : step === 'start' ? 'Send recovery code' : step === 'verify' ? 'Verify code' : 'Save password'}</button>
    </form>
    {step === 'verify' && <button disabled={busy || !challenge || now < challenge.resendAt} onClick={startRecovery}>Send another code{challenge && now < challenge.resendAt ? ` (${Math.ceil((challenge.resendAt - now) / 1000)}s)` : ''}</button>}
    <p><button disabled={busy} onClick={() => changeStep(step === 'login' ? 'start' : 'login')}>{step === 'login' ? 'Forgot password or activate an issued account' : 'Back to sign in'}</button></p>
    {patient && <section><h2>Register for HID</h2><p>Visit an authorized facility to verify your identity and register your patient account. Once the facility issues your account, use your registered email above to activate it and set a password.</p></section>}
  </main>
}
