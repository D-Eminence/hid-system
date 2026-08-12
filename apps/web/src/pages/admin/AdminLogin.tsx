import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthShell } from '../../components/AuthShell'
import { OtpInputs } from '../../components/OtpInputs'
import { TurnstileWidget } from '../../components/TurnstileWidget'
import { Button, Input, showToast } from '../../components/ui'
import { useCaptchaGate } from '../../hooks/useCaptchaGate'
import { clearAllPortalSessions, signOutAndClearSessions } from '../../lib/auth'
import { ADMIN_LOGIN_PATH, ADMIN_OVERVIEW_PATH } from '../../lib/adminRoutes'
import {
  completeAdminPasswordResetOtp,
  enrollPrivilegedTotp,
  fetchCurrentSecurityProfile,
  getPrivilegedMfaRequirement,
  isTotpEnrollmentUnavailableError,
  startAdminPasswordResetOtp,
  verifyAdminPasswordResetOtp,
  verifyPrivilegedTotp,
} from '../../lib/hidApi'
import { safeSignOut, identityClient } from '../../lib/identityClient'
import { isStrongPassword, maskEmailAddress, PASSWORD_REQUIREMENTS_TEXT } from '../../lib/utils'

type AdminStep = 'login' | 'forgot' | 'reset' | 'mfa-enroll' | 'mfa-verify'

type EnrollmentState = {
  factorId: string
  friendlyName: string | null
  qrCode: string
  secret: string
}

async function getCurrentAppRole() {
  const profile = await fetchCurrentSecurityProfile()
  return profile?.app_role ?? null
}

