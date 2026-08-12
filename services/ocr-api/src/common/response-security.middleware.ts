import type { NextFunction, Request, Response } from 'express';

/** Prevent browsers, proxies, and legacy HTTP/1.0 caches from retaining PHI. */
export function preventResponseCaching(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('surrogate-control', 'no-store');
  response.setHeader('pragma', 'no-cache');
  response.setHeader('expires', '0');
  next();
}

