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
  /** A refusal's own facts the client needs (RFC 9457 extension members), e.g. `attemptsLeft`. */
  [extension: string]: unknown;
}

/** Problem members an extension can never replace. */
const STANDARD_MEMBERS = new Set(['type', 'title', 'status', 'detail', 'instance', 'correlationId', 'code', 'errors']);

export class DomainProblem extends HttpException {
  /**
   * `options.cause` keeps the error a problem stands for (for example the
   * database refusal a service maps) for logs and tests; it is never sent to
   * the client, and the filter logs only its SQLSTATE.
   */
  /** Extension members sent with the problem (numbers, strings, booleans and null only). */
  public readonly extensions?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    status: number,
    public readonly code: string,
    detail: string,
    public readonly errors?: ProblemDetails['errors'],
    options?: { cause?: unknown; extensions?: Readonly<Record<string, string | number | boolean | null>> },
  ) {
    super(detail, status, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.extensions) this.extensions = options.extensions;
  }
}

/** A PostgreSQL SQLSTATE: five digits or upper-case letters. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The filter maps no database error: one that reaches it is `500` with a fixed
 * detail. A command that knows what one of its own refusals means maps it to
 * its own problem (only EHR-order acceptance does, lab-work-items.service.ts),
 * so every other command keeps answering `500`, which OCR stores for its Lab
 * import as retryable.
 */
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
    const refusedBy = domainProblem ? this.databaseCause(domainProblem) : undefined;

    if (refusedBy) {
      this.logger.warn({
        message: 'Database refusal answered with a domain problem',
        sqlState: refusedBy,
        correlationId: request.correlationId,
        status,
        code,
        method: request.method,
        route: request.route?.path ?? 'unresolved',
      });
    }

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
      ...this.extensions(domainProblem),
    };

    response.status(status).type('application/problem+json').json(problem);
  }

  /** A domain problem's extension members, never one that would replace a standard member. */
  private extensions(problem: DomainProblem | undefined): Record<string, unknown> {
    if (!problem?.extensions) return {};
    return Object.fromEntries(Object.entries(problem.extensions).filter(([name, value]) => !STANDARD_MEMBERS.has(name)
      && (value === null || ['string', 'number', 'boolean'].includes(typeof value))));
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
    const byStatus: Record<number, string> = {
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
    return byStatus[status] ?? 'INTERNAL_ERROR';
  }

  /** The SQLSTATE of the database error a domain problem stands for, never its message. */
  private databaseCause(problem: DomainProblem): string | undefined {
    const cause: unknown = problem.cause;
    if (typeof cause !== 'object' || cause === null) return undefined;
    const sqlState = (cause as { code?: unknown }).code;
    return typeof sqlState === 'string' && SQLSTATE.test(sqlState) ? sqlState : undefined;
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
