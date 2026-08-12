import type { DataAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { AdminOperationsService } from './admin-operations.service';

const context = { correlationId: 'admin-operations-correlation' } as DataAccessContext;
const targetVariables = [
  'ADMIN_IDENTITY_STATUS_URL', 'ADMIN_EHR_STATUS_URL', 'ADMIN_LAB_STATUS_URL',
  'ADMIN_PHARMACY_STATUS_URL', 'ADMIN_OCR_STATUS_URL', 'ADMIN_OUTREACH_STATUS_URL',
  'ADMIN_EVENT_DISPATCHER_STATUS_URL',
] as const;

describe('AdminOperationsService', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      CORS_ORIGINS: 'http://localhost:3000', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      ADMIN_OPERATIONS_TIMEOUT_MS: '250',
    });
    targetVariables.forEach((name, index) => { process.env[name] = `http://service-${index}.test`; });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetEnvironmentForTests();
  });

  it('represents every service independently and preserves correlation', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-correlation-id')).toBe(context.correlationId);
      return String(url).includes('service-2')
        ? new Response('{}', { status: 503 })
        : new Response('{"status":"ready"}', { status: 200 });
    });
    const result = await new AdminOperationsService().services(context);
    expect(result.services).toHaveLength(8);
    expect(result.services.find((item) => item.service === 'Lab')).toMatchObject({ state: 'unavailable', code: 'HTTP_503' });
    expect(result.services.find((item) => item.service === 'Identity')).toMatchObject({ state: 'ready', ready: true });
    expect(result.services.find((item) => item.service === 'OCR Worker')).toMatchObject({ state: 'not_observable' });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('times out dead dependencies without hanging the aggregate', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    const pending = new AdminOperationsService().services(context);
    await jest.advanceTimersByTimeAsync(251);
    const result = await pending;
    expect(result.services.filter((item) => item.service !== 'OCR Worker')
      .every((item) => item.code === 'STATUS_TIMEOUT')).toBe(true);
    jest.useRealTimers();
  });

  it('whitelists terminal failure fields and never forwards payloads', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/metrics')
      ? new Response('hid_event_delivery_pending 2\nhid_event_delivery_terminal_failures 1\n', { status: 200 })
      : new Response(JSON.stringify({ items: [{ eventId: 'event-1', eventType: 'PatientRegistered',
        producer: 'identity', attemptCount: 8, errorCode: 'DELIVERY_TIMEOUT',
        errorSummary: 'Bounded provider timeout', failedAt: '2026-08-10T00:00:00Z',
        nextAttemptAt: '2026-08-10T00:00:00Z', correlationId: 'event-correlation',
        payload: { nin: 'must-not-pass' }, patientId: 'must-not-pass' }] }), { status: 200 }));
    const result = await new AdminOperationsService().events(context);
    expect(result.metrics).toMatchObject({ pending: 2, terminalFailures: 1 });
    expect(result.failures).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('must-not-pass');
    expect(result.failures[0]).not.toHaveProperty('payload');
  });
});
