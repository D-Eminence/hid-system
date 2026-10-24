import { DomainProblem } from '../common/problem';
import type { Environment } from '../config/environment';

/**
 * Facility self sign-up's gate (P4, adaptations A1, A6 and A13). Self sign-up
 * is open only while the database platform control
 * provider_self_service_enabled is on, the provider portal is on, maintenance
 * mode is off and PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP is valid. The
 * security guard does not enforce platform controls on @Public routes, so the
 * routes check them here.
 *
 * A closed gate answers 423, not 503: the production gateway replaces the body
 * of every 502, 503 and 504 with its own UPSTREAM_UNAVAILABLE, so a 5xx code
 * would never reach the browser (CRITIC C1). Novu already answers a disabled
 * portal 423 (SecurityGuard, PLATFORM_PORTAL_DISABLED).
 */
export const SELF_SERVICE_CONTROL = 'provider_self_service_enabled';

export function selfServiceClosed(): DomainProblem {
  return new DomainProblem(423, 'PROVIDER_ENROLLMENT_UNAVAILABLE',
    'Facility self sign-up is not open');
}

/**
 * The cap passed to platform.consume_self_service_cac_quota, or null when the
 * configured value is not an integer from 1 to 100000 (the gate is then
 * closed).
 */
export function selfServiceDailyCap(
  environment: Pick<Environment, 'PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP'>,
): number | null {
  const cap = environment.PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP;
  return typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 1 && cap <= 100_000 ? cap : null;
}

/**
 * The closed-gate answer for a database refusal that means the control is off
 * or not deployed, else undefined:
 * - 55000 PLATFORM_CONTROL_DISABLED:provider_self_service_enabled, raised by
 *   platform.require_control_enabled inside the self-service submit and
 *   activation commands;
 * - 55000 PLATFORM_CONTROL_UNAVAILABLE, a control row that does not exist;
 * - 22023 PLATFORM_CONTROL_INVALID, platform.control_enabled on a key it does
 *   not know (Identity deployed before the migration).
 */
export function selfServiceGateRefusal(error: unknown): DomainProblem | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? '');
  if (code === '55000' && (message === `PLATFORM_CONTROL_DISABLED:${SELF_SERVICE_CONTROL}`
    || message === 'PLATFORM_CONTROL_UNAVAILABLE')) {
    return selfServiceClosed();
  }
  if (code === '22023' && message === 'PLATFORM_CONTROL_INVALID') return selfServiceClosed();
  return undefined;
}
