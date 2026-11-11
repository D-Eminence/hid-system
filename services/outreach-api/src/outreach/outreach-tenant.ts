import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';

/**
 * The roles that exist only at an outreach group's own facility (open sign-up
 * on outreach.; the database's fence on auth.account_roles keeps them there
 * and keeps every clinical role out). Identity reports them as the
 * membership's roles.
 */
export const OUTREACH_TENANT_ROLES: ReadonlySet<string> = new Set(['outreach_organiser', 'outreach_volunteer']);

/** The longest operational note at an outreach group's facility (plan PR-1). */
export const OUTREACH_NOTES_LIMIT = 280;

/** Whether the request works at an outreach group's facility (not a hospital's). */
export function isOutreachTenant(context: DataAccessContext): boolean {
  return context.actor.facility?.roles.some((role) => OUTREACH_TENANT_ROLES.has(role)) === true;
}

export function tenantNoHealthIdLink(): DomainProblem {
  return new DomainProblem(403, 'OUTREACH_TENANT_NO_HEALTH_ID_LINK',
    'Outreach groups cannot link people to a Health ID. The person can link their own Health ID later from their account.');
}

/**
 * The outreach group rules the database enforces (plan PR-1), answered in
 * plain English. The refusal code is matched in the error's message, so any
 * SQLSTATE works. Undefined for any other error.
 */
export function outreachRuleProblem(error: unknown): DomainProblem | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const message = String((error as { message?: unknown }).message ?? '');
  const has = (code: string) => message === code || message.includes(code);
  if (has('OUTREACH_ORGANISER_AWAITING_REVIEW')) {
    return new DomainProblem(409, 'OUTREACH_ORGANISER_AWAITING_REVIEW',
      'Health ID checks every new outreach group once before its first campaign can start. '
      + 'You can keep setting up and practising. We aim to check groups the same day.');
  }
  if (has('OUTREACH_ORGANISATION_SUSPENDED')) {
    return new DomainProblem(423, 'OUTREACH_ORGANISATION_SUSPENDED',
      'This outreach group has been paused by Health ID. Contact Health ID support.');
  }
  if (has('OUTREACH_TENANT_NO_HEALTH_ID_LINK')) return tenantNoHealthIdLink();
  if (has('OUTREACH_GUARDIAN_REQUIRED')) {
    return new DomainProblem(422, 'OUTREACH_GUARDIAN_REQUIRED',
      'This person is under 18. Enter the name of the parent or guardian who agreed.');
  }
  if (has('OUTREACH_CONSENT_REQUIRED')) {
    return new DomainProblem(422, 'OUTREACH_CONSENT_REQUIRED',
      'Read the notice to the person and record how they agreed before registering them.');
  }
  if (has('OUTREACH_CAMPAIGN_REQUIRED')) {
    return new DomainProblem(422, 'OUTREACH_CAMPAIGN_REQUIRED', 'Choose the campaign this person is being registered in.');
  }
  if (has('OUTREACH_NOTES_TOO_LONG')) {
    return new DomainProblem(422, 'OUTREACH_NOTES_TOO_LONG',
      `Keep notes to ${OUTREACH_NOTES_LIMIT} characters, and do not write diagnoses.`);
  }
  return undefined;
}
