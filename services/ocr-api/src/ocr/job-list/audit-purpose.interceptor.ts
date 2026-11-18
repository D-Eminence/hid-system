import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { HidRequest, PurposeOfUse } from '../../common/request-context';

/**
 * For a route whose handler always reads under one purpose
 * (requireRequestContext(request, purpose)). The global AuditInterceptor
 * writes the request-level row with the purpose it finds in ?purpose or
 * X-Purpose-Of-Use, which is what the browser sent; this route-level
 * interceptor runs before the handler and before validation, and sets both
 * to the route's own purpose, so the success or failure row records the
 * purpose the read was made under. A ?purpose key keeps its place (only its
 * value changes), so validation still refuses it as an unknown key. Used as
 * an instance: @UseInterceptors(new AuditPurposeInterceptor(purpose)).
 */
export class AuditPurposeInterceptor implements NestInterceptor {
  constructor(private readonly purpose: PurposeOfUse) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<HidRequest>();
    request.headers['x-purpose-of-use'] = this.purpose;
    const query = request.query as Record<string, unknown> | undefined;
    if (query && Object.prototype.hasOwnProperty.call(query, 'purpose')) {
      // Express 5 parses request.query on each read; keep this copy instead.
      Object.defineProperty(request, 'query', { value: { ...query, purpose: this.purpose }, configurable: true,
        enumerable: true, writable: true });
    }
    return next.handle();
  }
}
