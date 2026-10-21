import { DomainProblem } from '../common/problem';

/**
 * The codes with which EHR, Lab and Pharmacy refuse OCR's own workload
 * credential: the internal-caller header, the local secret or the workload JWT
 * (a JWKS fetch failure fails the JWT too). A 401 or 403 with one of them is a
 * fault between services, not a refusal of the user's credential or of the
 * request, so OCR answers it as 503 <SERVICE>_SERVICE_AUTH_UNAVAILABLE: the
 * browser does not refresh its session for it, and a publication stores it as
 * the retryable OWNING_SERVICE_UNAVAILABLE. Any other 401 or 403 (the user's
 * session, facility or permission) keeps the owning service's status and code.
 * Identity renders its workload refusals as AUTHENTICATION_REQUIRED and
 * ACCESS_DENIED, which cannot be told apart from a user refusal by code.
 */
export const WORKLOAD_AUTHENTICATION_CODES: ReadonlySet<string> = new Set([
  'INTERNAL_SERVICE_AUTH_REQUIRED', 'INVALID_WORKLOAD_IDENTITY', 'WORKLOAD_CALLER_DENIED',
  'WORKLOAD_IDENTITY_UNAVAILABLE',
]);

const SERVICE_NAMES = { EHR: 'EHR', LAB: 'Lab', PHARMACY: 'Pharmacy' } as const;

/** The 503 for an owning service's refusal of OCR's workload credential, or undefined for any other answer. */
export function workloadAuthenticationRefusal(service: keyof typeof SERVICE_NAMES, status: number,
  code: unknown): DomainProblem | undefined {
  if ((status !== 401 && status !== 403) || typeof code !== 'string' || !WORKLOAD_AUTHENTICATION_CODES.has(code)) {
    return undefined;
  }
  return new DomainProblem(503, `${service}_SERVICE_AUTH_UNAVAILABLE`,
    `${SERVICE_NAMES[service]} service refused the OCR service identity`);
}
