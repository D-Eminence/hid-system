import { requestJson } from '@hid/api-client';

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly correlationId?: string) {
    super(message);
    this.name = 'AdminApiError';
  }
}

const cookieName = (import.meta.env.VITE_HID_AUTH_COOKIE_NAME as string | undefined) ?? 'hid_access';
let csrfToken: string | null = null;

export function rememberCsrf(value: string | null) { if (value) csrfToken = value; }

export async function api<T>(path: string, options: {
  method?: string; body?: unknown; idempotencyKey?: string; version?: number;
} = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = csrfToken ?? readCookie(`${cookieName}_csrf`);
    if (csrf) headers.set('x-csrf-token', csrf);
  }
  if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
  if (options.version) headers.set('if-match', `"${options.version}"`);
  const { response, payload } = await requestJson({ baseUrl: '', path: `/api/v1${path}`,
    method, headers, body: options.body, timeoutMs: 10_000, credentials: 'include' });
  rememberCsrf(response.headers.get('x-csrf-token'));
  if (!response.ok) {
    const problem = record(payload);
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('hid:admin-session-expired'));
    }
    throw new AdminApiError(response.status, string(problem?.code) ?? 'REQUEST_FAILED',
      safeMessage(problem?.detail, response.status), string(problem?.correlationId) ?? undefined);
  }
  return payload as T;
}

export function commandKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function readCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(';')) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return null;
}

function safeMessage(value: unknown, status: number): string {
  if (typeof value === 'string' && value.length >= 3 && value.length <= 300) return value;
  if (status === 401) return 'Sign in is required.';
  if (status === 403) return 'You do not have permission for this action.';
  if (status === 409) return 'The resource changed. Reload and try again.';
  return 'The request could not be completed.';
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown): string | null { return typeof value === 'string' ? value : null; }
