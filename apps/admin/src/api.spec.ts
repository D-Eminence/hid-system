import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, api } from './api';

afterEach(() => vi.restoreAllMocks());

describe('admin API transport', () => {
  it('uses same-origin credentials and no-store transport', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}',
      { status: 200, headers: { 'content-type': 'application/json' } }));
    await api('/admin/overview');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/overview', expect.objectContaining({ credentials: 'include', cache: 'no-store' }));
  });
  it('preserves version and idempotency evidence for mutations', async () => {
    document.cookie = 'hid_access_csrf=csrf-value';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await api('/admin/facilities/00000000-0000-4000-8000-000000000001/status',
      { method: 'POST', body: { status: 'suspended', reason: 'Governed reason' }, version: 3, idempotencyKey: 'facility-command:123456' });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('if-match')).toBe('"3"');
    expect(headers.get('idempotency-key')).toBe('facility-command:123456');
    expect(headers.get('x-csrf-token')).toBe('csrf-value');
  });
  it('surfaces safe Problem Details and correlation references', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'PERMISSION_DENIED',
      detail: 'Administrative permission is missing', correlationId: 'admin-test-correlation' }), { status: 403 }));
    await expect(api('/admin/overview')).rejects.toEqual(expect.objectContaining<Partial<AdminApiError>>({
      status: 403, code: 'PERMISSION_DENIED', correlationId: 'admin-test-correlation',
    }));
  });
  it('emits session expiry without exposing the rejected response', async () => {
    const expired = vi.fn();
    window.addEventListener('hid:admin-session-expired', expired, { once: true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: 'SESSION_EXPIRED', detail: 'Sign in is required.', correlationId: 'expiry-reference',
    }), { status: 401, headers: { 'content-type': 'application/problem+json' } }));
    await expect(api('/admin/overview')).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
