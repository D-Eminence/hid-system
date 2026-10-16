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
  /**
   * Per-field outcomes of a comparison, each a fixed word (ADR-063:
   * match, no_match or not_in_record). Never a request or record value.
   */
  fields?: Readonly<Record<string, string>>;
}

export class DomainProblem extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    detail: string,
    public readonly errors?: ProblemDetails['errors'],
    public readonly fields?: ProblemDetails['fields'],
  ) {
    super(detail, status);
  }
}

/**
 * A problem whose detail is a fixed sentence written for the person using the
 * client, which the client may show as it is, even with a 5xx status. The
 * filter replaces every other 5xx detail, because an unexpected failure's
 * message can carry internal state. Never put a request value in it.
 */
export class PublicDetailProblem extends DomainProblem {}

/**
 * A refusal that tells the client when to retry, as the Retry-After header in
 * whole seconds (A21). The body is the same as any DomainProblem's. Give the
 * limit's full configured window, an upper bound whichever bucket refused;
 * never the time left in a bucket keyed by an identifier the caller named,
 * which would tell another person's activity on it; and never on an answer
 * that must look like another one (a spent code budget is answered as a wrong
 * code is, #55 and #61).
 */
export class RetryAfterProblem extends DomainProblem {
  readonly retryAfterSeconds: number;

  constructor(status: 429 | 503, code: string, detail: string, retryAfterSeconds: number) {
    super(status, code, detail);
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
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

/**
 * The status and code the problem filter answers for an exception (an unknown
 * one is 500 INTERNAL_ERROR), for the request's audit row (A17). Never the
 * message: only the status and the code.
 */
export function problemStatusAndCode(exception: unknown): { status: number; code: string } {
  const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  return { status, code: exception instanceof DomainProblem ? exception.code : defaultProblemCode(status) };
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
    const detail = status >= 500 && !(exception instanceof PublicDetailProblem)
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
      ...(domainProblem?.fields ? { fields: domainProblem.fields } : {}),
    };

    if (exception instanceof RetryAfterProblem) response.setHeader('Retry-After', String(exception.retryAfterSeconds));
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
