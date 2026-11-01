import { type CanActivate, type ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { ssoClientForRequest, ssoConfiguration } from './sso-config';

/**
 * Keeps single sign-on dark (ADR-070). Every SSO route answers exactly as a
 * route that does not exist, the 404 Nest's own router gives
 * (`Cannot <METHOD> <url>`, RoutesResolver.registerNotFoundHandler), unless
 * single sign-on is configured and the request came through the host of one
 * of its clients. A guard throws before any interceptor runs, so a dark
 * route writes no audit row either, as an unknown route writes none. It has
 * no dependencies, so any module that declares an SSO route can build it.
 */
@Injectable()
export class SsoRouteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HidRequest>();
    const configuration = ssoConfiguration(getEnvironment());
    if (configuration && ssoClientForRequest(configuration, request)) return true;
    throw routeNotFound(request);
  }
}

/** The answer Nest gives a request no route matches. */
export function routeNotFound(request: { method: string; originalUrl?: string; url?: string }): NotFoundException {
  return new NotFoundException(`Cannot ${request.method} ${request.originalUrl ?? request.url ?? ''}`);
}
