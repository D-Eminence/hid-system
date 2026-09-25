import { canonicalRequest } from './identityClient'
import { createCarePortalApi } from './carePortalContract'
export * from './carePortalContract'
export const carePortalApi = createCarePortalApi(canonicalRequest)
