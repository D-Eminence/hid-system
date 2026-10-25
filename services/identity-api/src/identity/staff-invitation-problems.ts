import { DomainProblem } from '../common/problem';
import { staffInvitationGateRefusal } from './staff-invitation-gate';

/**
 * The answers to facility staff management and staff invitation commands
 * (P4b, SPEC 6.4). Business refusals are raised by the database as SQLSTATE
 * P0001 (or 22023 for invalid input, 42501 for authority) with the message
 * set to the code the browser keys on; they are mapped by exact message. An
 * unknown P0001 is not an answer about the request and is 503.
 */

type Refusal = readonly [status: number, detail: string];

const REFUSALS: Readonly<Record<string, Refusal>> = Object.freeze({
  // Before and after support's review.
  FACILITY_REVIEW_PENDING: [409, 'Staff can be added once Health ID support has checked this facility'],
  FACILITY_ALREADY_REVIEWED: [409, 'Health ID support has already checked this facility'],
  STAFF_MANAGEMENT_NOT_ADMINISTRATOR: [403, 'Only the administrator who signed the facility up can record this'],
  STAFF_MANAGEMENT_NOT_AVAILABLE: [403, 'Staff management is not available at this facility'],
  // Invitations.
  IDEMPOTENCY_KEY_REUSED: [409, 'The Idempotency-Key was already used for a different invitation'],
  STAFF_INVITATION_INVALID: [400, 'The invitation is invalid'],
  STAFF_INVITATION_ROLE_NOT_ALLOWED: [400, 'This facility cannot invite that role'],
  STAFF_INVITATION_SELF: [409, 'You cannot invite yourself'],
  STAFF_INVITATION_ALREADY_MEMBER: [409, 'This person already works at the facility on Health ID'],
  STAFF_INVITATION_ALREADY_PENDING: [409, 'An invitation for this email is already waiting'],
  STAFF_INVITATION_PENDING_LIMIT: [409, 'Too many invitations are waiting at this facility'],
  STAFF_INVITATION_DAILY_LIMIT: [429, 'The facility\'s daily invitation limit has been reached'],
  STAFF_INVITATION_RECIPIENT_LIMIT: [429, 'This person has been invited too often recently'],
  STAFF_INVITATION_DELIVERY_PAUSED: [429, 'Too many invitations from this facility could not be delivered recently'],
  STAFF_INVITATION_NOT_PENDING: [409, 'This invitation is no longer waiting'],
  STAFF_INVITATION_RESEND_TOO_SOON: [409, 'Wait a minute before sending this invitation again'],
  STAFF_INVITATION_SEND_LIMIT: [409, 'This invitation has been sent as often as it can be'],
  // Members.
  ADMINISTRATOR_LICENCE_INVALID: [400, 'The licence is invalid for this facility'],
  FACILITY_STAFF_REASON_INVALID: [400, 'Enter a reason of 8 to 500 characters'],
  FACILITY_STAFF_SELF: [409, 'You cannot change your own membership'],
  FACILITY_STAFF_ADMINISTRATOR: [409, 'The facility administrator\'s membership is changed by Health ID support'],
  FACILITY_STAFF_ALREADY_ENDED: [409, 'This person no longer works at the facility'],
  FACILITY_STAFF_ROLE_UNCHANGED: [409, 'This member already has that role and licence'],
  FACILITY_STAFF_PLATFORM_ACCOUNT: [409, 'This account\'s access is managed by Health ID'],
  // Acceptance.
  STAFF_INVITATION_SESSION_INVALID: [401, 'Open the invitation again'],
  STAFF_INVITATION_EXPIRED: [410, 'This invitation has expired'],
  STAFF_INVITATION_WITHDRAWN: [410, 'This invitation was withdrawn'],
  STAFF_INVITATION_ALREADY_ACCEPTED: [409, 'This invitation was already accepted'],
  STAFF_INVITATION_ACCOUNT_EXISTS: [409, 'A Health ID account was created for this email meanwhile'],
  STAFF_INVITATION_ACCOUNT_CHANGED: [409, 'The Health ID account for this email changed; open the invitation again'],
  STAFF_INVITATION_PATIENT_ACCOUNT: [409, 'This email belongs to a Health ID patient account'],
  STAFF_INVITATION_ACCOUNT_UNAVAILABLE: [409, 'This account cannot join a facility; contact Health ID support'],
});

/** What a refused command was about, for its not-found and unknown answers. */
export type StaffCommandScope = 'staff' | 'invitation' | 'membership' | 'create' | 'public' | 'public-accept' | 'signed-in';

export function staffRefusal(code: string): DomainProblem {
  const refusal = REFUSALS[code];
  return refusal ? new DomainProblem(refusal[0], code, refusal[1]) : unavailableFor('staff');
}

export function unavailableFor(scope: StaffCommandScope): DomainProblem {
  return scope === 'public' || scope === 'public-accept' || scope === 'signed-in'
    ? new DomainProblem(503, 'STAFF_INVITATION_UNAVAILABLE', 'Staff invitations are temporarily unavailable')
    : new DomainProblem(503, 'STAFF_MANAGEMENT_UNAVAILABLE', 'Staff management is temporarily unavailable');
}

