import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthLegalConsent } from '../../components/AuthLegalConsent'
import { AuthShell } from '../../components/AuthShell'
import { GoogleIdentityButton } from '../../components/GoogleIdentityButton'
import { OtpInputs } from '../../components/OtpInputs'
import { TurnstileWidget } from '../../components/TurnstileWidget'
import { Button, Input, Select, showToast } from '../../components/ui'
import { useCaptchaGate } from '../../hooks/useCaptchaGate'
import { clearStaffSession, getStaffSession, setStaffSession, signOutAndClearSessions } from '../../lib/auth'
import { HOSPITAL_AUTH_PATH, HOSPITAL_DASHBOARD_PATH } from '../../lib/hospitalRoutes'
import {
  enrollPrivilegedTotp,
  completeStaffPasswordResetOtp,
  fetchMyStaffAccount,
  finalizeGoogleSignIn,
  getPrivilegedMfaRequirement,
  isTotpEnrollmentUnavailableError,
  providerSignUp,
  providerSignIn,
  sendStaffPasswordReset,
  signInWithGoogleIdToken,
  verifyPrivilegedTotp,
  verifyStaffPasswordResetOtp,
  verifyStaffSignupOtp,
} from '../../lib/hidApi'
import type { GoogleIdentitySelection } from '../../lib/googleIdentity'
import { trackEvent } from '../../lib/observabilityBridge'
import { getSafeUser, safeSignOut, identityClient } from '../../lib/identityClient'
import { COUNTRIES, PASSWORD_REQUIREMENTS_TEXT, STATES_BY_COUNTRY, isStrongPassword, maskEmailAddress } from '../../lib/utils'

type DoctorStep = 'login' | 'signup' | 'verify' | 'forgot' | 'reset' | 'mfa-enroll' | 'mfa-verify'
type StaffAccount = NonNullable<Awaited<ReturnType<typeof fetchMyStaffAccount>>>
type MfaEnrollmentState = {
  factorId: string
  friendlyName: string | null
  qrCode: string
  secret: string
}

function actionButtonStyle(active: boolean) {
  return { marginTop: 16, background: active ? '#1f8cff' : '#9aa6b2' }
}

function looksLikeEmail(value: string) {
  return /\S+@\S+\.\S+/.test(value.trim())
}

