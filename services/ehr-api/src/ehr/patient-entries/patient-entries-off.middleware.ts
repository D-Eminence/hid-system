import { Injectable, type NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { patientEntriesEnabled } from './patient-entries.flag';

/**
 * While PATIENT_ENTRIES_ENABLED is off every route of the records patients
 * add answers a plain 404 (code NOT_FOUND), as an EHR API without them does,
 * which the website reads as "not served". A middleware, so the 404 comes
 * before the global RemoteSecurityGuard (no Identity call, platform control
 * read, Origin or CSRF check, and no denial audit row), the audit
 * interceptor, the ValidationPipe and the handler. AppModule's correlation
 * middleware runs first, so the problem carries the request's correlation id.
 */
@Injectable()
export class PatientEntriesOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!patientEntriesEnabled()) throw new NotFoundException();
    next();
  }
}
