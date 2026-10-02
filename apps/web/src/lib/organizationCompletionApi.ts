import { canonicalRequest } from './identityClient'
import { normalizeCacRegistrationNumber, type ProductCode } from './organizationApplicationApi'

export type OrganizationFieldSource = 'qoreid' | 'user_provided' | null
export type OrganizationProfileFieldName =
  'companyName' | 'entityType' | 'registrationDate' | 'address' | 'registryStatus'
export type OrganizationProfileField = { value: string | null; source: OrganizationFieldSource }
export type OrganizationCompletionProfile = {
  status: 'pending_verification' | 'ready_for_review'
  profileState: 'incomplete' | 'complete'
  version: number
  productCode: ProductCode
  registrationNumber: string
  fields: Record<OrganizationProfileFieldName, OrganizationProfileField>
}
export type OrganizationProfilePatch = Partial<Record<OrganizationProfileFieldName, string>>
export type OrganizationCompletionChallenge = {
  accepted: true
  challengeId: string
  expiresInSeconds: number
  resendAfterSeconds: number
}

const completionPath = '/api/v1/identity/organization-applications/completion'
const fieldNames: readonly OrganizationProfileFieldName[] = [
  'companyName', 'entityType', 'registrationDate', 'address', 'registryStatus',
]

export async function startOrganizationCompletion(input: {
  productCode: ProductCode
  cacRegistrationNumber: string
  administratorEmail: string
  turnstileToken: string
}): Promise<OrganizationCompletionChallenge> {
  const cacRegistrationNumber = normalizeCacRegistrationNumber(input.cacRegistrationNumber)
  const administratorEmail = input.administratorEmail.trim().toLowerCase()
  if (!/^(RC|BN|IT)[0-9]{4,20}$/.test(cacRegistrationNumber)) {
    throw new Error('Enter a CAC registration number with its RC, BN, or IT prefix.')
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(administratorEmail) || administratorEmail.length > 254) {
    throw new Error('Enter the administrator email used on the application.')
  }
  return canonicalRequest<OrganizationCompletionChallenge>(`${completionPath}/start`, {
    method: 'POST',
    body: JSON.stringify({ productCode: input.productCode, cacRegistrationNumber,
      administratorEmail, turnstileAction: 'organization-completion',
      turnstileToken: input.turnstileToken }),
  })
}

export async function verifyOrganizationCompletion(challengeId: string, code: string): Promise<void> {
  if (!/^[0-9]{6}$/.test(code)) throw new Error('Enter the six-digit email code.')
  const result = await canonicalRequest<{ verified: true }>(`${completionPath}/verify`, {
    method: 'POST', body: JSON.stringify({ challengeId, code }),
  })
  if (result?.verified !== true) throw new Error('The email code could not be verified.')
}

export function getOrganizationCompletionProfile(): Promise<OrganizationCompletionProfile> {
  return canonicalRequest<OrganizationCompletionProfile>(`${completionPath}/profile`)
}

export async function saveOrganizationCompletionProfile(
  profile: OrganizationCompletionProfile,
  input: OrganizationProfilePatch,
): Promise<OrganizationCompletionProfile> {
  if (profile.status !== 'pending_verification') throw new Error('This organization profile is already awaiting review.')
  const body: OrganizationProfilePatch = {}
  for (const name of fieldNames) {
    const value = input[name]?.trim()
    if (!value) continue
    if (profile.fields[name].source === 'qoreid') {
      throw new Error('A QoreID-provided profile field cannot be replaced.')
    }
    body[name] = value
  }
  if (Object.keys(body).length === 0) throw new Error('Enter at least one missing organization detail.')
  return canonicalRequest<OrganizationCompletionProfile>(`${completionPath}/profile`, {
    method: 'PATCH', headers: { 'If-Match': `"${profile.version}"` }, body: JSON.stringify(body),
  })
}
