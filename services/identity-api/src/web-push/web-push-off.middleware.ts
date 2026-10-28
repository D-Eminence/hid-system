import { Injectable, type NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { webPushConfiguration } from './web-push.config';

/**
 * While Identity's push is off (web-push.config.ts) every web push route
 * answers a plain 404, as an Identity before B6, where the routes do not
 * exist. A middleware, so the 404 comes before the global SecurityGuard (no
 * token verification, platform control read, Origin or CSRF check, and no
 * denial audit row), the audit interceptor, the ValidationPipe and the
 * handler. AppModule's correlation middleware runs first (Nest applies the
 * root module's middleware before an imported module's), so the problem
 * carries the request's correlation id.
 */
@Injectable()
export class WebPushOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!webPushConfiguration().on) throw new NotFoundException();
    next();
  }
}
