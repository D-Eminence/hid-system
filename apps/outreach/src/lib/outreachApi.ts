import {
  OutreachApiClient,
  OutreachApiProblem,
  type OutreachRegistrationCase,
  type OutreachRequestContext,
} from '@hid/api-client'
import { getIdentityCsrfToken, identityClient } from '@hid/identity-browser-client'
import type {
  OutreachCampaign,
  OutreachInvite,
  OutreachRole,
  OutreachWorker,
} from '../types/outreach'

export { OutreachApiProblem }
export type { OutreachRegistrationCase, OutreachRequestContext }

export const outreachClient = new OutreachApiClient({ baseUrl: '', credentials: 'include' })

export function outreachRequestContext(facilityId: string): OutreachRequestContext {
  return {
    correlationId: crypto.randomUUID(),
    facilityId,
    purposeOfUse: 'direct-care',
    csrfToken: getIdentityCsrfToken() ?? undefined,
  }
}

function unavailable(): never {
  throw new OutreachApiProblem(403, {
    code: 'OUTREACH_PROVISIONING_UNAVAILABLE',
    detail: 'Outreach access is provisioned by an authorized facility administrator.',
  })
}

export type OutreachSignupPayload = {
  email: string
  password: string
  displayName: string
  campaignName: string
  org: string
  location: string
  startsAt: string
}

export type OutreachSignupResult = {
  otpId: string
  maskedEmail: string
  expiresAt: string
  expiresInMinutes: number
}

export type OutreachVerifyResult = {
  session: { access_token: string; refresh_token: string; expires_in: number; token_type: string }
  worker: OutreachWorker
  campaign: OutreachCampaign
}

export type OutreachResendResult = {
  maskedEmail: string
  expiresAt: string
  expiresInMinutes: number
  resendsRemaining: number
}

export type OutreachJoinResult = {
  session: { access_token: string; refresh_token: string; expires_in: number; token_type: string }
  worker: OutreachWorker
}

export async function loginOutreachWorker(email: string, password: string, turnstileToken?: string): Promise<void> {
  const { data, error } = await identityClient.auth.signInWithPassword({
    email, password, options: { captchaToken: turnstileToken, captchaAction: 'outreach-login' },
  })
  if (error) throw error
  if (!data.session?.user.id) throw new Error('Sign-in failed. Please try again.')
}

export async function signupOutreachAdmin(_payload: OutreachSignupPayload): Promise<OutreachSignupResult> {
  return unavailable()
}

export async function verifyOutreachOtp(_otpId: string, _code: string): Promise<OutreachVerifyResult> {
  return unavailable()
}

export async function resendOutreachOtp(_otpId: string): Promise<OutreachResendResult> {
  return unavailable()
}

export async function joinWithInviteCode(_code: string, _email: string, _password: string,
  _displayName: string): Promise<OutreachJoinResult> {
  return unavailable()
}

export async function fetchOutreachWorker(_userId: string): Promise<OutreachWorker | null> {
  return unavailable()
}

export async function fetchOutreachCampaigns(_campaignId?: string): Promise<OutreachCampaign[]> {
  return unavailable()
}

export async function createOutreachCampaign(_name: string, _org: string, _location: string,
  _startsAt: string): Promise<OutreachCampaign> {
  return unavailable()
}

export async function createOutreachWorker(_authUserId: string, _campaignId: string,
  _displayName: string, _role: OutreachRole): Promise<OutreachWorker> {
  return unavailable()
}

export async function createInviteCode(_workerId: string, _campaignId: string,
  _role: OutreachRole): Promise<OutreachInvite> {
  return unavailable()
}

export async function fetchCampaignInvite(_campaignId: string,
  _workerId: string): Promise<OutreachInvite | null> {
  return unavailable()
}

export async function fetchInviteByCode(_rawCode: string): Promise<OutreachInvite | null> {
  return unavailable()
}

export async function fetchCampaignById(_id: string): Promise<OutreachCampaign | null> {
  return unavailable()
}

export async function incrementInviteUseCount(_inviteId: string): Promise<void> {
  return unavailable()
}
