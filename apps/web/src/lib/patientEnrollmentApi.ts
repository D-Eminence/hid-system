import { canonicalRequest } from './identityClient'
import { createPatientEnrollmentApi } from './patientEnrollmentContract'

export * from './patientEnrollmentContract'
export const patientEnrollmentApi = createPatientEnrollmentApi(canonicalRequest)
