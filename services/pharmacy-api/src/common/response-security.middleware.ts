import type { NextFunction, Response } from 'express';
import type { HidRequest } from './request-context';

export function preventResponseCaching(_request: HidRequest, response: Response, next: NextFunction): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('pragma', 'no-cache');
  response.setHeader('x-content-type-options', 'nosniff');
  next();
}
