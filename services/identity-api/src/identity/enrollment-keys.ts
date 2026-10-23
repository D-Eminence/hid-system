import type { Environment } from '../config/environment';

/**
 * The keys a public patient enrollment start needs before it reads a NIN: the
 * NIN lookup and encryption keys, and where NODE_ENV is production the OTP
 * key. Without them a start answers 503 ENROLLMENT_CONFIGURATION_UNAVAILABLE,
 * availability answers open: false and the Integrations page shows NIN
 * enrollment closed.
 */
export function enrollmentKeysConfigured(environment: Pick<Environment,
  'NIN_LOOKUP_HMAC_KEY_B64' | 'NIN_ENCRYPTION_KEY_B64' | 'OTP_HMAC_KEY_B64' | 'NODE_ENV'>): boolean {
  return Boolean(environment.NIN_LOOKUP_HMAC_KEY_B64 && environment.NIN_ENCRYPTION_KEY_B64
    && (environment.NODE_ENV !== 'production' || environment.OTP_HMAC_KEY_B64));
}
