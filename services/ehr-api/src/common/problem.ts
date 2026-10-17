import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { HidRequest } from './request-context';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  correlationId: string;
  code: string;
  errors?: readonly { field: string; messages: readonly string[] }[];
}

export class DomainProblem extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    detail: string,
    public readonly errors?: ProblemDetails['errors'],
    /**
     * Details for the refusal's audit row only, never the response: codes and
     * identifiers, no clinical content (A17-EHR-AUDIT).
     */
    public readonly auditDetails?: Readonly<Record<string, unknown>>,
    /**
     * Whole seconds after which the client may try again, answered as the
     * Retry-After header (a 429 quota or a 503 that names when it ends).
     */
    public readonly retryAfterSeconds?: number,
  ) {
    super(detail, status);
  }
}

const DEFAULT_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'AUTHENTICATION_REQUIRED',
  403: 'ACCESS_DENIED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  412: 'VERSION_CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  503: 'DEPENDENCY_UNAVAILABLE',
};

/** The code the problem filter answers for a status without a DomainProblem code. */
export function defaultProblemCode(status: number): string {
  return DEFAULT_CODES[status] ?? 'INTERNAL_ERROR';
}

/** The status and code the problem filter answers for an exception (an unknown one is 500 INTERNAL_ERROR). */
export function problemStatusAndCode(exception: unknown): { status: number; code: string } {
  const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  return { status, code: exception instanceof DomainProblem ? exception.code : defaultProblemCode(status) };
}

/** Statuses that refuse the request rather than fail it, audited as `denied` (A17-EHR-AUDIT). */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 409, 412, 423, 429]);

/** The audit outcome of an answered status: `denied` for a refusal, `failure` otherwise. */
export function refusalOutcome(status: number): 'denied' | 'failure' {
  return REFUSAL_STATUSES.has(status) ? 'denied' : 'failure';
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<HidRequest>();
    const response = context.getResponse<Response>();
    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : this.bodyParserStatus(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const domainProblem = exception instanceof DomainProblem ? exception : undefined;
    const detail = status >= 500
      ? 'The service could not complete the request.'
      : this.safeMessage(exception);
    const code = domainProblem?.code ?? this.defaultCode(status);

    if (status >= 500) {
      this.logger.error({
        message: 'Request failed before a safe response could be produced',
        exceptionType: exception instanceof Error ? exception.constructor.name : 'UnknownException',
        correlationId: request.correlationId,
        status,
        code,
        method: request.method,
        route: request.route?.path ?? 'unresolved',
      });
    }

    const problem: ProblemDetails = {
      type: `https://healthidentitydirectory.com/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: this.title(status),
      status,
      detail,
      instance: `urn:hid:request:${request.correlationId ?? 'unavailable'}`,
      correlationId: request.correlationId ?? 'unavailable',
      code,
      ...(domainProblem?.errors ? { errors: domainProblem.errors } : {}),
    };

    const retryAfter = domainProblem?.retryAfterSeconds;
    if (retryAfter !== undefined && Number.isInteger(retryAfter) && retryAfter > 0) {
      response.setHeader('Retry-After', String(retryAfter));
    }
    response.status(status).type('application/problem+json').json(problem);
  }

  private safeMessage(exception: unknown): string {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'string') return response;
      if (typeof response === 'object' && response !== null && 'message' in response) {
        const message = response.message;
        if (typeof message === 'string') return message;
      }
    }
    return 'The request could not be completed.';
  }

  private title(status: number): string {
    return HttpStatus[status] ?? 'Request failed';
  }

  private defaultCode(status: number): string {
    return defaultProblemCode(status);
  }

  private bodyParserStatus(exception: unknown): number | undefined {
    if (typeof exception !== 'object' || exception === null || !('type' in exception)) return undefined;
    const type = (exception as { type?: unknown }).type;
    if (type === 'entity.too.large') return HttpStatus.PAYLOAD_TOO_LARGE;
    if (type === 'entity.parse.failed') return HttpStatus.BAD_REQUEST;
    if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
      return HttpStatus.UNSUPPORTED_MEDIA_TYPE;
    }
    return undefined;
  }
}
