import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

/**
 * Refuses with 503 IMPORTED_HISTORY_SHARING_DISABLED while
 * IMPORTED_HISTORY_SHARING_ENABLED is false (the default; the production
 * profile refuses true until the P37 sign-off). The flag is read on every
 * request. ADR-066: reading the choice and turning sharing on need the
 * switch; turning sharing off never does, because a stored choice keeps
 * deciding the staff read whatever this switch says.
 */
export function requireImportedHistorySharingEnabled(): void {
  if (!getEnvironment().IMPORTED_HISTORY_SHARING_ENABLED) {
    throw new DomainProblem(503, 'IMPORTED_HISTORY_SHARING_DISABLED', 'Imported medical history sharing is not available');
  }
}

/**
 * The read of the patient's sharing choice (ADR-066) behind the switch. A
 * route guard runs after SecurityGuard (the patient session, Origin and
 * CSRF). The change route has no such guard: PatientSelfService refuses only
 * turning sharing on while the switch is off.
 */
@Injectable()
export class ImportedHistorySharingEnabledGuard implements CanActivate {
  canActivate(_context?: ExecutionContext): boolean {
    requireImportedHistorySharingEnabled();
    return true;
  }
}
