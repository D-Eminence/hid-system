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
  /**
   * `options.cause` keeps the error a problem stands for (for example the
   * database refusal) for logs and tests; it is never sent to the client.
   */
  constructor(
    status: number,
    public readonly code: string,
    detail: string,
    public readonly errors?: ProblemDetails['errors'],
    options?: { cause?: unknown },
  ) {
    super(detail, status, options);
  }
}

/**
 * PostgreSQL refusals with a fixed answer. A service maps a refusal whose
 * meaning it knows to its own problem; any other that reaches the filter gets
 * one of these, with a fixed detail, never the driver's message, which can name
 * rows, values and constraints. Guards raise 23514 when a command does not
 * match the state of the rows it depends on; a unique violation reaches the
 * filter only after DatabaseService has retried it once (Stage 9); 42501 is a
 * row-level security or guard refusal of the actor. Every other error is 500.
 */
const DATABASE_REFUSALS: Readonly<Record<string, { status: number; code: string; detail: string }>> = {
  '23514': { status: HttpStatus.CONFLICT, code: 'LAB_STATE_CONFLICT',
    detail: 'The Lab command does not match the current state of its records.' },
  '23505': { status: HttpStatus.CONFLICT, code: 'LAB_CONFLICT',
    detail: 'A conflicting Lab record already exists.' },
  '23503': { status: HttpStatus.CONFLICT, code: 'LAB_INVALID_REFERENCE',
    detail: 'A record the Lab command refers to is not available.' },
  '42501': { status: HttpStatus.FORBIDDEN, code: 'LAB_ACCESS_DENIED',
    detail: 'The Lab record is not accessible to this actor.' },
  ...Object.fromEntries(['22001', '22003', '22007', '22008', '22P02', '23502'].map((sqlState) => [sqlState,
    { status: HttpStatus.BAD_REQUEST, code: 'INVALID_LAB_DATA', detail: 'The Lab data failed integrity validation.' }])),
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<HidRequest>();
    const response = context.getResponse<Response>();
    const isHttpException = exception instanceof HttpException;
    const refusal = isHttpException ? undefined : this.databaseRefusal(exception);
    const status = isHttpException
      ? exception.getStatus()
      : refusal?.status ?? this.bodyParserStatus(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const domainProblem = exception instanceof DomainProblem ? exception : undefined;
    const detail = status >= 500
      ? 'The service could not complete the request.'
      : refusal?.detail ?? this.safeMessage(exception);
    const code = domainProblem?.code ?? refusal?.code ?? this.defaultCode(status);

    if (refusal) {
      this.logger.warn({
        message: 'Database refusal answered with a fixed problem',
        sqlState: refusal.sqlState,
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
    };

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

  private databaseRefusal(exception: unknown) {
    if (typeof exception !== 'object' || exception === null) return undefined;
    const sqlState = (exception as { code?: unknown }).code;
    if (typeof sqlState !== 'string' || !Object.hasOwn(DATABASE_REFUSALS, sqlState)) return undefined;
    return { sqlState, ...DATABASE_REFUSALS[sqlState]! };
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
