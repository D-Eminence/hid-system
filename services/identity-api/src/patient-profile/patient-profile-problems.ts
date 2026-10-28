import { DomainProblem } from '../common/problem';
import { isDatabaseError } from '../patient-safety/database-error';

/**
 * The answer to a 0094 command's database refusal: no live patient session
 * (42501) is 403 PATIENT_ACCESS_DENIED, a value the command refuses (22023,
 * 23514; the service checks first, so only a changed client meets it) is 400
 * PROFILE_REQUEST_INVALID. Anything else is rethrown as it is.
 */
export function patientCommandProblem(error: unknown): unknown {
  if (error instanceof DomainProblem || !isDatabaseError(error)) return error;
  if (error.code === '42501') return new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
  if (error.code === '22023' || error.code === '23514') {
    return new DomainProblem(400, 'PROFILE_REQUEST_INVALID', 'One or more profile values are invalid.');
  }
  return error;
}
