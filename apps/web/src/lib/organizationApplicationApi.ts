import { canonicalRequest } from './identityClient'

export type OrganizationType = 'hospital' | 'clinic' | 'laboratory' | 'pharmacy'
export type ProductCode = 'ehr' | 'migrate' | 'laboratory' | 'pharmacy'

export interface OrganizationApplicationInput {
  organizationName: string
  organizationType: OrganizationType
  productCode: ProductCode
  cacRegistrationNumber: string
  administratorName: string
  administratorEmail: string
  turnstileToken: string
}

export const productOptions: Record<OrganizationType, readonly ProductCode[]> = {
  hospital: ['ehr', 'laboratory', 'pharmacy', 'migrate'],
  clinic: ['ehr', 'laboratory', 'pharmacy', 'migrate'],
  laboratory: ['laboratory'],
  pharmacy: ['pharmacy'],
}

export function normalizeCacRegistrationNumber(value: string) {
  return value.replace(/\s+/g, '').toUpperCase()
}

export async function submitOrganizationApplication(input: OrganizationApplicationInput): Promise<void> {
  const organizationName = input.organizationName.trim()
  const administratorName = input.administratorName.trim()
  const administratorEmail = input.administratorEmail.trim()
  const cacRegistrationNumber = normalizeCacRegistrationNumber(input.cacRegistrationNumber)
  if (!productOptions[input.organizationType]?.includes(input.productCode)) {
    throw new Error('Choose a product for your organization type.')
  }
  if (organizationName.length < 2 || organizationName.length > 200 ||
    administratorName.length < 2 || administratorName.length > 200 ||
    administratorEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(administratorEmail)) {
    throw new Error('Check the organization and administrator details.')
  }
  if (!/^(RC|BN|IT)[0-9]{4,20}$/.test(cacRegistrationNumber)) {
    throw new Error('Enter a CAC registration number with its RC, BN, or IT prefix.')
  }
  const result = await canonicalRequest<{ accepted: true }>('/api/v1/identity/organization-applications', {
    method: 'POST',
    body: JSON.stringify({
      productCode: input.productCode,
      organizationName,
      organizationType: input.organizationType,
      cacRegistrationNumber,
      administratorName,
      administratorEmail,
      turnstileAction: 'organization-application',
      turnstileToken: input.turnstileToken,
    }),
  })
  if (result?.accepted !== true) throw new Error('The application could not be received. Please try again.')
}
