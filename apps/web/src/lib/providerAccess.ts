const configuredEhrUrl = import.meta.env.VITE_EHR_APP_URL?.trim()

/**
 * Provider access is hosted by the maintained EHR client. Production can point
 * this at the deployed EHR origin; local development routes through the shared
 * localhost gateway so patients and providers remain on one browser origin.
 */
export const PROVIDER_ACCESS_HREF = import.meta.env.DEV
  ? '/ehr/'
  : configuredEhrUrl || '/hospital/auth'
