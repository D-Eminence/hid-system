export type EnrollmentContactChannel = 'phone' | 'email'
export type EnrollmentStage = 'verify_contact' | 'set_password' | 'active'

export interface PatientEnrollmentProgress {
  stage: EnrollmentStage
  hidCode?: string
  contactChannel?: EnrollmentContactChannel
  maskedContact?: string
  challengeId?: string
  expiresInSeconds?: number
  resendAfterSeconds?: number
  expiresAt?: string
  googleOnboardingRequired?: boolean
  googleOnboardingExpiresAt?: string
}

export interface PatientContactChallenge {
  challengeId: string
  expiresInSeconds: number
  resendAfterSeconds: number
}

export interface ActivatedPatientEnrollment {
  stage: 'active'
  hidCode: string
}

export type PatientEnrollmentTransport = <T>(path: string, init?: RequestInit) => Promise<T>
const endpoint = '/api/v1/identity/patient-enrollments'

export function normalizeEnrollmentNin(value: string) {
  const nin = value.replace(/[\s-]/g, '')
  if (!/^\d{11}$/.test(nin)) throw new Error('Enter an 11-digit NIN.')
  return nin
}

export function normalizeEnrollmentContact(channel: EnrollmentContactChannel, value: string) {
  const contact = value.trim()
  if (channel === 'email') {
    const email = contact.toLowerCase()
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Enter a valid email address.')
    }
    return email
  }

  const phone = /^0\d{10}$/.test(contact) ? `+234${contact.slice(1)}` : contact.replace(/[\s()-]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error('Enter a phone number with its country code, such as +2348012345678.')
  }
  return phone
}

export function newEnrollmentIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure enrollment is unavailable in this browser.')
  }
  return globalThis.crypto.randomUUID()
}

export function isEnrollmentIdempotencyKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function createPatientEnrollmentApi(send: PatientEnrollmentTransport) {
  return {
    current: () => send<PatientEnrollmentProgress>(`${endpoint}/current`),
    bindGoogle: () => send<{ bound: true }>(`${endpoint}/google`, { method: 'POST' }),
    start(ninInput: string, turnstileToken: string | null, idempotencyKey: string) {
      const nin = normalizeEnrollmentNin(ninInput)
      if (!isEnrollmentIdempotencyKey(idempotencyKey)) {
        throw new Error('The enrollment request could not be initialized.')
      }
      return send<PatientEnrollmentProgress>(endpoint, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ nin, turnstileAction: 'patient-enrollment', turnstileToken: turnstileToken ?? '' }),
      })
    },
    contact(channel: EnrollmentContactChannel, value: string) {
      const contact = normalizeEnrollmentContact(channel, value)
      return send<PatientContactChallenge>(`${endpoint}/contact`, {
        method: 'POST', body: JSON.stringify({ channel, contact }),
      })
    },
    verifyContact(challengeId: string, code: string) {
      if (!challengeId || !/^\d{6}$/.test(code)) throw new Error('Enter the six-digit verification code.')
      return send<{ stage: 'set_password' }>(`${endpoint}/contact/verify`, {
        method: 'POST', body: JSON.stringify({ challengeId, code }),
      })
    },
    activate(password: string) {
      if (password.length < 12 || password.length > 256) {
        throw new Error('Use a password of 12–256 characters.')
      }
      return send<ActivatedPatientEnrollment>(`${endpoint}/activate`, {
        method: 'POST', body: JSON.stringify({ password }),
      })
    },
  }
}
