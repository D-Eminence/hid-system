import { type CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { patientEntriesEnabled } from './patient-entries.flag';

/**
 * The second check of PATIENT_ENTRIES_ENABLED, in case the controller is ever
 * mounted without PatientEntriesModule's middleware: a plain 404 before the
 * ValidationPipe and the handler.
 */
@Injectable()
export class PatientEntriesEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!patientEntriesEnabled()) throw new NotFoundException();
    return true;
  }
}
