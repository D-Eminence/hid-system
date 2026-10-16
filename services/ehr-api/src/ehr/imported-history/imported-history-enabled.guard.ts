import { type CanActivate, Injectable } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import { getEnvironment } from '../../config/environment';

/**
 * The staff read of imported legacy history (ADR-067) is off unless
 * EHR_STAFF_IMPORTED_HISTORY_ENABLED is true, which the production profile
 * refuses until the P38 sign-off. It runs after the security guard, so the
 * session is authenticated and the permission checked first, and it answers
 * before Identity is asked to authorize a consent.
 */
@Injectable()
export class StaffImportedHistoryEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!getEnvironment().EHR_STAFF_IMPORTED_HISTORY_ENABLED) {
      throw new DomainProblem(503, 'IMPORTED_HISTORY_DISABLED', 'Imported medical history is not available');
    }
    return true;
  }
}
