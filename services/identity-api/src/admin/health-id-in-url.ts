import { Injectable, Module, RequestMethod, type MiddlewareConsumer, type NestMiddleware, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DomainProblem } from '../common/problem';

/**
 * The code a GET answers when its URL carries the healthId parameter: the
 * same in Lab, Pharmacy and Identity (support's lookup).
 */
export const HEALTH_ID_NOT_ACCEPTED_IN_URL = 'HEALTH_ID_NOT_ACCEPTED_IN_URL';

export const HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL =
  'A Health ID is not accepted in a URL; send it in the body of POST /api/v1/admin/order-routes/search';

/** Whether a parsed query carries the healthId parameter in any form: `healthId=…`, a bare `healthId`, `healthId[]=…`. */
export function carriesHealthId(query: unknown): boolean {
  return typeof query === 'object' && query !== null
    && Object.keys(query).some((key) => key === 'healthId' || key.startsWith('healthId['));
}

/**
 * Support's GET admin/order-routes finds by reference only and refuses a
 * Health ID in its URL (CODEX §26): the request line, with its query, is
 * what access logs and browser history keep. Find by Health ID is POST
 * admin/order-routes/search, the Health ID in the body. A middleware, so the
 * refusal comes before the guard (no session or control read, no denial
 * row), the audit interceptor (no audit row), validation and the handler (no
 * database query), with a fixed detail that never repeats the value. Every
 * other unknown query key is still refused by validation.
 */
@Injectable()
export class HealthIdInUrlRefusal implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    if (carriesHealthId(request.query)) {
      throw new DomainProblem(400, HEALTH_ID_NOT_ACCEPTED_IN_URL, HEALTH_ID_NOT_ACCEPTED_IN_URL_DETAIL);
    }
    next();
  }
}

/**
 * The refusal on GET (and so HEAD) admin/order-routes only: the lookup by
 * reference, the other admin routes and the POSTs are untouched. AppModule's
 * correlation middleware runs first (Nest applies the root module's
 * middleware before an imported module's), so the problem carries the
 * request's correlation id.
 */
@Module({})
export class HealthIdInUrlRefusalModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HealthIdInUrlRefusal).forRoutes({ path: 'admin/order-routes', method: RequestMethod.GET });
  }
}
