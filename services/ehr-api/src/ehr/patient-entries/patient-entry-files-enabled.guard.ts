import { type CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { patientEntryFilesEnabled } from './patient-entry-files.flag';

/**
 * The second check of PATIENT_ENTRY_FILES_ENABLED, in case the controller is
 * ever mounted without PatientEntriesModule's middleware: a plain 404 before
 * the ValidationPipe and the handler.
 */
@Injectable()
export class PatientEntryFilesEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!patientEntryFilesEnabled()) throw new NotFoundException();
    return true;
  }
}
