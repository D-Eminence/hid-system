import { DomainProblem } from '../common/problem';
import { staffCommandProblem } from './staff-invitation-problems';

/**
 * The answers to SX-4's add and remove (0139). The codes and wording are the
 * planned contract's "SX-4" errors; everything else is answered as every
 * other staff command is (staffCommandProblem, membership scope): the
 * version conflict, the member refusals, the review gate, the closed
 * staff-invitations control and the 503.
 */
type Refusal = readonly [status: number, detail: string];

const ROLE_REFUSALS: Readonly<Record<string, Refusal>> = Object.freeze({
  FACILITY_STAFF_ROLE_ALREADY_HELD: [409, 'This person already has that role'],
  FACILITY_STAFF_ROLE_NOT_HELD: [409, 'This person does not have that role'],
  FACILITY_STAFF_LAST_ROLE: [409, 'This is the person\'s only role. To stop their access, remove them from the facility'],
  IDEMPOTENCY_KEY_REUSED: [409, 'This request was already used for a different change. Please reload and try again'],
  IDEMPOTENCY_KEY_REQUIRED: [400, 'Please try again'],
  // This route's own wording for today's codes (the contract's "SX-4" errors).
  STAFF_INVITATION_INVALID: [400, 'The licence does not match the role'],
  STAFF_INVITATION_ROLE_NOT_ALLOWED: [400, 'This facility cannot invite that role'],
  FACILITY_STAFF_REASON_INVALID: [400, 'Enter a reason of 8 to 500 characters'],
});

/** The SQLSTATEs a refusal above arrives with (0139). */
const ROLE_REFUSAL_STATES = new Set(['P0001', '22023', '23505']);

export type StaffRoleCaller = 'facility' | 'support';

export function staffRoleRefusal(code: string): DomainProblem {
  const refusal = ROLE_REFUSALS[code];
  if (!refusal) throw new Error(`Unknown staff role refusal ${code}`);
  return new DomainProblem(refusal[0], code, refusal[1]);
}

/** The answer to a refused add or remove. */
export function staffRoleProblem(error: unknown, caller: StaffRoleCaller): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message ?? '') : '';
  if (typeof code === 'string' && ROLE_REFUSAL_STATES.has(code)
      && Object.prototype.hasOwnProperty.call(ROLE_REFUSALS, message)) {
    return staffRoleRefusal(message);
  }
  if (caller === 'support') {
    if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'Staff management is not permitted');
    if (code === 'P0002' && message === 'ADMIN_FACILITY_NOT_FOUND') {
      return new DomainProblem(404, 'ADMIN_FACILITY_NOT_FOUND', 'Facility was not found');
    }
  }
  return staffCommandProblem(error, 'membership');
}
