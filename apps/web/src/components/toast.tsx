import React, { useEffect, useState } from 'react'
import { BANNED_ACCOUNT_MESSAGE, isBannedAuthMessage } from '../lib/securityMessages'

type ToastType = 'success' | 'error' | 'info'
type ToastState = { id: number; msg: string; type: ToastType }

let toastHandlers: Array<(msg: string, type: ToastType) => void> = []

function toReadableSentence(raw: string) {
  const cleaned = raw
    .replace(/^error:\s*/i, '')
    .replace(/\.$/, '')
    .replace(/^incorrect\s+/i, 'The ')
    .replace(/^enter\s+/i, 'Please enter ')
    .replace(/^add\s+/i, 'Please add ')
    .replace(/^fill\s+/i, 'Please fill ')

  const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

function isLowSignalError(lower: string) {
  return (
    lower === 'request failed' ||
    lower === 'failed' ||
    lower === 'error' ||
    lower === 'internal server error' ||
    lower === 'bad request' ||
    lower === 'forbidden' ||
    lower === 'unauthorized' ||
    lower === 'not found' ||
    lower === 'service unavailable' ||
    lower === 'gateway timeout' ||
    lower === 'timeout'
  )
}

function isTechnicalErrorMessage(lower: string, raw: string) {
  return (
    lower.includes('lock:sb-') ||
    lower.includes('auth-token') ||
    lower.includes('lock was stolen by another request') ||
    lower.includes('another request stole it') ||
    lower.includes('navigatorlock') ||
    lower.includes('stack') ||
    lower.includes('trace') ||
    lower.includes('sqlstate') ||
    lower.includes('schema') ||
    lower.includes('relation') ||
    lower.includes('constraint') ||
    lower.includes('postgres') ||
    lower.includes('identityClient') ||
    lower.includes('jwt') ||
    lower.includes('refresh token') ||
    lower.includes('rpc') ||
    lower.includes('deno') ||
    lower.includes('referenceerror') ||
    lower.includes('typeerror') ||
    lower.includes('syntaxerror') ||
    lower.includes('column reference') ||
    lower.includes('ambiguous') ||
    lower.includes('stack depth') ||
    lower.includes('recursion') ||
    lower.includes('violates row-level security') ||
    lower.includes('permission denied for relation') ||
    raw.includes('/home/') ||
    raw.includes('<!DOCTYPE') ||
    raw.includes('<html')
  )
}

function fallbackErrorMessage(raw: string) {
  const lower = raw.toLowerCase()
  if (
    lower.includes('lock:sb-') ||
    lower.includes('auth-token') ||
    lower.includes('lock was stolen by another request') ||
    lower.includes('another request stole it')
  ) {
    return 'Your session was updated in another tab or request. Please try again.'
  }
  if (lower.includes('provider request failed with status 401') || lower.includes('provider request failed with status 403')) {
    return 'A connected service rejected this request. Check the admin integration settings and try again.'
  }
  if (lower.includes('provider request failed with status 404')) {
    return 'A connected service could not find the requested data right now.'
  }
  if (lower.includes('provider request failed with status 429')) {
    return 'A connected service is being rate-limited right now. Please wait a moment and try again.'
  }
  if (
    lower.includes('provider request failed with status 500') ||
    lower.includes('provider request failed with status 502') ||
    lower.includes('provider request failed with status 503') ||
    lower.includes('provider request failed with status 504')
  ) {
    return 'A connected service is temporarily unavailable right now. Please try again shortly.'
  }
  if (lower.includes('admin dashboard')) {
    return 'The admin dashboard could not be loaded right now. Refresh and try again.'
  }
  if (lower.includes('sentry')) {
    return 'Sentry data is not available right now.'
  }
  if (lower.includes('posthog')) {
    return 'PostHog data is not available right now.'
  }
  if (lower.includes('timeout') || lower.includes('took too long')) {
    return 'The request took too long to finish. Please try again.'
  }
  if (lower.includes('request failed')) {
    return 'That action could not be completed right now. Please try again.'
  }
  return 'That action could not be completed right now. Please try again.'
}

function isSensitiveAccountMessage(lower: string) {
  return (
    (
      lower.includes('account') ||
      lower.includes('patient') ||
      lower.includes('hospital') ||
      lower.includes('email') ||
      lower.includes('phone')
    ) &&
    (
      lower.includes('already exists') ||
      lower.includes('already linked') ||
      lower.includes('cannot be used') ||
      lower.includes('deleted') ||
      lower.includes('locked') ||
      lower.includes('inactive') ||
      lower.includes('not active') ||
      lower.includes('incomplete') ||
      lower.includes('finishing setup')
    )
  )
}

function normalizeToastMessage(message: string, type: ToastType) {
  const raw = `${message ?? ''}`.replace(/\s+/g, ' ').trim()
  if (!raw) return type === 'error' ? 'Something went wrong. Please try again.' : 'Done.'

  const lower = raw.toLowerCase()
  if (type === 'error') {
    if (lower.includes('request could not be completed with those details')) {
      return 'Voice capture could not start right now. Please try again.'
    }
    if (lower.includes('microphone access is blocked')) {
      return 'Microphone access is blocked. Allow it in your browser settings, then try again.'
    }
    if (
      (lower.includes('does not exist') && (
        lower.includes('column') ||
        lower.includes('table') ||
        lower.includes('relation') ||
        lower.includes('function') ||
        lower.includes('schema')
      )) ||
      lower.includes('null value in column') ||
      lower.includes('violates not-null constraint') ||
      lower.includes('violates foreign key constraint') ||
      lower.includes('cannot insert into column')
    ) {
      return 'This information could not be saved right now. Please try again.'
    }
    if (
      lower.includes('voice capture') ||
      lower.includes('speech recognition') ||
      (lower.includes('microphone') && !lower.includes('microphone access is blocked'))
    ) {
      if (lower.includes('not allowed') || lower.includes('permission denied') || lower.includes('service not allowed')) {
        return 'Microphone access is blocked. Allow it in your browser settings, then try again.'
      }
      return 'Voice capture could not start right now. Please try again.'
    }
    if (lower === 'we could not complete that request right now. please try again.') {
      return 'That action could not be completed right now. Refresh and try again. If it keeps happening, sign out and sign back in.'
    }
    if (lower.includes('over_email_send_rate_limit') || lower.includes('email rate limit exceeded')) {
      return 'Too many verification codes were requested too quickly. Please wait a moment and try again.'
    }
    if (lower.includes('took too long') || lower.includes('timed out') || lower.includes('timeout')) {
      return 'The request is taking too long. Check your internet connection and try again.'
    }
    if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed')) return 'We could not connect right now. Please try again.'
    if (lower.includes('hid code or access pin')) return 'The HID code or access PIN is not correct.'
    if (lower.includes('multiple (or no) rows returned') || lower.includes('0 rows')) return 'We could not find the information you requested.'
    if (lower.includes('account for this hospital already exists')) return 'The information has already been used, Try to sign in.'
    if (lower.includes('already linked to a patient account')) return 'The information has already been used, Try to sign in.'
    if (lower.includes('cannot be used for a hospital account')) return 'These details cannot be used for this request. Try different details or contact support.'
    if (lower.includes('phone number is already linked') || lower.includes('email address or phone number is already linked')) {
      return 'The information has already been used, Try to sign in.'
    }
    if (lower.includes('email address is already linked to an hid account')) {
      return 'The information has already been used, Try to sign in.'
    }
    if (lower.includes('phone number is already linked to another hid account')) {
      return 'The information has already been used, Try to sign in.'
    }
    if (lower.includes('email address and phone number are already linked')) {
      return 'The information has already been used, Try to sign in.'
    }
    if (lower.includes('idx_hid_patients_phone') || lower.includes('idx_hid_patients_email')) {
      return 'The information has already been used, Try to sign in.'
    }
    if (lower.includes('user already registered')) return 'The information has already been used, Try to sign in.'
    if (lower.includes('duplicate key') || lower.includes('already exists')) return 'The information has already been used, Try to sign in.'
    if (lower.includes('patient profile already exists')) return 'The information has already been used, Try to sign in.'
    if (lower.includes('you do not have permission to perform this action')) return 'Your account is signed in, but it is not allowed to do that yet.'
    if (lower.includes('permission denied') || lower.includes('not allowed') || lower.includes('cannot perform this action')) return 'This account cannot perform that action right now.'
    if (lower.includes('schema cache')) return 'This information could not be saved right now. Please try again.'
    if (lower.includes('invalid input syntax')) return 'Some information is not in the right format. Please review it and try again.'
    if (lower.includes('incorrect otp')) return 'The verification code is not correct.'
    if (lower.includes('incorrect reset otp')) return 'The password reset code is not correct.'
    if (lower.includes('passwords do not match')) return 'The passwords do not match.'
    if (
      lower.includes('invalid credentials') ||
      lower.includes('invalid hospital credentials')
    ) return 'The sign-in details are not correct.'
    if (isBannedAuthMessage(raw)) return BANNED_ACCOUNT_MESSAGE
    if (lower.includes('email not confirmed')) return 'Enter the verification code sent to your email to continue.'
    if (lower.includes('signups not allowed') || lower.includes('phone signups are disabled') || lower.includes('signups not allowed for otp') || (lower.includes('signup') && lower.includes('disabled'))) {
      return 'Patient self-sign-up is currently disabled.'
    }
    if (lower.includes('hospital name, state, and country are required')) return 'Please enter hospital name, state, and country.'
    if (lower.includes('no active staff invite') || lower.includes('staff invite is incomplete')) {
      return 'This account is not ready to continue right now. Please try again shortly or contact support.'
    }
    if (lower.includes('hospital account setup is incomplete')) {
      return 'This account is not ready to continue right now. Please try again shortly or contact support.'
    }
    if (lower.includes('hospital account is still finishing setup') || lower.includes('staff onboarding could not be completed')) {
      return 'This account is not ready to continue right now. Please try again shortly or contact support.'
    }
    if (lower.includes('verify the email to finish creating') || lower.includes('verification code sent to your email')) {
      return 'Enter the 6-digit verification code sent to your email to continue.'
    }
    if (lower.includes('request body must be valid json')) {
      return 'Some information could not be sent correctly. Please try again.'
    }
    if (lower.includes('missing user email')) {
      return 'This email address could not be used for verification. Please try again.'
    }
    if (lower.includes('complete the security check to continue')) {
      return 'Verify you\'re human before continuing.'
    }
    if (lower.includes('complete the security check below to continue')) {
      return 'Select "Verify you\'re human" to continue.'
    }
    if (lower.includes('mfa enroll is disabled for totp') || lower.includes('totp enroll is disabled')) {
      return 'Authenticator setup is not available right now. Ask an administrator to enable MFA, then try again.'
    }
    if (lower.includes('captcha verification') && lower.includes('failed')) {
      return 'We could not complete the security check. Please try again.'
    }
    if (lower.includes('turnstile failed to load')) {
      return 'Security check failed to load. Refresh and try again.'
    }
    if (lower.includes('captcha token') && (lower.includes('missing') || lower.includes('required'))) {
      return 'Verify you\'re human before continuing.'
    }
    if (lower.includes('unable to send') && lower.includes('verification code')) {
      return 'We could not send the verification code right now. Please try again.'
    }
    if (lower.includes('unable to send auth email')) {
      return 'We could not send the verification code right now. Please try again.'
    }
    if (lower.includes('unable to send another verification code')) {
      return 'We could not send another verification code right now. Please try again.'
    }
    if (lower.includes('unable to create the hospital account')) {
      return 'We could not start the hospital account right now. Please try again.'
    }
    if (lower.includes('unable to create the account right now')) {
      return 'We could not start sign-up right now. Please try again.'
    }
    if (lower.includes('unable to access this patient right now')) {
      return 'We could not open this patient right now. Check the HID code and Access PIN and try again.'
    }
    if (lower.includes('patient account has been deleted')) {
      return 'This account is not available right now. Contact support if you need help.'
    }
    if (lower.includes('account has been deleted')) {
      return 'This account is not available right now. Contact support if you need help.'
    }
    if (lower.includes('patient account is locked')) {
      return 'This account is not available right now. Contact support if you need help.'
    }
    if (lower.includes('account is inactive') || lower.includes('account is not active') || lower.includes('account is locked')) {
      return 'This account is not available right now. Contact support if you need help.'
    }
    if (lower.includes('unable to save the medical record')) {
      return 'We could not save the medical record right now. Please try again.'
    }
    if (lower.includes('unable to save the patient profile') || lower.includes('save that profile information')) {
      return 'We could not save those profile changes right now. Review the email address and phone number, then try again.'
    }
    if (
      lower.includes('lock:sb-') ||
      lower.includes('auth-token') ||
      lower.includes('lock was stolen by another request') ||
      lower.includes('another request stole it')
    ) {
      return 'Your session was updated in another tab or request. Please try again.'
    }
    if (lower.includes('aborterror')) {
      return 'The request was interrupted. Please try again.'
    }
    if (lower.includes('jwt') || lower.includes('refresh token')) {
      return 'Your session needs to be refreshed. Please sign in again.'
    }
    if (lower.includes('column reference') || lower.includes('ambiguous') || lower.includes('stack depth') || lower.includes('recursion')) {
      return 'This service is temporarily unavailable right now. Please try again shortly.'
    }
    if (lower.includes('please sign in again')) return 'Please sign in again to continue.'
    if (lower.includes('authentication required') || lower.includes('missing authorization')) return 'Please sign in to continue.'
    if (
      lower.includes('patient was not found') ||
      lower.includes('could not be verified')
    ) return 'We could not verify those details.'
    if (lower.includes('access pin must be 4 to 8 digits')) return 'Access PIN must be 4 to 8 digits.'
    if (lower.includes('not found')) return 'We could not find the information you requested.'
    if (lower.includes('expired')) return 'This session has expired. Please try again.'
    if (isSensitiveAccountMessage(lower)) return 'This request could not be completed with those details. Please try again or contact support.'
  }

  const readable = toReadableSentence(raw)
  if (type === 'error') {
    if (!isLowSignalError(lower) && !isTechnicalErrorMessage(lower, raw)) {
      return readable
    }
    return fallbackErrorMessage(raw)
  }

  return readable
}

export function sanitizeUserFacingMessage(message: string, type: ToastType = 'error') {
  return normalizeToastMessage(message, type)
}

export function showToast(msg: string, type: ToastType = 'info') {
  const normalized = normalizeToastMessage(msg, type)
  toastHandlers.forEach(handler => handler(normalized, type))
}

export function ToastProvider() {
  const [toasts, setToasts] = useState<ToastState[]>([])
  let counter = 0

  useEffect(() => {
    const handler = (msg: string, type: ToastType) => {
      const id = ++counter
      setToasts(items => [...items, { id, msg, type }])
      setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 3500)
    }

    toastHandlers.push(handler)
    return () => {
      toastHandlers = toastHandlers.filter(current => current !== handler)
    }
  }, [])

  const colors: Record<ToastType, { bg: string; border: string; icon: string }> = {
    success: { bg: '#f0fdf4', border: '#86efac', icon: '✓' },
    error: { bg: '#fef2f2', border: '#fca5a5', icon: '✕' },
    info: { bg: '#eff6ff', border: '#93c5fd', icon: 'i' },
  }

  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {toasts.map(toast => {
        const colorsForToast = colors[toast.type]
        return (
          <div
            key={toast.id}
            style={{
              background: colorsForToast.bg,
              border: `1px solid ${colorsForToast.border}`,
              borderRadius: 10,
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
              maxWidth: 360,
              fontSize: 14,
              animation: 'slideIn 0.2s ease',
            }}
          >
            <style>{'@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}'}</style>
            <span style={{ fontWeight: 700, fontSize: 12, width: 18, height: 18, borderRadius: '50%', background: colorsForToast.border, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {colorsForToast.icon}
            </span>
            {toast.msg}
          </div>
        )
      })}
    </div>
  )
}