function SegmentedTabs({ active, onChange }: { active: 'login' | 'signup'; onChange: (value: 'login' | 'signup') => void }) {
  return (
    <div style={{ background: '#f5f7fa', borderRadius: 999, padding: 4, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
      {[
        { key: 'login', label: 'Sign In' },
        { key: 'signup', label: 'Sign Up' },
      ].map(item => (
        <button
          key={item.key}
          onClick={() => onChange(item.key as 'login' | 'signup')}
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

export default function DoctorAuth() {
  const navigate = useNavigate()
  const existingSession = useMemo(() => getStaffSession(), [])
  const [step, setStep] = useState<DoctorStep>('login')
  const [loading, setLoading] = useState(false)
  const [loginForm, setLoginForm] = useState({ hospitalName: '', email: '', password: '' })
  const [signupForm, setSignupForm] = useState({ hospitalName: '', email: '', state: '', country: '', password: '', confirmPassword: '' })
  const [forgot, setForgot] = useState({ email: '', otp: '', challengeId: '', verificationToken: '' })
  const [forgotCodeSent, setForgotCodeSent] = useState(false)
  const [forgotOtpVerified, setForgotOtpVerified] = useState(false)
  const [resetPassword, setResetPassword] = useState('')
  const [confirmResetPassword, setConfirmResetPassword] = useState('')
  const [signupVerification, setSignupVerification] = useState({ challengeId: '', email: '', password: '', code: '' })
  const signupVerifyInFlightRef = useRef(false)
  const [signupAccepted, setSignupAccepted] = useState(false)
  const [pendingStaffAccount, setPendingStaffAccount] = useState<StaffAccount | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null)
  const [mfaEnrollment, setMfaEnrollment] = useState<MfaEnrollmentState | null>(null)
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

  const canSubmitLogin = !!loginForm.hospitalName.trim() && looksLikeEmail(loginForm.email) && !!loginForm.password
  const canSubmitSignup =
    !!signupForm.hospitalName.trim() &&
    looksLikeEmail(signupForm.email) &&
    !!signupForm.state.trim() &&
    !!signupForm.country.trim() &&
    isStrongPassword(signupForm.password) &&
    signupForm.password === signupForm.confirmPassword &&
    signupAccepted
  const canSubmitReset = isStrongPassword(resetPassword) && resetPassword === confirmResetPassword
  const stateOptions = (signupForm.country ? STATES_BY_COUNTRY[signupForm.country] ?? [] : []).map(value => ({ value, label: value }))
  const showStateSelect = stateOptions.length > 0
  const loginCaptchaReady = step === 'login' && canSubmitLogin
  const signupCaptchaReady =
    step === 'signup' &&
    !!signupForm.hospitalName.trim() &&
    !!signupForm.email.trim() &&
    !!signupForm.state.trim() &&
    !!signupForm.country.trim() &&
    !!signupForm.password &&
    !!signupForm.confirmPassword
  const forgotCaptchaReady = step === 'forgot' && !forgotCodeSent && !!forgot.email.trim()

  useEffect(() => {
    let active = true
    const loadAuthenticatedStaff = async () => {
      try {
        const staffAccount = await fetchMyStaffAccount()
        if (!active || !staffAccount) return
        await moveIntoStaffMfaFlow(staffAccount, false)
      } catch {
        if (!active) return
        clearStaffSession()
        const user = await getSafeUser()
        if (!active) return
        const isGoogleUser = Boolean(
          user?.identities?.some(identity => identity.provider === 'google') ||
          user?.app_metadata?.provider === 'google',
        )
        if (user && isGoogleUser) {
          try {
            const result = await finalizeGoogleSignIn('hospital')
            if (!result.registered) {
              await safeSignOut().catch(() => undefined)
              if (!active) return
              clearStaffSession()
              setStep('login')
              showToast('This Google account is not registered on the HID hospital portal. Use Sign Up first.', 'error')
            }
          } catch (error) {
            if (!active) return
            showToast(error instanceof Error ? error.message : 'Unable to verify this Google account.', 'error')
            setStep('login')
          }
        }
      }
    }

    void loadAuthenticatedStaff()
    const { data: { subscription } } = identityClient.auth.onAuthStateChange(() => {
      window.setTimeout(() => { void loadAuthenticatedStaff() }, 0)
    })

    return () => { active = false; subscription.unsubscribe() }
  }, [existingSession, navigate])

  useEffect(() => {
    resetCaptcha()
  }, [resetCaptcha, step])

  useEffect(() => {
    if (loginCaptchaReady || signupCaptchaReady || forgotCaptchaReady) {
      primeCaptcha()
      return
    }

    hideCaptcha()
  }, [captchaVisible, forgotCaptchaReady, hideCaptcha, loginCaptchaReady, primeCaptcha, signupCaptchaReady])

  function resetMfaState() {
    setPendingStaffAccount(null)
    setMfaCode('')
    setMfaFactorId(null)
    setMfaEnrollment(null)
  }

  function finalizeStaffAccess(staffAccount: StaffAccount) {
    resetMfaState()
    setStaffSession({
      id: staffAccount.id,
      fullName: staffAccount.full_name,
      hospitalName: staffAccount.hospital_name,
      email: staffAccount.email,
      role: staffAccount.role,
    })
    navigate(HOSPITAL_DASHBOARD_PATH)
  }

  async function moveIntoStaffMfaFlow(staffAccount: StaffAccount, showMfaToast = true) {
    const requirement = await getPrivilegedMfaRequirement()
    if (!requirement.required) {
      finalizeStaffAccess(staffAccount)
      return
    }

    setPendingStaffAccount(staffAccount)
    setMfaCode('')

    if (requirement.needsEnrollment || !requirement.challengeFactorId) {
      try {
        const enrollment = await enrollPrivilegedTotp(`${staffAccount.hospital_name || 'HID'} Authenticator`)
        setMfaEnrollment({
          factorId: enrollment.factorId,
          friendlyName: enrollment.friendlyName,
          qrCode: enrollment.qrCode,
          secret: enrollment.secret,
        })
        setMfaFactorId(enrollment.factorId)
        setStep('mfa-enroll')
        if (showMfaToast) {
          showToast('Set up your authenticator app to finish signing in.', 'info')
        }
        return
      } catch (error) {
        if (!isTotpEnrollmentUnavailableError(error)) throw error
        finalizeStaffAccess(staffAccount)
        return
      }
    }

    setMfaEnrollment(null)
    setMfaFactorId(requirement.challengeFactorId)
    setStep('mfa-verify')
    if (showMfaToast) {
      showToast('Enter your authenticator code to finish signing in.', 'info')
    }
  }

  async function abandonMfaFlow() {
    await signOutAndClearSessions().catch(() => undefined)
    resetMfaState()
    setStep('login')
  }

  function submitLogin() {
    if (!canSubmitLogin) {
      showToast('Enter your hospital name, email, and password', 'error')
      return
    }
    runWithCaptcha(token => void performLogin(token))
  }

  async function signInHospitalWithGoogle(identity: GoogleIdentitySelection) {
    setLoading(true)
    try {
      await signInWithGoogleIdToken('hospital', identity.credential, identity.email)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Unable to continue with Google.', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function prefillHospitalSignupWithGoogle(identity: GoogleIdentitySelection) {
    setLoading(true)
    try {
      setSignupForm(current => ({ ...current, email: identity.email }))
      showToast('Google email added. Complete the form to continue sign-up.', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Unable to read your Google details.', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function performLogin(captchaTokenOverride: string | null = captchaToken) {
    setLoading(true)
    try {
      const staffAccount = await providerSignIn(loginForm.hospitalName, loginForm.email, loginForm.password, captchaTokenOverride)
      trackEvent('staff_signin_completed')
      await moveIntoStaffMfaFlow(staffAccount)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid hospital credentials.'
      if (error instanceof Error && message.toLowerCase().includes('email not confirmed') && /\S+@\S+\.\S+/.test(loginForm.email.trim())) {
        setSignupForm(current => ({ ...current, email: loginForm.email.trim().toLowerCase(), password: loginForm.password, confirmPassword: loginForm.password }))
        setStep('signup')
        showToast('Finish hospital sign-up again to receive a fresh verification code.', 'info')
        return
      }
      showToast(message, 'error')
    } finally {
      resetCaptcha()
      setLoading(false)
    }
  }

  function submitHospitalSignup() {
    if (!signupAccepted) {
      showToast('You must agree to the Terms of Service and Privacy Policy before creating an account', 'error')
      return
    }
    if (!isStrongPassword(signupForm.password)) {
      showToast(PASSWORD_REQUIREMENTS_TEXT, 'error')
      return
    }
    if (signupForm.password !== signupForm.confirmPassword) {
      showToast('Passwords do not match', 'error')
      return
    }
    runWithCaptcha(token => void performHospitalSignup(token))
  }

  async function performHospitalSignup(captchaTokenOverride: string | null = captchaToken) {
    setLoading(true)
    try {
      const result = await providerSignUp({
        captchaToken: captchaTokenOverride,
        country: signupForm.country,
        email: signupForm.email,
        hospitalName: signupForm.hospitalName,
        password: signupForm.password,
        state: signupForm.state,
      })

      if (!result.staffAccount) {
        trackEvent('hospital_signup_pending_verification')
        setSignupVerification({
          challengeId: result.challengeId,
          email: signupForm.email.trim().toLowerCase(),
          password: signupForm.password,
          code: '',
        })
        showToast('We sent a 6-digit verification code to your email. Enter it here to finish creating the hospital account.', 'success')
        setStep('verify')
        return
      }

      trackEvent('hospital_signup_completed')
      await moveIntoStaffMfaFlow(result.staffAccount)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create the hospital account.'
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
    setLoading(true)
    try {
      const staffAccount = await verifyStaffSignupOtp(signupVerification.challengeId, signupVerification.email, signupVerification.password, nextCode.trim())
      trackEvent('hospital_signup_completed')
      showToast('Email verified. Continue with your authenticator to finish signing in.', 'success')
      await moveIntoStaffMfaFlow(staffAccount)
    } catch (error) {
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
      const result = await providerSignUp({
        captchaToken: captchaTokenOverride,
        country: signupForm.country,
        email: signupVerification.email || signupForm.email,
        hospitalName: signupForm.hospitalName,
        password: signupVerification.password || signupForm.password,
        state: signupForm.state,
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
    if (!forgot.email.trim()) {
      showToast('Enter your email address first.', 'error')
      return
    }
    runWithCaptcha(token => void performStartForgotPassword(token))
  }

  function resendForgotPasswordCode() {
    if (!forgot.email.trim()) {
      showToast('Enter your email address first.', 'error')
      return
    }
    void performStartForgotPassword(null)
  }

  async function performStartForgotPassword(captchaTokenOverride: string | null = captchaToken) {
    setLoading(true)
    try {
      const result = await sendStaffPasswordReset(forgot.email, `${window.location.origin}${HOSPITAL_AUTH_PATH}`, captchaTokenOverride)
      trackEvent('staff_password_reset_requested')
      setForgotCodeSent(true)
      setForgotOtpVerified(false)
      setForgot(current => ({ ...current, otp: '', challengeId: result.challengeId, verificationToken: '' }))
      showToast('We sent a 6-digit verification code to your email. Enter it here to continue.', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send a verification code right now.'
      showToast(message, 'error')
    } finally {
      resetCaptcha()
      setLoading(false)
    }
  }

  async function verifyForgotCode(nextCode = forgot.otp) {
    if (nextCode.trim().length !== 6 || !forgot.challengeId) {
      showToast('Enter the full 6-digit verification code first.', 'error')
      return
    }

    setLoading(true)
    try {
      const result = await verifyStaffPasswordResetOtp(forgot.challengeId, nextCode.trim())
      setForgot(current => ({ ...current, verificationToken: result.verificationToken }))
      setForgotOtpVerified(true)
      showToast('Verification complete. Enter your new password.', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The verification code is not correct.'
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function submitPasswordReset() {
    if (!canSubmitReset) {
      showToast('Enter a strong password and confirm it.', 'error')
      return
    }

    setLoading(true)
    try {
      if (!forgot.challengeId || !forgot.verificationToken) {
        throw new Error('Start password recovery again before updating your password.')
      }
      await completeStaffPasswordResetOtp(forgot.challengeId, forgot.verificationToken, resetPassword)
      await signOutAndClearSessions()
      trackEvent('staff_password_reset_completed')
      showToast('Password updated. You can now sign in.', 'success')
      setForgot({ email: '', otp: '', challengeId: '', verificationToken: '' })
      setForgotCodeSent(false)
      setForgotOtpVerified(false)
      setResetPassword('')
      setConfirmResetPassword('')
      setStep('login')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update your password.'
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  async function submitMfa(nextCode = mfaCode) {
    const factorId = mfaEnrollment?.factorId ?? mfaFactorId
    if (!factorId || !pendingStaffAccount) {
      showToast('Start sign-in again to continue.', 'error')
      await abandonMfaFlow()
      return
    }

    setLoading(true)
    try {
      await verifyPrivilegedTotp(factorId, nextCode)
      finalizeStaffAccess(pendingStaffAccount)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The authenticator code is not correct.'
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'mfa-enroll' || step === 'mfa-verify') {
    return (
      <AuthShell mode="provider">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 30, fontWeight: 700 }}>
              {step === 'mfa-enroll' ? 'Set up your authenticator' : 'Enter authenticator code'}
            </div>
            <p style={{ color: '#7d8797', marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
              {step === 'mfa-enroll'
                ? 'Scan this QR code with your authenticator app, then enter the latest 6-digit code to finish signing in.'
                : 'Open your authenticator app and enter the latest 6-digit code for your hospital account.'}
            </p>
          </div>
          {step === 'mfa-enroll' && mfaEnrollment ? (
            <>
              <div style={{ marginTop: 22, alignSelf: 'center', padding: 14, borderRadius: 18, border: '1px solid #dbe4f0', background: '#ffffff' }}>
                <img src={mfaEnrollment.qrCode} alt="Authenticator QR code" style={{ width: 188, height: 188, display: 'block' }} />
              </div>
              <div style={{ color: '#7d8797', fontSize: 11, lineHeight: 1.6, marginTop: 14 }}>Manual setup key</div>
              <div style={{ marginTop: 8, padding: 12, borderRadius: 12, background: '#f5f7fa', fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-word' }}>
                {mfaEnrollment.secret}
              </div>
            </>
          ) : null}
          <div style={{ marginTop: 24 }}>
            <OtpInputs value={mfaCode} onChange={setMfaCode} onComplete={submitMfa} />
          </div>
          <Button loading={loading} onClick={() => void submitMfa()} style={actionButtonStyle(mfaCode.length === 6)}>
            {step === 'mfa-enroll' ? 'Verify and Continue' : 'Continue'}
          </Button>
          <button onClick={() => void abandonMfaFlow()} style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}>
            Back to sign in
          </button>
        </div>
      </AuthShell>
    )
  }

  if (step === 'forgot') {
    return (
      <AuthShell mode="forgot">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 30, fontWeight: 700 }}>
              {!forgotCodeSent ? 'Reset your password' : !forgotOtpVerified ? 'Enter verification code' : 'Choose a new password'}
            </div>
            <p style={{ color: '#7d8797', marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
              {!forgotCodeSent
                ? 'Enter the email linked to your hospital account and we will send a verification code.'
                : !forgotOtpVerified
                ? `We sent a 6-digit code to ${maskEmailAddress(forgot.email) || 'your email address'}.`
                : 'Verification complete. Enter your new password below.'}
            </p>
          </div>
          {!forgotCodeSent ? (
            <>
              <Input placeholder="Email address" value={forgot.email} onChange={e => setForgot(current => ({ ...current, email: e.target.value }))} style={{ marginTop: 22 }} />
              <TurnstileWidget
                action="staff-reset"
                message={captchaNotice?.message}
                messageTone={captchaNotice?.tone}
                onTokenChange={handleCaptchaTokenChange}
                preload={step === 'forgot' && !forgotCodeSent && !!forgot.email.trim()}
                resetKey={captchaResetKey}
                visible={captchaVisible}
              />
              <Button loading={loading} onClick={startForgotPassword} style={actionButtonStyle(!!forgot.email.trim())}>Send OTP</Button>
            </>
          ) : !forgotOtpVerified ? (
            <>
              <div style={{ marginTop: 24 }}>
                <OtpInputs value={forgot.otp} onChange={value => setForgot(current => ({ ...current, otp: value }))} onComplete={verifyForgotCode} />
              </div>
              <Button loading={loading} onClick={() => void verifyForgotCode()} style={actionButtonStyle(forgot.otp.length === 6)}>Verify code</Button>
              <button onClick={() => void resendForgotPasswordCode()} style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}>
                Send code again
              </button>
            </>
          ) : (
            <>
              <Input type="password" placeholder="New Password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} style={{ marginTop: 22 }} />
              <div style={{ color: '#7d8797', fontSize: 11, lineHeight: 1.6, marginTop: 14 }}>{PASSWORD_REQUIREMENTS_TEXT}</div>
              <Input type="password" placeholder="Confirm Password" value={confirmResetPassword} onChange={e => setConfirmResetPassword(e.target.value)} style={{ marginTop: 12 }} />
              <Button disabled={!canSubmitReset} loading={loading} onClick={submitPasswordReset} style={actionButtonStyle(canSubmitReset)}>Update password</Button>
            </>
          )}
          <button
            onClick={() => {
              setForgot({ email: '', otp: '', challengeId: '', verificationToken: '' })
              setForgotCodeSent(false)
              setForgotOtpVerified(false)
              setResetPassword('')
              setConfirmResetPassword('')
              setStep('login')
            }}
            style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}
          >
            Back to sign in
          </button>
        </div>
      </AuthShell>
    )
  }

  if (step === 'verify') {
    return (
      <AuthShell mode="provider">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 30, fontWeight: 700 }}>Enter verification code</div>
            <p style={{ color: '#7d8797', marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
              We sent a 6-digit code to {maskEmailAddress(signupVerification.email) || 'your email address'}. Enter it here to finish creating the hospital account.
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

  if (step === 'reset') {
    return (
      <AuthShell mode="provider">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 30, fontWeight: 700 }}>Choose a new password</div>
            <p style={{ color: '#7d8797', marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
              This password will secure your hospital account going forward.
            </p>
          </div>
          <Input type="password" placeholder="New Password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} style={{ marginTop: 22 }} />
          <div style={{ color: '#7d8797', fontSize: 11, lineHeight: 1.6, marginTop: 14 }}>{PASSWORD_REQUIREMENTS_TEXT}</div>
          <Input type="password" placeholder="Confirm Password" value={confirmResetPassword} onChange={e => setConfirmResetPassword(e.target.value)} style={{ marginTop: 12 }} />
          <Button disabled={!canSubmitReset} loading={loading} onClick={submitPasswordReset} style={actionButtonStyle(canSubmitReset)}>Update password</Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell mode="provider">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 30, fontWeight: 700, color: '#111827', lineHeight: 1.15 }}>Hospital Portal</div>
          <p style={{ color: '#7d8797', marginTop: 8, fontSize: 12 }}>
            Secure access for hospitals and care teams to patient medical records.
          </p>
        </div>

        <SegmentedTabs active={step === 'signup' ? 'signup' : 'login'} onChange={next => setStep(next)} />

        {step === 'login' ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 22 }}>
              <Input placeholder="Hospital Name" value={loginForm.hospitalName} onChange={e => setLoginForm(v => ({ ...v, hospitalName: e.target.value }))} />
              <Input placeholder="Gmail address" type="email" value={loginForm.email} onChange={e => setLoginForm(v => ({ ...v, email: e.target.value }))} />
              <Input placeholder="Password" type="password" value={loginForm.password} onChange={e => setLoginForm(v => ({ ...v, password: e.target.value }))} />
            </div>
            <TurnstileWidget
              action="staff-login"
              message={captchaNotice?.message}
              messageTone={captchaNotice?.tone}
              onTokenChange={handleCaptchaTokenChange}
              preload={step === 'login' && (!!loginForm.email.trim() || !!loginForm.password)}
              resetKey={captchaResetKey}
              visible={captchaVisible}
            />
            <Button disabled={!canSubmitLogin} loading={loading} onClick={submitLogin} style={actionButtonStyle(canSubmitLogin)}>
              Sign in
            </Button>
            <GoogleIdentityButton disabled={loading} onIdentity={signInHospitalWithGoogle} text="signin_with" />
            <p style={{ marginTop: 14, color: '#7d8797', fontSize: 11, lineHeight: 1.7 }}>
              Sign in with your hospital name, email address, and password.
            </p>
            <button onClick={() => setStep('forgot')} style={{ marginTop: 12, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11 }}>
              Forgotten Password
            </button>
          </>
        ) : (
          <>
            <div className="hid-responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(210px, 100%), 1fr))', gap: 12, marginTop: 22 }}>
              <Input placeholder="Hospital Name" value={signupForm.hospitalName} onChange={e => setSignupForm(v => ({ ...v, hospitalName: e.target.value }))} />
              <Input placeholder="Gmail address" type="email" value={signupForm.email} onChange={e => setSignupForm(v => ({ ...v, email: e.target.value }))} />
              <Select
                placeholder="Country"
                value={signupForm.country}
                onChange={e => setSignupForm(v => ({ ...v, country: e.target.value, state: '' }))}
                options={COUNTRIES.map(value => ({ value, label: value }))}
              />
              {showStateSelect ? (
                <Select
                  placeholder="State"
                  value={signupForm.state}
                  onChange={e => setSignupForm(v => ({ ...v, state: e.target.value }))}
                  options={stateOptions}
                />
              ) : (
                <Input placeholder="State" value={signupForm.state} onChange={e => setSignupForm(v => ({ ...v, state: e.target.value }))} />
              )}
              <Input placeholder="Password" type="password" value={signupForm.password} onChange={e => setSignupForm(v => ({ ...v, password: e.target.value }))} />
              <Input placeholder="Confirm Password" type="password" value={signupForm.confirmPassword} onChange={e => setSignupForm(v => ({ ...v, confirmPassword: e.target.value }))} />
            </div>
            <TurnstileWidget
              action="staff-signup"
              message={captchaNotice?.message}
              messageTone={captchaNotice?.tone}
              onTokenChange={handleCaptchaTokenChange}
              preload={step === 'signup' && (!!signupForm.email.trim() || !!signupForm.password || !!signupForm.confirmPassword)}
              resetKey={captchaResetKey}
              visible={captchaVisible}
            />
            <div style={{ color: '#7d8797', fontSize: 11, lineHeight: 1.6, marginTop: 14 }}>{PASSWORD_REQUIREMENTS_TEXT}</div>
            <AuthLegalConsent checked={signupAccepted} onChange={setSignupAccepted} />
            <Button disabled={!canSubmitSignup} loading={loading} onClick={submitHospitalSignup} style={actionButtonStyle(canSubmitSignup)}>
              Create hospital account
            </Button>
            <GoogleIdentityButton disabled={loading} onIdentity={prefillHospitalSignupWithGoogle} text="continue_with" />
            <p style={{ marginTop: 14, color: '#7d8797', fontSize: 11, lineHeight: 1.7 }}>
              Create the first hospital admin account with your hospital name, email, state, country, and password.
            </p>
          </>
        )}
      </div>
    </AuthShell>
  )
}
