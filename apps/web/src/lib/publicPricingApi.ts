import { canonicalRequest } from './identityClient'

export type PublicPrice = {
  product_slug: string; context: string; visibility: string; amount_minor: number | null
  currency: string; billing_period: string | null; unit: string | null
}
export async function fetchPublicPricing(): Promise<PublicPrice[]> {
  const prices = await canonicalRequest<PublicPrice[]>('/api/v1/commercial/pricing', { method: 'GET' })
  if (!Array.isArray(prices)) throw new Error('Pricing could not be loaded right now.')
  return prices
}
