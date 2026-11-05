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

/**
 * What a few answers carry beside the problem's own keys: members of the body
 * (409 PATIENT_DOCUMENT_ALREADY_UPLOADED's document) and response headers
 * (429 PATIENT_DOCUMENT_DAILY_LIMIT's Retry-After). A member never replaces
 * one of the problem's own keys.
 */
export interface ProblemExtensions {
  members?: Readonly<Record<string, unknown>>;
  headers?: Readonly<Record<string, string>>;
}

export class DomainProblem extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    detail: string,
    public readonly errors?: ProblemDetails['errors'],
    public readonly extensions?: ProblemExtensions,
  ) {
    super(detail, status);
  }
}

const PROBLEM_KEYS = new Set(['type', 'title', 'status', 'detail', 'instance', 'correlationId', 'code', 'errors']);

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
    const members = Object.fromEntries(Object.entries(domainProblem?.extensions?.members ?? {})
      .filter(([key]) => !PROBLEM_KEYS.has(key)));
    for (const [name, value] of Object.entries(domainProblem?.extensions?.headers ?? {})) response.setHeader(name, value);

    response.status(status).type('application/problem+json').json({ ...problem, ...members });
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
