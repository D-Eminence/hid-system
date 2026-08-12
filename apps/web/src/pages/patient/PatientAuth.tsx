import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthLegalConsent } from '../../components/AuthLegalConsent'
import { AuthShell } from '../../components/AuthShell'
import { FacilityPicker } from '../../components/FacilityPicker'
import { GoogleIdentityButton } from '../../components/GoogleIdentityButton'
import { OtpInputs } from '../../components/OtpInputs'
import { TurnstileWidget } from '../../components/TurnstileWidget'
import { Button, Input, Select, showToast } from '../../components/ui'
import { useCaptchaGate } from '../../hooks/useCaptchaGate'
import { clearPatientSession, getPatientSession, setPatientSession } from '../../lib/auth'
import {
  completePatientPasswordReset,
  fetchMyPatient,
  finalizeGoogleSignIn,
  patientSignIn,
  patientSignUpWithPassword,
  startPatientPasswordReset,
  verifyPatientSignupOtp,
  verifyPatientPasswordResetCode,
  signInWithGoogleIdToken,
} from '../../lib/hidApi'
import { trackEvent } from '../../lib/observabilityBridge'
import type { GoogleIdentitySelection } from '../../lib/googleIdentity'
import { getSafeUser, safeSignOut, identityClient } from '../../lib/identityClient'
import { PASSWORD_REQUIREMENTS_TEXT, isStrongPassword, maskEmailAddress } from '../../lib/utils'

type Step = 'signup' | 'password' | 'verify' | 'success' | 'signin' | 'forgot'

function actionButtonStyle(active: boolean) {
  return { marginTop: 16, background: active ? '#1f8cff' : '#9aa6b2' }
}

