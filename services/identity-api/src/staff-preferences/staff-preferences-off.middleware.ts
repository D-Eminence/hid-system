import { Injectable, type NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { staffPreferencesEnabled } from './staff-preferences';

/**
 * While STAFF_PREFERENCES_ENABLED is false, GET and POST
 * /identity/me/preferences and POST /identity/me/shortcuts answer a plain
 * 404, as an Identity before SX-7, where the routes do not exist. A
 * middleware, so the 404 comes before the global SecurityGuard, the audit
 * interceptor, the ValidationPipe and the handler (as OpenPatientOffMiddleware).
 */
@Injectable()
export class StaffPreferencesOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!staffPreferencesEnabled()) throw new NotFoundException();
    next();
  }
}
