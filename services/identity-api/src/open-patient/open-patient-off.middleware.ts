import { Injectable, type NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { openPatientEnabled } from '../auth/open-patient';

/**
 * While STAFF_OPEN_PATIENT_ENABLED is false, POST /auth/open-patient and its
 * clear answer a plain 404, as an Identity before SX-8, where the routes do
 * not exist. A middleware, so the 404 comes before the global SecurityGuard,
 * the audit interceptor, the ValidationPipe and the handler (as
 * WebPushOffMiddleware).
 */
@Injectable()
export class OpenPatientOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!openPatientEnabled()) throw new NotFoundException();
    next();
  }
}
