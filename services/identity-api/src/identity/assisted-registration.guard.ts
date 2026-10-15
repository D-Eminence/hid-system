import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PublicDetailProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

/** The one text of the facility route while ASSISTED_REGISTRATION_ENABLED is false (ADR-063). */
export const ASSISTED_REGISTRATION_DISABLED = 'Registration at a facility is not available.';

/**
 * The staff check of facility-assisted registration answers 503 while the
 * route is switched off. A route guard runs after SecurityGuard (staff
 * session with MFA, Origin and CSRF, the facility, the permission) and
 * before the request pipe, so the switch is answered before the body is read.
 * The flag is read on every request.
 */
@Injectable()
export class AssistedRegistrationEnabledGuard implements CanActivate {
  canActivate(_context?: ExecutionContext): boolean {
    if (!getEnvironment().ASSISTED_REGISTRATION_ENABLED) {
      throw new PublicDetailProblem(503, 'ASSISTED_REGISTRATION_DISABLED', ASSISTED_REGISTRATION_DISABLED);
    }
    return true;
  }
}
