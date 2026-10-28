import { DomainProblem } from '../common/problem';

/** The detail a suspended patient account is answered with (owner decision of 2026-10-28). */
export const ACCOUNT_SUSPENDED_DETAIL = 'This account is suspended. Contact support@healthidentitydirectory.com.';

/**
 * POST /auth/patient/login with the right password for an account that is
 * suspended, blocked or disabled (auth.accounts.status 'disabled' or 'locked',
 * or disabled_until in the future): 403 ACCOUNT_SUSPENDED. Raised only after
 * the password was verified, so a wrong password still learns nothing, and
 * never for a workforce account (any role, staff record or facility
 * membership), which keeps the uniform 401 on the patient route. The
 * account's subject is kept for the sign-in audit only; the problem response
 * carries the code and detail alone (ProblemDetailsFilter).
 */
export class AccountSuspendedProblem extends DomainProblem {
  constructor(readonly accountSubject: string) {
    super(403, 'ACCOUNT_SUSPENDED', ACCOUNT_SUSPENDED_DETAIL);
  }
}
