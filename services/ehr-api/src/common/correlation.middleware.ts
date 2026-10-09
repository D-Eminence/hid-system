import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { HidRequest } from './request-context';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: HidRequest, response: Response, next: NextFunction): void {
    const supplied = request.header('x-correlation-id');
    request.correlationId = supplied && CORRELATION_ID_PATTERN.test(supplied) ? supplied : randomUUID();
    response.setHeader('x-correlation-id', request.correlationId);
    next();
  }
}
