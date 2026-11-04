import { Injectable, type NestMiddleware, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { cardLinksEnabled } from './card-links.flag';

/**
 * While CARD_LINKS_ENABLED is off the receiver's records route answers a
 * plain 404 (code NOT_FOUND), before the guard, the interceptor and the
 * handler, as an EHR API without it does.
 */
@Injectable()
export class CardLinksOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!cardLinksEnabled()) throw new NotFoundException();
    next();
  }
}