function SegmentedTabs({ active, onChange }: { active: 'signin' | 'signup'; onChange: (value: 'signin' | 'signup') => void }) {
  return (
    <div style={{ background: '#f5f7fa', borderRadius: 999, padding: 4, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
      {[
        { key: 'signin', label: 'Sign In' },
        { key: 'signup', label: 'Sign Up' },
      ].map(item => (
        <button
          key={item.key}
          onClick={() => onChange(item.key as 'signin' | 'signup')}
          style={{
            border: 'none',
            borderRadius: 999,
            padding: '10px 14px',
            fontSize: 12,
            fontWeight: 600,
            background: active === item.key ? '#fff' : 'transparent',
            color: active === item.key ? '#111827' : '#9aa5b5',
            boxShadow: active === item.key ? '0 4px 12px rgba(17, 24, 39, 0.06)' : 'none',
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

type ForgotState = {
  challengeId: string
  confirmPassword: string
  deliveryChannels: Array<'email'>
  expiresAt: string
  identifier: string
  maskedEmail: string
  otp: string
  password: string
  verificationToken: string
}

function emptyForgotState(): ForgotState {
  return {
    challengeId: '',
    confirmPassword: '',
    deliveryChannels: [],
    expiresAt: '',
    identifier: '',
    maskedEmail: '',
    otp: '',
    password: '',
    verificationToken: '',
  }
}

function describeResetTargets(state: ForgotState) {
  return state.maskedEmail || 'your registered email address'
}

function looksLikeEmail(value: string) {
  return /\S+@\S+\.\S+/.test(value.trim())
}

function looksLikePhone(value: string) {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15
}

export default function PatientAuth() {
  const navigate = useNavigate()
  const existingSession = useMemo(() => getPatientSession(), [])
  const [step, setStep] = useState<Step>('signup')
  const [loading, setLoading] = useState(false)
  const [generatedHid, setGeneratedHid] = useState('')
  const [hidCopied, setHidCopied] = useState(false)
  const [signupAccepted, setSignupAccepted] = useState(false)
  const [signup, setSignup] = useState({
    email: '',
    firstName: '',
    lastName: '',
    phone: '',
    hospitalCurrentlyUsing: '',
    gender: '',
    password: '',
    confirmPassword: '',
  })
  const [signin, setSignin] = useState({
    identifier: '',
    password: '',
  })
  const [forgot, setForgot] = useState<ForgotState>(() => emptyForgotState())
  const [forgotOtpVerified, setForgotOtpVerified] = useState(false)
  const [signupVerification, setSignupVerification] = useState({ challengeId: '', email: '', password: '', code: '' })
  const signupVerifyInFlightRef = useRef(false)
  const awaitingHidAcknowledgementRef = useRef(false)
  const {
    captchaNotice,
    captchaResetKey,
    captchaToken,
    captchaVisible,
    hideCaptcha,
    onTokenChange: handleCaptchaTokenChange,
    primeCaptcha,
    resetCaptcha,
    runWithCaptcha,
  } = useCaptchaGate()

  const canStartSignup = !!signup.firstName.trim() && !!signup.lastName.trim() && looksLikeEmail(signup.email) && looksLikePhone(signup.phone) && !!signup.gender && signupAccepted
  const canSignIn = !!signin.identifier.trim() && !!signin.password
  const canFinishSignup = signupAccepted && isStrongPassword(signup.password) && signup.password === signup.confirmPassword
  const canStartForgot = !!forgot.identifier.trim()
  const canResetPassword = forgotOtpVerified && isStrongPassword(forgot.password) && forgot.password === forgot.confirmPassword
  const signupCaptchaReady = step === 'password' && !!signup.password && !!signup.confirmPassword
  const signinCaptchaReady = step === 'signin' && canSignIn
  const forgotCaptchaReady = step === 'forgot' && !forgot.challengeId && canStartForgot

  useEffect(() => {
    let active = true

    const loadAuthenticatedPatient = async () => {
      try {
        const patient = await fetchMyPatient()
        if (!active) return
        setPatientSession({
          hidCode: patient.hid_code,
          phone: patient.phone ?? '',
          fullName: patient.full_name,
        })
        if (awaitingHidAcknowledgementRef.current) {
          setGeneratedHid(patient.hid_code)
          setHidCopied(false)
          setStep('success')
          return
        }
        navigate('/patient/profile', { replace: true })
      } catch {
        if (!active) return
        if (awaitingHidAcknowledgementRef.current) return
        clearPatientSession()
        const user = await getSafeUser()
        if (!active) return
        const isGoogleUser = Boolean(
          user?.identities?.some(identity => identity.provider === 'google') ||
          user?.app_metadata?.provider === 'google',
        )
        if (user && isGoogleUser) {
          try {
            const result = await finalizeGoogleSignIn('patient')
            if (!result.registered) {
              await safeSignOut().catch(() => {})
              if (!active) return
              clearPatientSession()
              setStep('signin')
              showToast('This Google account is not registered on HID. Use Sign Up first.', 'error')
              return
            }
          } catch (error) {
            if (!active) return
            showToast(error instanceof Error ? error.message : 'Unable to verify this Google account.', 'error')
            setStep('signin')
            return
          }
        }
        setSignup(current => ({
          ...current,
          email: user?.email ?? current.email,
          firstName: current.firstName || user?.user_metadata?.full_name?.split(' ')[0] || user?.user_metadata?.name?.split(' ')[0] || '',
          lastName: current.lastName || user?.user_metadata?.full_name?.split(' ').slice(1).join(' ') || user?.user_metadata?.name?.split(' ').slice(1).join(' ') || '',
        }))
        setStep(existingSession ? 'signin' : 'signup')
      }
    }

    void loadAuthenticatedPatient()
    const { data: { subscription } } = identityClient.auth.onAuthStateChange(() => {
      window.setTimeout(() => { void loadAuthenticatedPatient() }, 0)
    })

    return () => { active = false; subscription.unsubscribe() }
  }, [existingSession, navigate])

  useEffect(() => {
    resetCaptcha()
  }, [resetCaptcha, step])

  useEffect(() => {
    if (signupCaptchaReady || signinCaptchaReady || forgotCaptchaReady) {
      primeCaptcha()
      return
    }

    hideCaptcha()
  }, [captchaVisible, forgotCaptchaReady, hideCaptcha, primeCaptcha, signinCaptchaReady, signupCaptchaReady])

  function goToSignUpPassword() {
    if (!signupAccepted) {
      showToast('You must agree to the Terms of Service and Privacy Policy before creating an account', 'error')
      return
    }
    if (!canStartSignup) {
      showToast('Enter a valid name, email, phone number, and gender', 'error')
      return
    }
    setStep('password')
  }

  async function continueWithGoogleSignIn(identity: GoogleIdentitySelection) {
    setLoading(true)
    try {
      await signInWithGoogleIdToken('patient', identity.credential, identity.email)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Unable to continue with Google.', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function prefillSignupWithGoogle(identity: GoogleIdentitySelection) {
    setLoading(true)
    try {
      setSignup(current => ({
        ...current,
        email: identity.email,
        firstName: identity.firstName || current.firstName,
        lastName: identity.lastName || current.lastName,
      }))
      showToast('Google details added. Complete the form to continue sign-up.', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Unable to read your Google details.', 'error')
    } finally {
      setLoading(false)
    }
  }

  function finishSignup() {
    if (!signupAccepted) {
      showToast('You must agree to the Terms of Service and Privacy Policy before creating an account', 'error')
      return
    }
    if (!isStrongPassword(signup.password)) {
      showToast(PASSWORD_REQUIREMENTS_TEXT, 'error')
      return
    }
    if (signup.password !== signup.confirmPassword) {
      showToast('Passwords do not match', 'error')
      return
    }
    runWithCaptcha(token => void performSignup(token))
  }

  async function performSignup(captchaTokenOverride: string | null = captchaToken) {
    awaitingHidAcknowledgementRef.current = true
    setLoading(true)
    try {
      const result = await patientSignUpWithPassword({
        captchaToken: captchaTokenOverride,
        email: signup.email,
        firstName: signup.firstName,
        lastName: signup.lastName,
        phone: signup.phone,
        hospitalCurrentlyUsing: signup.hospitalCurrentlyUsing,
        gender: signup.gender,
        password: signup.password,
      })

      if (!result.profile) {
        awaitingHidAcknowledgementRef.current = false
        trackEvent('patient_signup_pending_verification')
        setSignupVerification({
          challengeId: result.challengeId,
          email: signup.email.trim().toLowerCase(),
          password: signup.password,
          code: '',
        })
        showToast('We sent a 6-digit verification code to your email. Enter it here to finish creating your account.', 'success')
        setStep('verify')
        return
      }

      trackEvent('patient_signup_completed')
      setGeneratedHid(result.profile.patient.hid_code)
      setHidCopied(false)
      setPatientSession({
        hidCode: result.profile.patient.hid_code,
        phone: result.profile.patient.phone_e164 ?? '',
        fullName: result.profile.patient.full_name,
      })
      showToast('Your HID is ready. Copy or save it before continuing.', 'success')
      setStep('success')
    } catch (error) {
      awaitingHidAcknowledgementRef.current = false
      const message = error instanceof Error ? error.message : 'Unable to create the account right now.'
      showToast(message, 'error')
    } finally {
      resetCaptcha()
      setLoading(false)
    }
  }

  function signIn() {
    if (!canSignIn) {
      showToast('Enter your HID code or email and password', 'error')
      return
    }
    runWithCaptcha(token => void performSignIn(token))
  }

  async function performSignIn(captchaTokenOverride: string | null = captchaToken) {
    setLoading(true)
    try {
      const profile = await patientSignIn(signin.identifier, signin.password, captchaTokenOverride)
      trackEvent('patient_signin_completed')
      setPatientSession({
        hidCode: profile.patient.hid_code,
        phone: profile.patient.phone_e164 ?? '',
        fullName: profile.patient.full_name,
      })
      navigate('/patient/profile')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The sign-in details are not correct.'
      if (error instanceof Error && message.toLowerCase().includes('email not confirmed') && looksLikeEmail(signin.identifier)) {
        setSignup(current => ({ ...current, email: signin.identifier.trim().toLowerCase(), password: signin.password, confirmPassword: signin.password }))
        setStep('signup')
        showToast('Finish sign-up again to receive a fresh verification code.', 'info')
        return
      }
      showToast(message, 'error')
    } finally {
      resetCaptcha()
      setLoading(false)
    }
  }

  async function verifySignupCode(nextCode = signupVerification.code) {
    if (signupVerifyInFlightRef.current) return
    if (nextCode.trim().length !== 6 || !signupVerification.challengeId || !signupVerification.email || !signupVerification.password) {
      showToast('Enter the full 6-digit verification code first.', 'error')
      return
    }

    signupVerifyInFlightRef.current = true
    awaitingHidAcknowledgementRef.current = true
    setLoading(true)
    try {
      const profile = await verifyPatientSignupOtp(signupVerification.challengeId, signupVerification.email, signupVerification.password, nextCode.trim())
      trackEvent('patient_signup_completed')
      setGeneratedHid(profile.patient.hid_code)
      setHidCopied(false)
      setPatientSession({
        hidCode: profile.patient.hid_code,
        phone: profile.patient.phone_e164 ?? '',
        fullName: profile.patient.full_name,
      })
      showToast('Email verified. Copy or save your HID before continuing.', 'success')
      setStep('success')
    } catch (error) {
      awaitingHidAcknowledgementRef.current = false
      const message = error instanceof Error ? error.message : 'The verification code is not correct.'
      showToast(message, 'error')
    } finally {
      signupVerifyInFlightRef.current = false
      setLoading(false)
    }
  }

  function resendSignupCode() {
    if (!signupVerification.email) {
      showToast('Start sign-up again before requesting a new verification code.', 'error')
      return
    }
    void performResendSignupCode(null)
  }

  async function performResendSignupCode(captchaTokenOverride: string | null = captchaToken) {
    setLoading(true)
    try {
      const result = await patientSignUpWithPassword({
        captchaToken: captchaTokenOverride,
        email: signupVerification.email || signup.email,
        firstName: signup.firstName,
        lastName: signup.lastName,
        phone: signup.phone,
        hospitalCurrentlyUsing: signup.hospitalCurrentlyUsing,
        gender: signup.gender,
        password: signupVerification.password || signup.password,
      })
      setSignupVerification(current => ({
        ...current,
        challengeId: result.challengeId,
        code: '',
      }))
      showToast('A new verification code has been sent to your email.', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send another verification code right now.'
      showToast(message, 'error')
    } finally {
      resetCaptcha()
      setLoading(false)
    }
  }

  function startForgotPassword() {
    if (!canStartForgot) {
      showToast('Enter your HID code or email address first', 'error')
      return
    }
    runWithCaptcha(token => void performStartForgotPassword(token))
  }

  function resendForgotPasswordCode() {
    if (!canStartForgot) {
      showToast('Enter your HID code or email address first', 'error')
      return
    }
    void performStartForgotPassword(null)
  }

  async function performStartForgotPassword(captchaTokenOverride: string | null = captchaToken) {
    setLoading(true)
    try {
      const result = await startPatientPasswordReset(forgot.identifier, captchaTokenOverride)
      setForgot(current => ({
        ...current,
        challengeId: result.challengeId,
        deliveryChannels: result.deliveryChannels,
        expiresAt: result.expiresAt,
        maskedEmail: result.maskedEmail ?? '',
        otp: '',
        password: '',
        confirmPassword: '',
        verificationToken: '',
      }))
      setForgotOtpVerified(false)
      trackEvent('patient_password_reset_requested', {
        channels: result.deliveryChannels.join(','),
      })
      showToast(`We sent a verification code to ${describeResetTargets({
        ...forgot,
        challengeId: result.challengeId,
        deliveryChannels: result.deliveryChannels,
        expiresAt: result.expiresAt,
        maskedEmail: result.maskedEmail ?? '',
        otp: '',
        password: '',
        confirmPassword: '',
        verificationToken: '',
      })}.`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start password reset.'
      showToast(message, 'error')
    } finally {
      resetCaptcha()
      setLoading(false)
    }
  }

  async function verifyForgotOtp(nextOtp = forgot.otp) {
    if (nextOtp.trim().length !== 6 || !forgot.challengeId) {
      showToast('Enter the full 6-digit verification code first.', 'error')
      return
    }

    setLoading(true)
    try {
      const result = await verifyPatientPasswordResetCode(forgot.challengeId, nextOtp.trim())
      setForgot(current => ({ ...current, verificationToken: result.verificationToken }))
      setForgotOtpVerified(true)
      trackEvent('patient_password_reset_code_verified')
      showToast('Verification complete. You can now choose a new password.', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Incorrect verification code.'
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function resetPassword() {
    if (!forgotOtpVerified) {
      showToast('Verify the reset code before updating your password.', 'error')
      return
    }
    if (!forgot.verificationToken || !forgot.challengeId) {
      showToast('Start the password reset again before choosing a new password.', 'error')
      return
    }
    if (!isStrongPassword(forgot.password)) {
      showToast(PASSWORD_REQUIREMENTS_TEXT, 'error')
      return
    }
    if (forgot.password !== forgot.confirmPassword) {
      showToast('Passwords do not match', 'error')
      return
    }

    setLoading(true)
    try {
      await completePatientPasswordReset(forgot.challengeId, forgot.verificationToken, forgot.password)
      trackEvent('patient_password_reset_completed')
      showToast('Password updated. You can now sign in.', 'success')
      setForgot(emptyForgotState())
      setForgotOtpVerified(false)
      setStep('signin')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update your password.'
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function copyCode() {
    if (!generatedHid) return

    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
      await navigator.clipboard.writeText(generatedHid)
    } catch {
      const copyTarget = document.createElement('textarea')
      copyTarget.value = generatedHid
      copyTarget.setAttribute('readonly', '')
      copyTarget.style.position = 'fixed'
      copyTarget.style.opacity = '0'
      document.body.appendChild(copyTarget)
      copyTarget.select()
      const copied = document.execCommand('copy')
      document.body.removeChild(copyTarget)
      if (!copied) {
        showToast('Copy was blocked. Press and hold the HID code to copy it manually.', 'error')
        return
      }
    }

    setHidCopied(true)
    showToast('HID code copied', 'success')
  }

  function proceedAfterSignup() {
    awaitingHidAcknowledgementRef.current = false
    navigate('/patient/profile', { replace: true })
  }

  const introBlock = (
    <div style={{ textAlign: 'center', marginBottom: 18 }}>
      <div className="hid-auth-title" style={{ fontSize: 30, fontWeight: 700, color: '#111827', lineHeight: 1.15 }}>Create your Health ID</div>
      <p style={{ color: '#7d8797', marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
        Your health data. Safely stored. Instantly accessible. Always in your control.
      </p>
    </div>
  )

  if (step === 'signup') {
    return (
      <AuthShell mode="patient">
        {introBlock}
        <SegmentedTabs active="signup" onChange={next => setStep(next)} />
        <div className="hid-responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, .8fr) minmax(0, .8fr) minmax(0, 1.5fr)', gap: 12, marginTop: 18 }}>
          <Input placeholder="First Name" value={signup.firstName} onChange={e => setSignup(v => ({ ...v, firstName: e.target.value }))} />
          <Input placeholder="Last Name" value={signup.lastName} onChange={e => setSignup(v => ({ ...v, lastName: e.target.value }))} />
          <Input placeholder="Email Address" type="email" value={signup.email} onChange={e => setSignup(v => ({ ...v, email: e.target.value }))} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div style={{ maxWidth: 220 }}><Input placeholder="Phone Number" type="tel" inputMode="numeric" maxLength={15} value={signup.phone} onChange={e => setSignup(v => ({ ...v, phone: e.target.value.replace(/[^0-9+]/g, '') }))} /></div>
          <FacilityPicker value={signup.hospitalCurrentlyUsing} onChange={value => setSignup(v => ({ ...v, hospitalCurrentlyUsing: value }))} />
          <Select
            placeholder="Gender"
            value={signup.gender}
            onChange={e => setSignup(v => ({ ...v, gender: e.target.value }))}
            options={[
              { value: 'Female', label: 'Female' },
              { value: 'Male', label: 'Male' },
              { value: 'Other', label: 'Other' },
            ]}
          />
        </div>
        <AuthLegalConsent checked={signupAccepted} onChange={setSignupAccepted} />
        <Button disabled={!canStartSignup || loading} onClick={goToSignUpPassword} style={actionButtonStyle(canStartSignup && !loading)}>Continue</Button>
        <GoogleIdentityButton disabled={loading} onIdentity={prefillSignupWithGoogle} text="continue_with" />
      </AuthShell>
    )
  }

  if (step === 'password') {
    return (
      <AuthShell mode="patient">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center' }}>
          <div className="hid-auth-title" style={{ fontSize: 30, fontWeight: 700, color: '#111827' }}>Create a secure password</div>
          <p style={{ color: '#7d8797', marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
            Use a strong password to protect your Health ID account.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24, textAlign: 'left' }}>
            <Input type="password" placeholder="Password" value={signup.password} onChange={e => setSignup(v => ({ ...v, password: e.target.value }))} />
            <Input type="password" placeholder="Confirm Password" value={signup.confirmPassword} onChange={e => setSignup(v => ({ ...v, confirmPassword: e.target.value }))} />
          </div>
          <TurnstileWidget
            action="patient-signup"
            message={captchaNotice?.message}
            messageTone={captchaNotice?.tone}
            onTokenChange={handleCaptchaTokenChange}
            preload={step === 'password'}
            resetKey={captchaResetKey}
            visible={captchaVisible}
          />
          <div style={{ color: '#7d8797', fontSize: 11, lineHeight: 1.6, marginTop: 14, textAlign: 'left' }}>{PASSWORD_REQUIREMENTS_TEXT}</div>
          <Button loading={loading} onClick={finishSignup} style={actionButtonStyle(canFinishSignup)}>Create account</Button>
          <button onClick={() => setStep('signup')} style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}>
            Back
          </button>
        </div>
      </AuthShell>
    )
  }

  if (step === 'success') {
    return (
      <AuthShell mode="patient">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center' }}>
          <div style={{ fontSize: 30, fontWeight: 700, color: '#111827' }}>Your Health ID is ready</div>
          <p style={{ color: '#7d8797', marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
            Save this code. Use your HID code together with your password whenever you sign in.
          </p>
          <div
            aria-label={`Your Health ID is ${generatedHid}`}
            style={{ marginTop: 24, borderRadius: 18, border: '1px dashed #afd4ff', background: '#f6fbff', padding: '20px 18px', fontFamily: 'monospace', fontSize: 28, fontWeight: 700, color: '#1f8cff', overflowWrap: 'anywhere', wordBreak: 'break-word', userSelect: 'all' }}
          >
            {generatedHid}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
            <Button variant="outline" onClick={() => void copyCode()} style={{ flex: 1 }}>{hidCopied ? 'Copied' : 'Copy HID'}</Button>
            <Button onClick={proceedAfterSignup} style={{ flex: 1 }}>Proceed to profile</Button>
          </div>
        </div>
      </AuthShell>
    )
  }

  if (step === 'verify') {
    return (
      <AuthShell mode="patient">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 30, fontWeight: 700, color: '#111827' }}>Enter verification code</div>
            <p style={{ color: '#7d8797', marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
              We sent a 6-digit code to {maskEmailAddress(signupVerification.email) || 'your email address'}. Enter it here to finish creating your HID account.
            </p>
          </div>
          <div style={{ marginTop: 24 }}>
            <OtpInputs
              value={signupVerification.code}
              onChange={value => setSignupVerification(current => ({ ...current, code: value }))}
              onComplete={verifySignupCode}
            />
          </div>
          <Button loading={loading} onClick={() => void verifySignupCode()} style={actionButtonStyle(signupVerification.code.length === 6)}>
            Verify code
          </Button>
          <button onClick={() => void resendSignupCode()} style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}>
            Send code again
          </button>
          <button onClick={() => setStep('signup')} style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}>
            Back to sign up
          </button>
        </div>
      </AuthShell>
    )
  }

  if (step === 'signin') {
    return (
      <AuthShell mode="patient">
        {introBlock}
        <SegmentedTabs active="signin" onChange={next => setStep(next)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 18 }}>
          <Input placeholder="HID Code or Email" value={signin.identifier} onChange={e => setSignin(v => ({ ...v, identifier: e.target.value }))} />
          <Input type="password" placeholder="Password" value={signin.password} onChange={e => setSignin(v => ({ ...v, password: e.target.value }))} />
        </div>
        <TurnstileWidget
          action="patient-login"
          message={captchaNotice?.message}
          messageTone={captchaNotice?.tone}
          onTokenChange={handleCaptchaTokenChange}
          preload={step === 'signin' && (!!signin.identifier.trim() || !!signin.password)}
          resetKey={captchaResetKey}
          visible={captchaVisible}
        />
        <Button loading={loading} onClick={signIn} style={actionButtonStyle(canSignIn)}>Sign in</Button>
        <GoogleIdentityButton disabled={loading} onIdentity={continueWithGoogleSignIn} text="signin_with" />
        <p style={{ marginTop: 14, color: '#7d8797', fontSize: 11, lineHeight: 1.7 }}>
          Sign in with your HID code or your email address together with your password.
        </p>
        <button onClick={() => setStep('forgot')} style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}>
          Forgotten Password
        </button>
      </AuthShell>
    )
  }

  return (
    <AuthShell mode="forgot">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 30, fontWeight: 700, color: '#111827' }}>
            {!forgot.challengeId ? 'Reset your password' : !forgotOtpVerified ? 'Enter verification code' : 'Choose a new password'}
          </div>
          <p style={{ color: '#7d8797', marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
            {!forgot.challengeId
              ? 'Enter your HID code or email address and we will send a verification code to your registered email.'
              : !forgotOtpVerified
              ? `We sent a 6-digit code to ${describeResetTargets(forgot)}.`
              : 'Verification complete. Enter your new password below.'}
          </p>
        </div>

        {!forgot.challengeId ? (
          <>
            <div style={{ marginTop: 22 }}>
              <Input placeholder="HID Code or Email Address" value={forgot.identifier} onChange={e => setForgot(v => ({ ...v, identifier: e.target.value }))} />
            </div>
            <TurnstileWidget
              action="patient-reset-start"
              message={captchaNotice?.message}
              messageTone={captchaNotice?.tone}
              onTokenChange={handleCaptchaTokenChange}
              preload={step === 'forgot' && !forgot.challengeId && !!forgot.identifier.trim()}
              resetKey={captchaResetKey}
              visible={captchaVisible}
            />
            <Button loading={loading} onClick={startForgotPassword} style={actionButtonStyle(canStartForgot)}>Send OTP</Button>
          </>
        ) : !forgotOtpVerified ? (
          <>
            <div style={{ marginTop: 24 }}>
              <OtpInputs value={forgot.otp} onChange={value => setForgot(v => ({ ...v, otp: value }))} onComplete={verifyForgotOtp} />
            </div>
            <Button loading={loading} onClick={() => void verifyForgotOtp()} style={actionButtonStyle(forgot.otp.length === 6)}>Verify code</Button>
            <button onClick={() => void resendForgotPasswordCode()} style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}>
              Send code again
            </button>
          </>
        ) : (
          <>
            <Input type="password" placeholder="New Password" value={forgot.password} onChange={e => setForgot(v => ({ ...v, password: e.target.value }))} style={{ marginTop: 16 }} />
            <div style={{ color: '#7d8797', fontSize: 11, lineHeight: 1.6, marginTop: 14 }}>{PASSWORD_REQUIREMENTS_TEXT}</div>
            <Input type="password" placeholder="Confirm Password" value={forgot.confirmPassword} onChange={e => setForgot(v => ({ ...v, confirmPassword: e.target.value }))} style={{ marginTop: 12 }} />
            <Button loading={loading} onClick={resetPassword} style={actionButtonStyle(canResetPassword)}>Update password</Button>
          </>
        )}

        <button
          onClick={() => {
            setForgot(emptyForgotState())
            setForgotOtpVerified(false)
            setStep('signin')
          }}
          style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}
        >
          Back to sign in
        </button>
      </div>
    </AuthShell>
  )
}
