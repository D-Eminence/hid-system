import { DomainProblem } from '../common/problem';

/** Maps governed SQL command errors (0027, 0068-0070) to stable API problems. */
export function adminCommandError(error: unknown): Error {
  if (error instanceof DomainProblem) return error;
  const message = typeof error === 'object' && error && 'message' in error ? String(error.message) : '';
  const problems: readonly [string, number, string, string][] = [
    ['ADMIN_STEP_UP_REQUIRED', 403, 'STEP_UP_REQUIRED', 'Confirm with your authenticator code to continue'],
    ['ADMIN_APPROVAL_REQUIRED', 403, 'TWO_PERSON_APPROVAL_REQUIRED', 'Granting Super Admin requires a second Super Admin to approve'],
    ['ADMIN_SELF_APPROVAL_DENIED', 403, 'SELF_APPROVAL_DENIED', 'The requester and the affected administrator cannot approve'],
    ['ADMIN_APPROVER_INELIGIBLE', 403, 'APPROVER_INELIGIBLE', 'Only another active, MFA-enrolled Super Admin can decide'],
    ['ADMIN_APPROVAL_CANCEL_DENIED', 403, 'APPROVAL_CANCEL_DENIED', 'Only the requester can cancel this request'],
    ['ADMIN_MFA_REQUIRED', 403, 'MFA_REQUIRED', 'An enrolled authenticator is required for this command'],
    ['ADMIN_SELF_CHANGE_DENIED', 403, 'ADMIN_SELF_CHANGE_DENIED', 'Administrators cannot change their own account status or platform roles'],
    ['ADMIN_ACCOUNT_RECOVERY_REQUIRED', 409, 'ACCOUNT_RECOVERY_REQUIRED', 'This account must complete its recovery flow before it can become active'],
    ['ADMIN_PERMISSION_DENIED', 403, 'PERMISSION_DENIED', 'Administrative permission is missing'],
    ['ADMIN_VERSION_CONFLICT', 409, 'VERSION_CONFLICT', 'The resource changed; reload before retrying'],
    ['ADMIN_IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was used for a different command'],
    ['ADMIN_LAST_SUPER_ADMIN', 409, 'LAST_SUPER_ADMIN', 'At least one active platform Super Admin must remain'],
    ['ADMIN_APPROVAL_NOT_PENDING', 409, 'APPROVAL_NOT_PENDING', 'This request has already been decided'],
    ['ADMIN_APPROVAL_ALREADY_PENDING', 409, 'APPROVAL_ALREADY_PENDING', 'A request for this administrator is already pending'],
    ['ADMIN_APPROVAL_EXPIRED', 409, 'APPROVAL_EXPIRED', 'This request expired; create a new one'],
    ['ADMIN_TARGET_INELIGIBLE', 409, 'TARGET_INELIGIBLE', 'The account cannot receive this change in its current state'],
    ['ADMIN_MFA_NOT_ENROLLED', 409, 'MFA_NOT_ENROLLED', 'This administrator has no authenticator to reset'],
  ];
  for (const [marker, status, code, detail] of problems) {
    if (message.includes(marker)) return new DomainProblem(status, code, detail);
  }
  if (message.includes('NOT_FOUND') || message.includes('NOT_ACTIVE')) return new DomainProblem(404, 'ADMIN_RESOURCE_NOT_FOUND', 'The requested administration resource was not found');
  if (message.includes('ALREADY_ACTIVE') || message.includes('NO_STATE_CHANGE')) return new DomainProblem(409, 'ADMIN_STATE_CONFLICT', 'The requested state is already active');
  if (message.includes('ADMIN_INVALID') || message.includes('ADMIN_REASON_REQUIRED')) return new DomainProblem(400, 'ADMIN_COMMAND_INVALID', 'The administration command is invalid');
  return new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'The administration command could not be completed');
}
