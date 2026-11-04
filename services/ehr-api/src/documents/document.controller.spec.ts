import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AUDIT_ACTION, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DocumentController } from './document.controller';

// The scanner routes (0105) are authorized exactly as scan-events: public to the
// session guard, a workload JWT checked by Identity before the service runs.
describe('DocumentController: the scanner routes', () => {
  const routes = {
    recordScan: { method: RequestMethod.POST, path: 'scan-events', audit: 'ehr.document.scan-event.request', code: 202 },
    resolveScanTarget: { method: RequestMethod.POST, path: 'scan-targets/resolve',
      audit: 'ehr.document.scan-target.resolve.request', code: 200 },
    listScanTargets: { method: RequestMethod.GET, path: 'scan-targets', audit: 'ehr.document.scan-target.list.request',
      code: undefined },
  } as const;

  it.each(Object.entries(routes))('%s: route, public to the session guard, audited, no staff permission',
    (handler, expected) => {
      const method = (DocumentController.prototype as unknown as Record<string, object>)[handler] as object;
      expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(expected.path);
      expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(expected.method);
      expect(Reflect.getMetadata(PUBLIC_ROUTE, method)).toBe(true);
      expect(Reflect.getMetadata(AUDIT_ACTION, method)).toBe(expected.audit);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, method)).toBeUndefined();
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, method)).toBe(expected.code);
    });

  function controller() {
    const order: string[] = [];
    const actor = { subject: 'hid:staging:document-scanner', accountId: 'd0c5ca40-0105-4000-8000-000000000001' };
    const identity = { authorizeDocumentScanner: jest.fn(async () => { order.push('identity'); return actor; }) };
    const documents = {
      resolveScanTarget: jest.fn(async () => { order.push('resolve'); return { documentId: 'd' }; }),
      listScanTargets: jest.fn(async () => { order.push('list'); return { items: [] }; }),
    };
    const request = { header: (name: string) => (name === 'authorization' ? 'Bearer workload-jwt' : undefined),
      correlationId: 'gdmp-correlation-0001' };
    return { order, actor, identity, documents, request,
      instance: new DocumentController(documents as never, identity as never) };
  }

  it('checks the workload token with Identity before resolving', async () => {
    const { order, actor, identity, documents, request, instance } = controller();
    const input = { storageBucket: 'b', storageKey: 'k', objectVersionId: 'v' };
    await instance.resolveScanTarget(input, request as never);
    expect(identity.authorizeDocumentScanner).toHaveBeenCalledWith('Bearer workload-jwt', 'gdmp-correlation-0001');
    expect(documents.resolveScanTarget).toHaveBeenCalledWith(input, actor, 'gdmp-correlation-0001');
    expect(order).toEqual(['identity', 'resolve']);
  });

  it('checks the workload token with Identity before listing, and never lists when Identity refuses', async () => {
    const { order, identity, documents, request, instance } = controller();
    await instance.listScanTargets({ olderThanSeconds: 900, limit: 50 }, request as never);
    expect(order).toEqual(['identity', 'list']);
    identity.authorizeDocumentScanner.mockRejectedValueOnce(Object.assign(new Error('refused'), { status: 401 }));
    await expect(instance.listScanTargets({ olderThanSeconds: 0, limit: 1 }, request as never)).rejects.toThrow('refused');
    expect(documents.listScanTargets).toHaveBeenCalledTimes(1);
  });
});
