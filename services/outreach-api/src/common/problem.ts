import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { HidRequest } from './request-context';

/** Problem members an extension can never replace. */
const STANDARD_MEMBERS = new Set(['type', 'title', 'status', 'detail', 'instance', 'correlationId', 'code', 'errors']);

export interface DomainProblemOptions {
  /** Extension members (RFC 9457), e.g. `healthId` on OUTREACH_HEALTH_ID_ALREADY_CREATED (0119). */
  extensions?: Readonly<Record<string, string | number | boolean | null>>;
  /** Response headers, e.g. Retry-After. */
  headers?: Readonly<Record<string, string>>;
  /** Keep the plain-words detail on a 5xx (it is otherwise replaced by a generic one). */
  exposeDetail?: boolean;
}

export class DomainProblem extends HttpException {
  constructor(status: number, public readonly code: string, detail: string,
    public readonly errors?: readonly { field: string; messages: readonly string[] }[],
    public readonly problemOptions: DomainProblemOptions = {}) {
    super(detail, status);
  }
}

function extensionMembers(problem: DomainProblem | undefined): Record<string, unknown> {
  if (!problem?.problemOptions.extensions) return {};
  return Object.fromEntries(Object.entries(problem.problemOptions.extensions).filter(([name, value]) =>
    !STANDARD_MEMBERS.has(name) && (value === null || ['string', 'number', 'boolean'].includes(typeof value))));
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<HidRequest>();
    const response = context.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : this.parserStatus(exception) ?? 500;
    const domain = exception instanceof DomainProblem ? exception : undefined;
    const detail = status >= 500 && !domain?.problemOptions.exposeDetail
      ? 'The service could not complete the request.' : this.safeMessage(exception);
    const code = domain?.code ?? this.defaultCode(status);
    if (status >= 500) this.logger.error({ message: 'Outreach request failed',
      correlationId: request.correlationId, status, code,
      exceptionType: exception instanceof Error ? exception.constructor.name : 'UnknownException' });
    for (const [name, value] of Object.entries(domain?.problemOptions.headers ?? {})) response.setHeader(name, value);
    response.status(status).type('application/problem+json').json({
      type: `https://healthidentitydirectory.com/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: HttpStatus[status] ?? 'Request failed', status, detail,
      instance: `urn:hid:request:${request.correlationId ?? 'unavailable'}`,
      correlationId: request.correlationId ?? 'unavailable', code,
      ...(domain?.errors ? { errors: domain.errors } : {}),
      ...extensionMembers(domain),
    });
  }

  private safeMessage(exception: unknown): string {
    if (exception instanceof HttpException) {
      const value = exception.getResponse();
      if (typeof value === 'string') return value;
      if (typeof value === 'object' && value !== null && 'message' in value
          && typeof value.message === 'string') return value.message;
    }
    return 'The request could not be completed.';
  }

  private defaultCode(status: number): string {
    return ({ 400: 'BAD_REQUEST', 401: 'AUTHENTICATION_REQUIRED', 403: 'ACCESS_DENIED',
      404: 'NOT_FOUND', 409: 'CONFLICT', 412: 'VERSION_CONFLICT', 413: 'PAYLOAD_TOO_LARGE',
      415: 'UNSUPPORTED_MEDIA_TYPE', 503: 'DEPENDENCY_UNAVAILABLE' } as Record<number, string>)[status]
      ?? 'INTERNAL_ERROR';
  }

  private parserStatus(exception: unknown): number | undefined {
    if (typeof exception !== 'object' || exception === null || !('type' in exception)) return undefined;
    const type = (exception as { type?: unknown }).type;
    if (type === 'entity.too.large') return 413;
    if (type === 'entity.parse.failed') return 400;
    if (type === 'encoding.unsupported' || type === 'charset.unsupported') return 415;
    return undefined;
  }
}
