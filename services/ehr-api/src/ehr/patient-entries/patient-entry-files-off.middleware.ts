import { Injectable, type NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { patientEntryFilesEnabled } from './patient-entry-files.flag';

/**
 * While PATIENT_ENTRY_FILES_ENABLED (or PATIENT_ENTRIES_ENABLED) is off every
 * route of the files on the records patients add answers a plain 404 (code
 * NOT_FOUND), exactly as an EHR API without them does: off looks the same as
 * not built. A middleware, so the 404 comes before the security guard, the
 * audit interceptor, the ValidationPipe and the handler, as
 * PatientEntriesOffMiddleware does for the records themselves.
 */
@Injectable()
export class PatientEntryFilesOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!patientEntryFilesEnabled()) throw new NotFoundException();
    next();
  }
}
