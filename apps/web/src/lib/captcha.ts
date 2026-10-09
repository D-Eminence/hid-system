export function getTurnstileSiteKey() {
  return (
    import.meta.env.VITE_TURNSTILE_SITE_KEY || ''
  ).trim()
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '0.0.0.0' || normalized.endsWith('.local')
}

export function isTurnstileConfigured() {
  return Boolean(getTurnstileSiteKey())
}

export function isCaptchaBypassAllowed() {
  if (typeof window === 'undefined') return false
  return Boolean(import.meta.env.DEV) || isLocalHostname(window.location.hostname)
}

export function ensureCaptchaReady(token: string | null | undefined) {
  if (!isTurnstileConfigured()) {
    return isCaptchaBypassAllowed()
  }
  return Boolean(token)
}
