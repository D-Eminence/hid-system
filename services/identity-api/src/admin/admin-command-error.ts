import { DomainProblem } from '../common/problem';

/** Maps governed SQL command errors (0027, 0068-0070, 0087, 0094) to stable API problems. */
export function adminCommandError(error: unknown): Error {
  if (error instanceof DomainProblem) return error;
  const message = typeof error === 'object' && error && 'message' in error ? String(error.message) : '';
  const problems: readonly [string, number, string, string][] = [
    // Clinician application review (ADR-064, 0094). Before the generic
    // NOT_FOUND and *_INVALID fallbacks below, which these would also match.
    ['CLINICIAN_APPLICATION_COMMAND_INVALID', 400, 'CLINICIAN_APPLICATION_COMMAND_INVALID', 'The application command is invalid'],
    ['CLINICIAN_APPLICATION_SECOND_ADMIN_REQUIRED', 403, 'CLINICIAN_APPLICATION_SECOND_ADMIN_REQUIRED', 'A different Super Admin must approve an application you verified'],
    ['CLINICIAN_APPLICATION_NOT_FOUND', 404, 'CLINICIAN_APPLICATION_NOT_FOUND', 'The application was not found'],
    ['CLINICIAN_APPLICATION_STATE_INVALID', 409, 'CLINICIAN_APPLICATION_STATE_INVALID', 'This application is no longer at this step; reload it'],
    ['CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', 409, 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', 'The applicant\'s authenticator was not verified in this step'],
    ['CLINICIAN_APPLICATION_AUTHENTICATOR_CHANGED', 409, 'CLINICIAN_APPLICATION_AUTHENTICATOR_CHANGED', 'The applicant\'s authenticator changed after step 1; reject the application or verify again'],
    ['CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE', 409, 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE', 'The applicant\'s account cannot be granted access in its current state'],
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
    // Launch D14 workforce provisioning (0087).
    ['WORKFORCE_SELF_CHANGE_DENIED', 403, 'WORKFORCE_SELF_CHANGE_DENIED', 'Administrators cannot provision their own facility access'],
    ['WORKFORCE_FACILITY_CONFLICT', 403, 'WORKFORCE_FACILITY_CONFLICT', 'Administrators who work at this facility cannot provision its clinicians'],
    ['WORKFORCE_SECOND_PERSON_REQUIRED', 403, 'WORKFORCE_SECOND_PERSON_REQUIRED', 'A clinical role needs a credential attestation recorded by another administrator'],
    ['WORKFORCE_ATTESTATION_REQUIRED', 409, 'WORKFORCE_ATTESTATION_REQUIRED', 'No current credential attestation by an independent reviewer supports this role at this facility'],
    ['WORKFORCE_ROLE_CONFLICT', 409, 'WORKFORCE_ROLE_CONFLICT', 'A facility administrator membership cannot hold a clinical role'],
    ['WORKFORCE_ROLE_NOT_GRANTABLE', 400, 'WORKFORCE_ROLE_NOT_GRANTABLE', 'This role cannot be granted through workforce provisioning'],
    ['WORKFORCE_ROLE_ALREADY_ACTIVE', 409, 'WORKFORCE_ROLE_ALREADY_ACTIVE', 'The membership already holds this role'],
    ['WORKFORCE_ROLE_NOT_ACTIVE', 409, 'WORKFORCE_ROLE_NOT_ACTIVE', 'The membership does not hold this role'],
    ['WORKFORCE_MEMBERSHIP_EXISTS', 409, 'WORKFORCE_MEMBERSHIP_EXISTS', 'The account already has an active or pending membership at this facility'],
    ['WORKFORCE_MEMBERSHIP_ENDED', 409, 'WORKFORCE_MEMBERSHIP_ENDED', 'This membership has ended; attach the person again for new access'],
    ['WORKFORCE_MEMBERSHIP_INACTIVE', 409, 'WORKFORCE_MEMBERSHIP_INACTIVE', 'This membership is inactive and was not attached through workforce provisioning'],
    ['WORKFORCE_MEMBERSHIP_HELD', 409, 'WORKFORCE_MEMBERSHIP_HELD', 'This membership is held for migration review'],
    ['WORKFORCE_FACILITY_MISMATCH', 409, 'WORKFORCE_FACILITY_MISMATCH', 'The membership belongs to another facility'],
    ['WORKFORCE_FACILITY_NOT_VERIFIED', 409, 'WORKFORCE_FACILITY_NOT_VERIFIED', 'The facility is not verified and active'],
    ['WORKFORCE_ACCOUNT_INELIGIBLE', 409, 'WORKFORCE_ACCOUNT_INELIGIBLE', 'The account cannot hold staff access in its current state'],
    ['WORKFORCE_STAFF_INELIGIBLE', 409, 'WORKFORCE_STAFF_INELIGIBLE', 'The staff record is not in a state that can be attested or granted a role'],
    ['WORKFORCE_EMAIL_IN_USE', 409, 'WORKFORCE_EMAIL_IN_USE', 'An account or staff record already uses this email; attach that account instead'],
    ['WORKFORCE_MEMBERSHIP_NOT_FOUND', 404, 'WORKFORCE_MEMBERSHIP_NOT_FOUND', 'The membership was not found'],
    ['WORKFORCE_FACILITY_NOT_FOUND', 404, 'WORKFORCE_FACILITY_NOT_FOUND', 'The facility was not found'],
    ['WORKFORCE_ACCOUNT_NOT_FOUND', 404, 'WORKFORCE_ACCOUNT_NOT_FOUND', 'The account was not found'],
    ['WORKFORCE_STAFF_NOT_FOUND', 404, 'WORKFORCE_STAFF_NOT_FOUND', 'The account has no staff record'],
    ['WORKFORCE_INVALID_COMMAND', 400, 'WORKFORCE_COMMAND_INVALID', 'The workforce command is invalid'],
  ];
  for (const [marker, status, code, detail] of problems) {
    if (message.includes(marker)) return new DomainProblem(status, code, detail);
  }
  if (message.includes('NOT_FOUND') || message.includes('NOT_ACTIVE')) return new DomainProblem(404, 'ADMIN_RESOURCE_NOT_FOUND', 'The requested administration resource was not found');
  if (message.includes('ALREADY_ACTIVE') || message.includes('NO_STATE_CHANGE')) return new DomainProblem(409, 'ADMIN_STATE_CONFLICT', 'The requested state is already active');
  if (message.includes('ADMIN_INVALID') || message.includes('ADMIN_REASON_REQUIRED')) return new DomainProblem(400, 'ADMIN_COMMAND_INVALID', 'The administration command is invalid');
  return new DomainProblem(503, 'ADMIN_COMMAND_UNAVAILABLE', 'The administration command could not be completed');
}
