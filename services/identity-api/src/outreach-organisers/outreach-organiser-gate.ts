import { DomainProblem } from '../common/problem';
import type { DatabaseService } from '../database/database.service';

/**
 * The switch for open sign-up on outreach. (owner decision 1 of 11 Nov 2026):
 * the platform control outreach_organiser_signup_enabled, seeded OFF. A new
 * organiser can sign up, and an existing account can start an outreach group,
 * only while it is on, the Outreach portal is on and maintenance is off. The
 * security guard does not apply platform controls to @Public routes, so every
 * route checks here (provider-self-service-gate.ts's pattern).
 *
 * Closed answers 423, never a 5xx: the production gateway replaces the body of
 * every 502, 503 and 504 (CRITIC C1).
 */
export const OUTREACH_ORGANISER_SIGNUP_CONTROL = 'outreach_organiser_signup_enabled';

export function outreachSignupClosed(): DomainProblem {
  return new DomainProblem(423, 'OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE',
    'Signing up to run outreach is not open at the moment. Please try again later.');
}

export function outreachSignupUnavailable(): DomainProblem {
  return new DomainProblem(503, 'OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE',
    'Signing up to run outreach is not working right now. Please try again in a few minutes.');
}

/**
 * The closed answer for a database refusal that means the control is off or
 * not deployed yet, else undefined (55000 PLATFORM_CONTROL_DISABLED:<key>,
 * 55000 PLATFORM_CONTROL_UNAVAILABLE, 22023 PLATFORM_CONTROL_INVALID).
 */
export function outreachSignupGateRefusal(error: unknown): DomainProblem | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? '');
  if (code === '55000' && (message === `PLATFORM_CONTROL_DISABLED:${OUTREACH_ORGANISER_SIGNUP_CONTROL}`
    || message === 'PLATFORM_CONTROL_UNAVAILABLE')) {
    return outreachSignupClosed();
  }
  if (code === '22023' && message === 'PLATFORM_CONTROL_INVALID') return outreachSignupClosed();
  return undefined;
}

interface ControlRow {
  signup: boolean | null;
  outreach_portal: boolean | null;
  maintenance: boolean | null;
}

/** Throws 423 unless open sign-up is on; a fault reading the controls is 503. */
export async function assertOutreachSignupOpen(database: Pick<DatabaseService, 'query'>): Promise<void> {
  let row: ControlRow | undefined;
  try {
    const result = await database.query<ControlRow>(
      `select platform.control_enabled('${OUTREACH_ORGANISER_SIGNUP_CONTROL}') as signup,
              platform.control_enabled('outreach_portal_enabled') as outreach_portal,
              platform.control_enabled('maintenance_mode') as maintenance`);
    row = result.rows[0];
  } catch (error) {
    throw outreachSignupGateRefusal(error) ?? outreachSignupUnavailable();
  }
  if (row?.signup !== true || row.outreach_portal !== true || row.maintenance !== false) {
    throw outreachSignupClosed();
  }
}
