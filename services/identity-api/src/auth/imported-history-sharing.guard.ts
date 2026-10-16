import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

/**
 * The patient's imported history sharing routes (ADR-065) answer 503 while
 * IMPORTED_HISTORY_SHARING_ENABLED is false (the default; the production
 * profile refuses true until the P36 sign-off). A route guard runs after
 * SecurityGuard (the patient session, Origin and CSRF) and before the request
 * pipe, so the switch is answered before the body is read. The flag is read
 * on every request.
 */
@Injectable()
export class ImportedHistorySharingEnabledGuard implements CanActivate {
  canActivate(_context?: ExecutionContext): boolean {
    if (!getEnvironment().IMPORTED_HISTORY_SHARING_ENABLED) {
      throw new DomainProblem(503, 'IMPORTED_HISTORY_SHARING_DISABLED', 'Imported medical history sharing is not available');
    }
    return true;
  }
}
