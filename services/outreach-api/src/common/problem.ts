import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { HidRequest } from './request-context';

export class DomainProblem extends HttpException {
  constructor(status: number, public readonly code: string, detail: string,
    public readonly errors?: readonly { field: string; messages: readonly string[] }[]) {
    super(detail, status);
  }
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
    const detail = status >= 500 ? 'The service could not complete the request.' : this.safeMessage(exception);
    const code = domain?.code ?? this.defaultCode(status);
    if (status >= 500) this.logger.error({ message: 'Outreach request failed',
      correlationId: request.correlationId, status, code,
      exceptionType: exception instanceof Error ? exception.constructor.name : 'UnknownException' });
    response.status(status).type('application/problem+json').json({
      type: `https://healthidentitydirectory.com/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: HttpStatus[status] ?? 'Request failed', status, detail,
      instance: `urn:hid:request:${request.correlationId ?? 'unavailable'}`,
      correlationId: request.correlationId ?? 'unavailable', code,
      ...(domain?.errors ? { errors: domain.errors } : {}),
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
