import { useCallback, useEffect, useRef, useState } from 'react'
import { showToast } from '../components/ui'
import { ensureCaptchaReady, isTurnstileConfigured } from '../lib/captcha'

type CaptchaNoticeTone = 'error' | 'info'
const DEFAULT_CAPTCHA_MESSAGE = 'Verify you\'re human before continuing.'

type CaptchaGateOptions = {
  requiredMessage?: string
  unavailableMessage?: string
}

type PendingAction = (captchaToken: string | null) => void | Promise<void>

export function useCaptchaGate() {
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [captchaResetKey, setCaptchaResetKey] = useState(0)
  const [captchaVisible, setCaptchaVisible] = useState(false)
  const [captchaNotice, setCaptchaNotice] = useState<{ message: string; tone: CaptchaNoticeTone } | null>(null)
  const pendingActionRef = useRef<PendingAction | null>(null)
  const turnstileConfigured = isTurnstileConfigured()

  const resetCaptcha = useCallback(() => {
    pendingActionRef.current = null
    setCaptchaToken(null)
    setCaptchaVisible(false)
    setCaptchaNotice(null)
    setCaptchaResetKey(current => current + 1)
  }, [])

  const primeCaptcha = useCallback((message = DEFAULT_CAPTCHA_MESSAGE) => {
    if (!turnstileConfigured || captchaToken) return

    setCaptchaVisible(true)
    setCaptchaNotice(current => (
      current?.tone === 'error'
        ? current
        : null
    ))
  }, [captchaToken, turnstileConfigured])

  const hideCaptcha = useCallback(() => {
    if (pendingActionRef.current || captchaToken) return
    setCaptchaVisible(false)
    setCaptchaNotice(current => (current?.tone === 'error' ? current : null))
  }, [captchaToken])

  const onTokenChange = useCallback((token: string | null) => {
    setCaptchaToken(token)
    if (token) {
      setCaptchaNotice(null)
      return
    }

    setCaptchaNotice(current => (
      current?.tone === 'error'
        ? current
        : null
    ))
  }, [])

  const runWithCaptcha = useCallback((action: PendingAction, options: CaptchaGateOptions = {}) => {
    if (ensureCaptchaReady(captchaToken)) {
      setCaptchaNotice(null)
      void action(captchaToken)
      return true
    }

    if (!turnstileConfigured) {
      const message = options.unavailableMessage ?? 'Security check is not configured right now. Please contact support.'
      setCaptchaNotice({ message, tone: 'error' })
      showToast(message, 'error')
      return false
    }

    pendingActionRef.current = action
    setCaptchaVisible(true)
    setCaptchaNotice(null)
    showToast(options.requiredMessage ?? DEFAULT_CAPTCHA_MESSAGE, 'error')
    return false
  }, [captchaToken, turnstileConfigured])

  useEffect(() => {
    if (!captchaToken || !pendingActionRef.current) return

    const action = pendingActionRef.current
    pendingActionRef.current = null
    void action(captchaToken)
  }, [captchaToken])

  return {
    captchaNotice,
    captchaResetKey,
    captchaToken,
    captchaVisible,
    hideCaptcha,
    onTokenChange,
    primeCaptcha,
    resetCaptcha,
    runWithCaptcha,
  }
}
