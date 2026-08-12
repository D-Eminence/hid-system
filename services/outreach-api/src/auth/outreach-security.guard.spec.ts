import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { OutreachSecurityGuard } from './outreach-security.guard';

describe('OutreachSecurityGuard', () => {
  function execution(headers: Record<string, string | undefined>): ExecutionContext {
    const request = { correlationId: 'correlation-12345678',
      header: jest.fn((name: string) => headers[name.toLowerCase()]) };
    return { getHandler: () => null, getClass: () => null,
      switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  }

  it('requires Identity user authentication independently of workload credentials', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValueOnce(false)
      .mockReturnValueOnce(['outreach.registration.read']) } as unknown as Reflector;
    const workload = { headers: jest.fn() };
    await expect(new OutreachSecurityGuard(reflector, workload as never).canActivate(execution({
      'x-facility-id': '123e4567-e89b-42d3-a456-426614174001',
    }))).rejects.toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(workload.headers).not.toHaveBeenCalled();
  });

  it('requires origin and CSRF evidence for cookie-authenticated writes and reads', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValueOnce(false)
      .mockReturnValueOnce(['outreach.registration.write']) } as unknown as Reflector;
    await expect(new OutreachSecurityGuard(reflector, { headers: jest.fn() } as never)
      .canActivate(execution({
        'x-facility-id': '123e4567-e89b-42d3-a456-426614174001', cookie: 'hid_session=opaque',
      }))).rejects.toMatchObject({ status: 403, code: 'CSRF_VALIDATION_FAILED' });
  });
});
