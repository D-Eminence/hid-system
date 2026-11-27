import { Injectable, type NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { patientMergeRequestsEnabled } from './patient-merges';

/**
 * While PATIENT_MERGE_REQUESTS_ENABLED is false, every
 * /identity/patient-merges route answers a plain 404, as an Identity before
 * ID-8a, where the routes do not exist. A middleware, so the 404 comes before
 * the global SecurityGuard, the audit interceptor, the ValidationPipe and the
 * handler (as OpenPatientOffMiddleware).
 */
@Injectable()
export class PatientMergesOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!patientMergeRequestsEnabled()) throw new NotFoundException();
    next();
  }
}
