import { DomainProblem } from '../common/problem';
import type { DatabaseService } from '../database/database.service';

/**
 * Facility staff invitations' gate (P4b, SPEC 6.1), P4's pattern
 * (provider-self-service-gate.ts). Invite, resend, role change, open and both
 * accepts run only while the platform control staff_invitations_enabled is
 * on, the provider portal is on and maintenance is off. List, revoke, end and
 * the administrator's own licence are not gated. The security guard does not
 * enforce platform controls on @Public routes, so every route checks here.
 *
 * Closed answers 423 STAFF_INVITATIONS_UNAVAILABLE, never a 5xx: the
 * production gateway replaces the body of every 502, 503 and 504 (CRITIC C1).
 */
export const STAFF_INVITATIONS_CONTROL = 'staff_invitations_enabled';

export function staffInvitationsClosed(): DomainProblem {
  return new DomainProblem(423, 'STAFF_INVITATIONS_UNAVAILABLE', 'Staff invitations are not open');
}

/**
 * The closed answer for a database refusal that means the control is off or
 * not deployed, else undefined:
 * - 55000 PLATFORM_CONTROL_DISABLED:staff_invitations_enabled, raised by
 *   platform.require_control_enabled inside the gated commands;
 * - 55000 PLATFORM_CONTROL_UNAVAILABLE, a control row that does not exist;
 * - 22023 PLATFORM_CONTROL_INVALID, platform.control_enabled on a key it does
 *   not know (Identity deployed before the migration).
 */
export function staffInvitationGateRefusal(error: unknown): DomainProblem | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? '');
  if (code === '55000' && (message === `PLATFORM_CONTROL_DISABLED:${STAFF_INVITATIONS_CONTROL}`
    || message === 'PLATFORM_CONTROL_UNAVAILABLE')) {
    return staffInvitationsClosed();
  }
  if (code === '22023' && message === 'PLATFORM_CONTROL_INVALID') return staffInvitationsClosed();
  return undefined;
}

interface ControlRow {
  invitations: boolean | null;
  provider_portal: boolean | null;
  maintenance: boolean | null;
}

/**
 * Throws 423 unless invitations are open. Any other fault throws
 * `unavailable` (503 STAFF_MANAGEMENT_UNAVAILABLE on staff routes, 503
 * STAFF_INVITATION_UNAVAILABLE on the public and signed-in ones).
 */
export async function assertStaffInvitationsOpen(database: Pick<DatabaseService, 'query'>,
  unavailable: () => DomainProblem): Promise<void> {
  let row: ControlRow | undefined;
  try {
    const result = await database.query<ControlRow>(
      `select platform.control_enabled('${STAFF_INVITATIONS_CONTROL}') as invitations,
              platform.control_enabled('provider_portal_enabled') as provider_portal,
              platform.control_enabled('maintenance_mode') as maintenance`);
    row = result.rows[0];
  } catch (error) {
    throw staffInvitationGateRefusal(error) ?? unavailable();
  }
  if (row?.invitations !== true || row.provider_portal !== true || row.maintenance !== false) {
    throw staffInvitationsClosed();
  }
}
