import { Injectable, type NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { cardLinksEnabled } from './card-links.flag';

/**
 * While CARD_LINKS_ENABLED is off every card-link route, the patient's and
 * the receiver's, answers a plain 404 (code NOT_FOUND) before the
 * SecurityGuard, Turnstile, the audit interceptor, the ValidationPipe and the
 * handler, as an Identity without them does (web-push-off.middleware.ts).
 */
@Injectable()
export class CardLinksOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!cardLinksEnabled()) throw new NotFoundException();
    next();
  }
}