export default function AdminLogin() {
  const navigate = useNavigate()
  const [step, setStep] = useState<AdminStep>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otpVerified, setOtpVerified] = useState(false)
  const [resetChallengeId, setResetChallengeId] = useState('')
  const [resetVerificationToken, setResetVerificationToken] = useState('')
  const [resetPassword, setResetPassword] = useState('')
  const [confirmResetPassword, setConfirmResetPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null)
  const [mfaEnrollment, setMfaEnrollment] = useState<EnrollmentState | null>(null)
  const [loading, setLoading] = useState(false)
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
  const canSubmitReset = isStrongPassword(resetPassword) && resetPassword === confirmResetPassword
  const loginCaptchaReady = step === 'login' && !!email.trim() && !!password
  const forgotCaptchaReady = step === 'forgot' && !otpSent && !!email.trim()

  function resetMfaState() {
    setMfaCode('')
    setMfaFactorId(null)
    setMfaEnrollment(null)
  }

  async function finalizeAdminAccess() {
    clearAllPortalSessions()
    showToast('Admin sign-in successful.', 'success')
    navigate(ADMIN_OVERVIEW_PATH, { replace: true })
  }

  async function moveIntoAdminMfaFlow(showMfaToast = true) {
    const role = await getCurrentAppRole()
    if (role !== 'platform_admin') {
      await safeSignOut().catch(() => undefined)
      clearAllPortalSessions()
      resetMfaState()
      showToast('Admin access is limited to platform admins.', 'error')
      return
    }

    const requirement = await getPrivilegedMfaRequirement()
    if (!requirement.required) {
      resetMfaState()
      await finalizeAdminAccess()
      return
    }

    setMfaCode('')
    if (requirement.needsEnrollment || !requirement.challengeFactorId) {
      try {
        const enrollment = await enrollPrivilegedTotp('HID Admin Authenticator')
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
        resetMfaState()
        await finalizeAdminAccess()
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
    await safeSignOut().catch(() => undefined)
    clearAllPortalSessions()
    resetMfaState()
    setStep('login')
  }

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const role = await getCurrentAppRole()
        if (!active || role !== 'platform_admin') return
        await moveIntoAdminMfaFlow(false)
      } catch {
        // Best effort only. Manual sign-in remains available.
      }
    })()

    return () => { active = false }
  }, [navigate])

  useEffect(() => {
    resetCaptcha()
  }, [resetCaptcha, step])

  useEffect(() => {
    if (loginCaptchaReady || forgotCaptchaReady) {
      primeCaptcha()
      return
    }

    hideCaptcha()
  }, [captchaVisible, forgotCaptchaReady, hideCaptcha, loginCaptchaReady, primeCaptcha])

  function sendResetLink() {
    if (!email.trim()) {
      showToast('Enter your admin email address first.', 'error')
      return
    }
    runWithCaptcha(token => void performSendResetLink(token))
  }

  function resendResetLink() {
    if (!email.trim()) {
      showToast('Enter your admin email address first.', 'error')
      return
    }
    void performSendResetLink(null)
  }

  async function performSendResetLink(captchaTokenOverride: string | null = captchaToken) {
    setLoading(true)
    try {
      const result = await startAdminPasswordResetOtp(email, captchaTokenOverride)
      setResetChallengeId(result.challengeId)
      setResetVerificationToken('')
      setOtp('')
      setOtpSent(true)
      setOtpVerified(false)
      showToast('We sent a 6-digit verification code to your email. Enter it here to continue.', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send a verification code right now.'
      showToast(message, 'error')
    } finally {
      resetCaptcha()
      setLoading(false)
    }
  }

  async function verifyResetOtp(nextCode = otp) {
    if (nextCode.trim().length !== 6 || !resetChallengeId) {
      showToast('Enter the full 6-digit verification code first.', 'error')
      return
    }

    setLoading(true)
    try {
      const result = await verifyAdminPasswordResetOtp(resetChallengeId, nextCode.trim())
      setResetVerificationToken(result.verificationToken)
      setOtpVerified(true)
      setStep('reset')
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
      if (!resetChallengeId || !resetVerificationToken) {
        throw new Error('Start password recovery again before updating your password.')
      }
      await completeAdminPasswordResetOtp(resetChallengeId, resetVerificationToken, resetPassword)
      await signOutAndClearSessions()
      showToast('Password updated. You can now sign in.', 'success')
      setOtp('')
      setOtpSent(false)
      setOtpVerified(false)
      setResetChallengeId('')
      setResetVerificationToken('')
      setResetPassword('')
      setConfirmResetPassword('')
      setStep('login')
      navigate(ADMIN_LOGIN_PATH, { replace: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update your password.'
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  function submit() {
    if (!email.trim() || !password) {
      showToast('Enter your admin email address and password.', 'error')
      return
    }
    runWithCaptcha(token => void performSubmit(token))
  }

  async function performSubmit(captchaTokenOverride: string | null = captchaToken) {
    setLoading(true)
    try {
      const { error } = await identityClient.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
        options: {
          captchaToken: captchaTokenOverride ?? undefined,
          captchaAction: 'admin-login',
        },
      })

      if (error) {
        throw error
      }

      await moveIntoAdminMfaFlow()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to sign in right now.'
      showToast(message, 'error')
    } finally {
      resetCaptcha()
      setLoading(false)
    }
  }

  async function submitMfa(nextCode = mfaCode) {
    const factorId = mfaEnrollment?.factorId ?? mfaFactorId
    if (!factorId) {
      showToast('Start sign-in again to continue.', 'error')
      await abandonMfaFlow()
      return
    }

    setLoading(true)
    try {
      await verifyPrivilegedTotp(factorId, nextCode)
      resetMfaState()
      await finalizeAdminAccess()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The authenticator code is not correct.'
      showToast(message, 'error')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'mfa-enroll' || step === 'mfa-verify') {
    const title = step === 'mfa-enroll' ? 'Set Up Authenticator' : 'Enter Authenticator Code'
    const description = step === 'mfa-enroll'
      ? 'Scan this QR code with your authenticator app, then enter the 6-digit code to finish signing in.'
      : 'Open your authenticator app and enter the latest 6-digit code for your HID admin account.'

    return (
      <AuthShell title={title} providerLink={false} mode="forgot">
        <div style={{ display: 'grid', gap: 18 }}>
          <div style={{ color: '#6b7280', fontSize: 13, lineHeight: 1.6 }}>
            {description}
          </div>
          {step === 'mfa-enroll' && mfaEnrollment ? (
            <>
              <div style={{ justifySelf: 'center', padding: 14, borderRadius: 18, border: '1px solid #dbe4f0', background: '#ffffff' }}>
                <img src={mfaEnrollment.qrCode} alt="Authenticator QR code" style={{ width: 188, height: 188, display: 'block' }} />
              </div>
              <div style={{ color: '#6b7280', fontSize: 12, lineHeight: 1.6 }}>
                Manual setup key
              </div>
              <div style={{ padding: 12, borderRadius: 12, background: '#f5f7fa', fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-word' }}>
                {mfaEnrollment.secret}
              </div>
            </>
          ) : null}
          <OtpInputs value={mfaCode} onChange={setMfaCode} onComplete={submitMfa} />
          <Button loading={loading} onClick={() => void submitMfa()} fullWidth>
            {step === 'mfa-enroll' ? 'Verify and Continue' : 'Continue'}
          </Button>
          <button
            onClick={() => void abandonMfaFlow()}
            style={{ border: 'none', background: 'none', color: '#1f8cff', fontSize: 12, cursor: 'pointer', justifySelf: 'start', padding: 0 }}
          >
            Back to sign in
          </button>
        </div>
      </AuthShell>
    )
  }

  if (step === 'forgot') {
    return (
      <AuthShell title="Reset Admin Password" providerLink={false} mode="forgot">
        <div style={{ display: 'grid', gap: 18 }}>
          <div style={{ color: '#6b7280', fontSize: 13, lineHeight: 1.6 }}>
            {!otpSent
              ? 'Enter the platform admin email and we will send a verification code if the account is eligible.'
              : `We sent a 6-digit code to ${maskEmailAddress(email) || 'your email address'}.`}
          </div>
          {!otpSent ? (
            <>
              <Input
                label="Admin Email"
                type="email"
                placeholder="admin@gmail.com"
                value={email}
                onChange={event => setEmail(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <TurnstileWidget
                action="admin-reset"
                message={captchaNotice?.message}
                messageTone={captchaNotice?.tone}
                onTokenChange={handleCaptchaTokenChange}
                preload={step === 'forgot' && !otpSent && !!email.trim()}
                resetKey={captchaResetKey}
                visible={captchaVisible}
              />
              <Button loading={loading} onClick={() => void sendResetLink()} fullWidth>
                Send OTP
              </Button>
            </>
          ) : (
            <>
              <OtpInputs value={otp} onChange={setOtp} onComplete={verifyResetOtp} />
              <Button loading={loading} onClick={() => void verifyResetOtp()} fullWidth>
                Verify code
              </Button>
              <button
                onClick={() => void resendResetLink()}
                style={{ border: 'none', background: 'none', color: '#1f8cff', fontSize: 12, cursor: 'pointer', justifySelf: 'start', padding: 0 }}
              >
                Send code again
              </button>
            </>
          )}
          <button
            onClick={() => {
              setStep('login')
              setOtp('')
              setOtpSent(false)
              setOtpVerified(false)
              setResetChallengeId('')
              setResetVerificationToken('')
            }}
            style={{ border: 'none', background: 'none', color: '#1f8cff', fontSize: 12, cursor: 'pointer', justifySelf: 'start', padding: 0 }}
          >
            Back to sign in
          </button>
        </div>
      </AuthShell>
    )
  }

  if (step === 'reset') {
    return (
      <AuthShell title="Choose a New Password" providerLink={false} mode="forgot">
        <div style={{ display: 'grid', gap: 18 }}>
          <div style={{ color: '#6b7280', fontSize: 13, lineHeight: 1.6 }}>
            Set a new password for your admin account, then sign in again from this page.
          </div>
          <Input
            label="New Password"
            type="password"
            placeholder="Enter a strong password"
            value={resetPassword}
            onChange={event => setResetPassword(event.target.value)}
            autoComplete="new-password"
          />
          <div style={{ color: '#6b7280', fontSize: 11, lineHeight: 1.6 }}>
            {PASSWORD_REQUIREMENTS_TEXT}
          </div>
          <Input
            label="Confirm Password"
            type="password"
            placeholder="Confirm your new password"
            value={confirmResetPassword}
            onChange={event => setConfirmResetPassword(event.target.value)}
            autoComplete="new-password"
          />
          <Button loading={loading} disabled={!canSubmitReset} onClick={() => void submitPasswordReset()} fullWidth>
            Update password
          </Button>
          {!otpVerified && (
            <button
              onClick={() => {
                setStep('forgot')
              }}
              style={{ border: 'none', background: 'none', color: '#1f8cff', fontSize: 12, cursor: 'pointer', justifySelf: 'start', padding: 0 }}
            >
              Back
            </button>
          )}
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Admin Sign In" providerLink={false} mode="forgot">
      <div style={{ display: 'grid', gap: 18 }}>
        <div style={{ color: '#6b7280', fontSize: 13, lineHeight: 1.6 }}>
          Sign in with your platform admin email and password to open the HID admin dashboard.
        </div>
        <Input
          label="Admin Email"
          type="email"
          placeholder="admin@gmail.com"
          value={email}
          onChange={event => setEmail(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          label="Password"
          type="password"
          placeholder="Enter your password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          autoComplete="current-password"
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <TurnstileWidget
          action="admin-login"
          message={captchaNotice?.message}
          messageTone={captchaNotice?.tone}
          onTokenChange={handleCaptchaTokenChange}
          preload={step === 'login' && (!!email.trim() || !!password)}
          resetKey={captchaResetKey}
          visible={captchaVisible}
        />
        <Button loading={loading} onClick={() => void submit()} fullWidth>
          Sign In
        </Button>
        <button
          onClick={() => setStep('forgot')}
          style={{ border: 'none', background: 'none', color: '#1f8cff', fontSize: 12, cursor: 'pointer', justifySelf: 'start', padding: 0 }}
        >
          Forgot password?
        </button>
        <button
          onClick={() => navigate('/', { replace: true })}
          style={{ border: 'none', background: 'none', color: '#1f8cff', fontSize: 12, cursor: 'pointer', justifySelf: 'start', padding: 0 }}
        >
          Back to home
        </button>
      </div>
    </AuthShell>
  )
}
