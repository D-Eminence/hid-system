import { type CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { webPushConfiguration } from './web-push.config';

/**
 * While Identity's push is off (web-push.config.ts) every web push route
 * answers a plain 404, as an Identity before B6, and the website hides the
 * section. WebPushOffMiddleware answers it first, before the global
 * SecurityGuard; this guard is the second check, in case the controller is
 * ever mounted without WebPushModule's middleware. It runs before the
 * ValidationPipe, so a malformed body still gets 404 while push is off.
 */
@Injectable()
export class WebPushConfiguredGuard implements CanActivate {
  canActivate(): boolean {
    if (!webPushConfiguration().on) throw new NotFoundException();
    return true;
  }
}
