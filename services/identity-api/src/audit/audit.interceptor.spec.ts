jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { Logger, ServiceUnavailableException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { AUDIT_SUCCESS_BEST_EFFORT, AuditAction, AuditSuccessBestEffort } from '../common/decorators';
import { OutreachHealthIdController } from '../identity/outreach-health-id.controller';
import { AuditInterceptor } from './audit.interceptor';
import type { AuditService } from './audit.service';

// The post-success audit row: best effort only on a route marked
// AuditSuccessBestEffort (0120's create-unclaimed); required everywhere else.
class Routes {
  @AuditAction('test.best-effort.request')
  @AuditSuccessBestEffort()
  bestEffort() { return undefined; }

  @AuditAction('test.required.request')
  required() { return undefined; }
}

const answer = { healthId: 'HID-QQ7RR6', claimCode: 'K7MP2QXW', claimExpiresAt: '2027-05-13T08:00:00.000Z' };

function executionContext(handler: () => unknown): ExecutionContext {
  const request = { method: 'POST', correlationId: 'audit-interceptor-test', facilityId: 'f', route: { path: '/x' },
    actor: { subject: 'staff:v', accountId: 'a', kind: 'staff', facility: { membershipId: 'm' } },
    header: () => undefined, query: {}, params: {} };
  return {
    getHandler: () => handler, getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 201 }) }),
  } as unknown as ExecutionContext;
}

describe('AuditInterceptor post-success audit', () => {
  const audit = { record: jest.fn() };
  const interceptor = new AuditInterceptor(new Reflector(), audit as unknown as AuditService);
  const next: CallHandler = { handle: () => of(answer) };
  let logged: jest.SpyInstance;
  beforeEach(() => {
    audit.record.mockReset();
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => logged.mockRestore());

  it('answers a best-effort route although its success row fails, logging no body', async () => {
    audit.record.mockRejectedValueOnce(new ServiceUnavailableException('Audit persistence is unavailable'));
    await expect(firstValueFrom(interceptor.intercept(executionContext(Routes.prototype.bestEffort), next)))
      .resolves.toEqual(answer);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]![0]).toMatchObject({ action: 'api.test.best-effort.request', outcome: 'success' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toEqual({ event: 'audit.success-record.failed',
      action: 'api.test.best-effort.request', route: '/x', correlationId: 'audit-interceptor-test',
      exceptionType: 'ServiceUnavailableException' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(answer.claimCode);
  });

  it('writes the success row on a best-effort route as usual when it can', async () => {
    audit.record.mockResolvedValue(undefined);
    await expect(firstValueFrom(interceptor.intercept(executionContext(Routes.prototype.bestEffort), next)))
      .resolves.toEqual(answer);
    expect(logged).not.toHaveBeenCalled();
  });

  it('still refuses (503) on any other route when its success row fails', async () => {
    audit.record.mockRejectedValueOnce(new ServiceUnavailableException('Audit persistence is unavailable'))
      .mockResolvedValueOnce(undefined);
    await expect(firstValueFrom(interceptor.intercept(executionContext(Routes.prototype.required), next)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(audit.record.mock.calls.map(([event]) => event.outcome)).toEqual(['success', 'failure']);
    expect(logged).not.toHaveBeenCalled();
  });

  it('only create-unclaimed is marked among the outreach Health ID routes, and only at the method', () => {
    const reflector = new Reflector();
    expect(reflector.get(AUDIT_SUCCESS_BEST_EFFORT, OutreachHealthIdController.prototype.createUnclaimed)).toBe(true);
    expect(reflector.get(AUDIT_SUCCESS_BEST_EFFORT, OutreachHealthIdController.prototype.start)).toBeUndefined();
    expect(reflector.get(AUDIT_SUCCESS_BEST_EFFORT, OutreachHealthIdController.prototype.confirm)).toBeUndefined();
    expect(reflector.get(AUDIT_SUCCESS_BEST_EFFORT, OutreachHealthIdController)).toBeUndefined();
  });
});
