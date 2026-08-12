import type { NextFunction, Request, Response } from 'express';
import { preventResponseCaching } from './response-security.middleware';

describe('preventResponseCaching', () => {
  it('sets browser, shared-cache, and legacy no-store directives on every response', () => {
    const setHeader = jest.fn();
    const next = jest.fn();
    preventResponseCaching(
      {} as Request,
      { setHeader } as unknown as Response,
      next as NextFunction,
    );
    expect(setHeader).toHaveBeenCalledWith('cache-control', 'private, no-store');
    expect(setHeader).toHaveBeenCalledWith('surrogate-control', 'no-store');
    expect(setHeader).toHaveBeenCalledWith('pragma', 'no-cache');
    expect(setHeader).toHaveBeenCalledWith('expires', '0');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