function databaseCode(error: unknown): { code?: string; message: string } {
  if (typeof error !== 'object' || error === null) return { message: '' };
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return { ...(typeof code === 'string' ? { code } : {}), message: typeof message === 'string' ? message : '' };
}

/** The answer to a database refusal of a P4b staff or invitation command. */
export function staffCommandProblem(error: unknown, scope: StaffCommandScope): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const closed = staffInvitationGateRefusal(error);
  if (closed) return closed;
  const { code, message } = databaseCode(error);
  const publicScope = scope === 'public' || scope === 'public-accept' || scope === 'signed-in';
  switch (code) {
    case 'P0001': {
      // The review gate's trigger (account_roles_review_gate) answers a
      // release that raced the command.
      if (message === 'FACILITY_RELEASED') {
        return publicScope ? staffRefusal('STAFF_INVITATION_WITHDRAWN') : staffRefusal('STAFF_MANAGEMENT_NOT_AVAILABLE');
      }
      return REFUSALS[message] ? staffRefusal(message) : unavailableFor(scope);
    }
    case '22023':
      return REFUSALS[message] && REFUSALS[message][0] === 400 ? staffRefusal(message)
        : publicScope ? unavailableFor(scope) : staffRefusal('STAFF_INVITATION_INVALID');
    case '42501':
      if (message === 'STAFF_MANAGEMENT_NOT_AVAILABLE') return staffRefusal('STAFF_MANAGEMENT_NOT_AVAILABLE');
      // A public command's 42501 is a missing context: Identity's fault.
      if (scope === 'public' || scope === 'public-accept') return unavailableFor(scope);
      return new DomainProblem(403, 'PERMISSION_DENIED', 'Staff management is not permitted');
    case 'P0002':
      if (scope === 'invitation') return new DomainProblem(404, 'STAFF_INVITATION_NOT_FOUND', 'Invitation was not found');
      if (scope === 'membership') return new DomainProblem(404, 'FACILITY_STAFF_NOT_FOUND', 'Staff member was not found');
      return unavailableFor(scope);
    case '40001':
      return new DomainProblem(409, 'VERSION_CONFLICT', 'This changed meanwhile; reload before retrying');
    case '23505':
      // The unique pending invitation per facility and email, or a new
      // account's email, lost to a concurrent command.
      if (scope === 'create') return staffRefusal('STAFF_INVITATION_ALREADY_PENDING');
      if (scope === 'public-accept') return staffRefusal('STAFF_INVITATION_ACCOUNT_EXISTS');
      return unavailableFor(scope);
    default:
      return unavailableFor(scope);
  }
}

/** The `result` of open, preview and signed-in accept (SPEC 4.7, 4.9) when it is not 'ready'. */
export function invitationResultProblem(result: string | null | undefined, scope: StaffCommandScope): DomainProblem {
  switch (result) {
    case 'invalid': return new DomainProblem(401, 'STAFF_INVITATION_CODE_INVALID', 'That invitation link or code doesn\'t match');
    case 'locked': return new DomainProblem(429, 'STAFF_INVITATION_LOCKED', 'This invitation link has been tried too often');
    case 'superseded': return new DomainProblem(410, 'STAFF_INVITATION_SUPERSEDED', 'A newer invitation was sent');
    case 'expired': return staffRefusal('STAFF_INVITATION_EXPIRED');
    case 'withdrawn': return staffRefusal('STAFF_INVITATION_WITHDRAWN');
    case 'accepted': return staffRefusal('STAFF_INVITATION_ALREADY_ACCEPTED');
    case 'email_mismatch': return new DomainProblem(409, 'STAFF_INVITATION_EMAIL_MISMATCH',
      'This invitation is for another email address');
    case 'already_member': return staffRefusal('STAFF_INVITATION_ALREADY_MEMBER');
    case 'unavailable': return staffRefusal('STAFF_INVITATION_ACCOUNT_UNAVAILABLE');
    default: return unavailableFor(scope);
  }
}

/** The pre-check's `result` (SPEC 5.5 #23b) when it is not 'ready'. */
export function acceptancePreCheckProblem(result: string | null | undefined): DomainProblem {
  switch (result) {
    case 'invalid': return staffRefusal('STAFF_INVITATION_SESSION_INVALID');
    case 'expired': return staffRefusal('STAFF_INVITATION_EXPIRED');
    case 'withdrawn': return staffRefusal('STAFF_INVITATION_WITHDRAWN');
    case 'account_exists': return staffRefusal('STAFF_INVITATION_ACCOUNT_EXISTS');
    case 'account_changed': return staffRefusal('STAFF_INVITATION_ACCOUNT_CHANGED');
    case 'patient_account': return staffRefusal('STAFF_INVITATION_PATIENT_ACCOUNT');
    case 'unavailable': return staffRefusal('STAFF_INVITATION_ACCOUNT_UNAVAILABLE');
    default: return unavailableFor('public-accept');
  }
}
