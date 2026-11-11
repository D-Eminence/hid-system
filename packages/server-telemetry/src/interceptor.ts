import { captureServerError } from './reporting';

/*
 * NestJS interceptor, structurally typed so this package needs neither
 * @nestjs/common nor rxjs at runtime. It is assignable to Nest's
 * `NestInterceptor` (checked in the package tests against the real types).
 */

interface HttpRequestLike {
  baseUrl?: unknown;
  route?: { path?: unknown } | null;
}

export interface ExecutionContextLike {
  getType(): string;
  switchToHttp(): { getRequest(): unknown };
}

interface SubscriberLike {
  next(value: unknown): void;
  error(error: unknown): void;
  complete(): void;
}

interface SubscriptionLike {
  unsubscribe(): void;
}

export interface ObservableLike {
  subscribe(observer: Partial<SubscriberLike>): SubscriptionLike;
}

/** True for client errors (HttpException-like with status < 500) that must not be reported. */
export function isClientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const getStatus = (error as { getStatus?: unknown }).getStatus;
  if (typeof getStatus !== 'function') return false;
  try {
    const status = getStatus.call(error) as unknown;
    return typeof status === 'number' && status < 500;
  } catch {
    return false;
  }
}

/** Express route pattern (e.g. `/api/v1/patients/:pid`), never the concrete URL. */
export function routeTemplateOf(context: ExecutionContextLike): string | undefined {
  try {
    if (context.getType() !== 'http') return undefined;
    const request = context.switchToHttp().getRequest() as HttpRequestLike | undefined;
    const path = request?.route?.path;
    if (typeof path !== 'string' || path.length === 0) return undefined;
    const baseUrl = typeof request?.baseUrl === 'string' ? request.baseUrl : '';
    // baseUrl is the matched mount path of a router; Nest mounts at the root.
    return `${baseUrl}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * Reports unexpected handler errors (non-HTTP exceptions and 5xx) with the
 * route template, then rethrows the identical error so existing exception
 * filters produce exactly the same response.
 */
export class ErrorReportingInterceptor {
  intercept<T extends ObservableLike>(context: ExecutionContextLike, next: { handle(): T }): T {
    const upstream = next.handle();
    // Build the result with the caller's own Observable class (the service's
    // rxjs), so this package carries no rxjs copy of its own.
    const ObservableCtor = (upstream as unknown as {
      constructor: new (subscribe: (subscriber: SubscriberLike) => () => void) => T
    }).constructor;
    return new ObservableCtor((subscriber) => {
      const subscription = upstream.subscribe({
        next: (value) => subscriber.next(value),
        error: (error) => {
          if (!isClientError(error)) captureServerError(error, routeTemplateOf(context));
          subscriber.error(error);
        },
        complete: () => subscriber.complete(),
      });
      return () => subscription.unsubscribe();
    });
  }
}
