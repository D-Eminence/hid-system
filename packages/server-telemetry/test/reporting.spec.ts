import * as Sentry from '@sentry/node';
import {
  buildSentryOptions,
  captureServerError,
  flushErrorReporting,
  handleUnhandledRejection,
  initErrorReporting,
  isErrorReportingEnabled,
  releaseIdFromImage,
  resetErrorReportingForTests,
  resolveImageReleaseId,
} from '../src';

jest.mock('@sentry/node', () => {
  const actual = jest.requireActual('@sentry/node');
  return { ...actual, init: jest.fn(actual.init), captureException: jest.fn(actual.captureException) };
});

const FAKE_DSN = 'https://public@example.invalid/1';
const ENV_KEYS = ['SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'HID_RELEASE_ID', 'ECS_CONTAINER_METADATA_URI_V4'] as const;
const savedEnv: Record<string, string | undefined> = {};

/** In-memory transport: records envelopes, never touches the network. */
function capturingTransport() {
  const envelopes: unknown[] = [];
  const transport = () => ({
    send: async (envelope: unknown) => {
      envelopes.push(envelope);
      return {};
    },
    flush: async () => true,
  });
  return { envelopes, transport };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  jest.mocked(Sentry.init).mockClear();
  jest.mocked(Sentry.captureException).mockClear();
});

afterEach(async () => {
  await resetErrorReportingForTests();
  Sentry.getIsolationScope().setUser(null).setContext('patient', null).clearBreadcrumbs();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('initErrorReporting', () => {
  it.each([undefined, '', '   '])('returns false and never calls Sentry.init when SENTRY_DSN is %p', (dsn) => {
    if (dsn !== undefined) process.env.SENTRY_DSN = dsn;
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    expect(initErrorReporting({ service: 'ehr-api' })).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
    expect(isErrorReportingEnabled()).toBe(false);
    captureServerError(new Error('boom'), '/api/v1/patients/:pid');
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('starts Sentry with the privacy options when SENTRY_DSN is set', () => {
    process.env.SENTRY_DSN = FAKE_DSN;
    const { transport } = capturingTransport();
    expect(initErrorReporting({ service: 'ehr-api', transport })).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const options = jest.mocked(Sentry.init).mock.calls[0]![0]!;
    expect(options).toMatchObject({
      dsn: FAKE_DSN,
      environment: 'production',
      defaultIntegrations: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      sendClientReports: false,
      includeServerName: false,
      includeLocalVariables: false,
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
    });
    expect((options.integrations as Array<{ name: string }>).map((i) => i.name).sort())
      .toEqual(['OnUncaughtException']);
    expect(options.beforeBreadcrumb?.({ message: 'x' }, {})).toBeNull();
    expect(options.beforeSendTransaction?.({ type: 'transaction' }, {})).toBeNull();
    expect(Sentry.getGlobalScope().getScopeData().tags).toEqual({ service: 'ehr-api', release_id: 'unknown' });
  });

  it('uses SENTRY_ENVIRONMENT and HID_RELEASE_ID when present', () => {
    process.env.SENTRY_ENVIRONMENT = 'staging';
    process.env.HID_RELEASE_ID = 'r-2026-11-03';
    expect(buildSentryOptions(FAKE_DSN).environment).toBe('staging');
    process.env.SENTRY_DSN = FAKE_DSN;
    initErrorReporting({ service: 'lab-api', transport: capturingTransport().transport });
    expect(Sentry.getGlobalScope().getScopeData().tags.release_id).toBe('r-2026-11-03');
  });

  it('sends only the scrubbed event end to end', async () => {
    process.env.SENTRY_DSN = FAKE_DSN;
    const { envelopes, transport } = capturingTransport();
    initErrorReporting({ service: 'ehr-api', transport });
    Sentry.setUser({ id: 'user-0042', email: 'adaeze@example.invalid', ip_address: '203.0.113.7' });
    Sentry.setExtra('patientName', 'Adaeze Okonkwo');
    Sentry.setContext('patient', { nin: '12345678901' });
    Sentry.addBreadcrumb({ message: 'breadcrumb Adaeze Okonkwo' });
    Sentry.getIsolationScope().setSDKProcessingMetadata({
      normalizedRequest: { url: 'https://example.invalid/api/v1/patients/8f14e45f?nin=12345678901', headers: { cookie: 'hid_session=secret' } },
    });
    class QueryFailedError extends Error {}
    captureServerError(
      new QueryFailedError('duplicate key (nin)=(12345678901) for Adaeze Okonkwo'),
      '/api/v1/patients/:pid',
    );
    await flushErrorReporting(500);
    expect(envelopes).toHaveLength(1);
    const json = JSON.stringify(envelopes[0]);
    for (const secret of ['12345678901', 'Adaeze', 'user-0042', 'example.invalid/api', '203.0.113.7', 'hid_session', '8f14e45f']) {
      expect(json).not.toContain(secret);
    }
    const items = (envelopes[0] as [unknown, Array<[{ type: string }, Record<string, any>]>])[1];
    const [itemHeader, event] = items[0]!;
    expect(itemHeader.type).toBe('event');
    expect(event.exception.values[0].type).toBe('QueryFailedError');
    expect(event.exception.values[0].value).toBeUndefined();
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(event.tags).toEqual({ service: 'ehr-api', release_id: 'unknown', route: '/api/v1/patients/:pid' });
    expect(event.user).toBeUndefined();
    expect(event.request).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.contexts).toBeUndefined();
    expect(event.extra).toBeUndefined();
  });

  it('reports non-Error throwables as NonErrorThrown without their content', async () => {
    process.env.SENTRY_DSN = FAKE_DSN;
    const { envelopes, transport } = capturingTransport();
    initErrorReporting({ service: 'ocr-worker', transport });
    captureServerError({ patientName: 'Adaeze Okonkwo', nin: '12345678901' });
    await flushErrorReporting(500);
    const json = JSON.stringify(envelopes);
    expect(json).toContain('"type":"NonErrorThrown"');
    expect(json).not.toContain('Adaeze');
    expect(json).not.toContain('12345678901');
    expect(json).not.toContain('"route"');
  });

  it('does not leak a route tag into later events', async () => {
    process.env.SENTRY_DSN = FAKE_DSN;
    const { envelopes, transport } = capturingTransport();
    initErrorReporting({ service: 'ehr-api', transport });
    captureServerError(new Error('first'), '/api/v1/patients/:pid');
    captureServerError(new Error('second'));
    await flushErrorReporting(500);
    const tags = envelopes.map((envelope) =>
      (envelope as [unknown, Array<[unknown, { tags?: Record<string, string> }]>])[1][0]![1].tags);
    expect(tags[0]?.route).toBe('/api/v1/patients/:pid');
    expect(tags[1]).not.toHaveProperty('route');
    expect(Sentry.getCurrentScope().getScopeData().tags).not.toHaveProperty('route');
  });
});

describe('message text cannot become stack frames', () => {
  async function sentFrames(error: Error) {
    process.env.SENTRY_DSN = FAKE_DSN;
    const { envelopes, transport } = capturingTransport();
    initErrorReporting({ service: 'ehr-api', transport });
    captureServerError(error);
    await flushErrorReporting(500);
    expect(envelopes).toHaveLength(1);
    const items = (envelopes[0] as [unknown, Array<[unknown, Record<string, any>]>])[1];
    return { json: JSON.stringify(envelopes[0]), event: items[0]![1] };
  }

  it('drops hostile "at ..." lines from an error message', async () => {
    const { json, event } = await sentFrames(
      new Error('invalid input "foo\n    at Jane Doe (NHS 943 476 5919)\n    at 12 Baker Street London'));
    // '943 476 5919', not '943' alone: Sentry's own Unix timestamp (1794 3...) contains 943
    // in November 2026, which failed the check without any personal data in the event.
    for (const secret of ['Jane', 'Doe', '943 476 5919', 'Baker', 'London', 'NHS']) expect(json).not.toContain(secret);
    const frames = event.exception.values[0].stacktrace.frames as Array<Record<string, unknown>>;
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(typeof frame.lineno).toBe('number');
  });

  it('does not trust a message line that mimics a valid frame', async () => {
    const { json, event } = await sentFrames(new Error('bad value\n    at fakeFunction (fake-file.js:1:1)'));
    const frames = event.exception.values[0].stacktrace.frames as Array<Record<string, unknown>>;
    expect(json).not.toContain('fakeFunction');
    expect(json).not.toContain('fake-file');
    expect(frames.length).toBeGreaterThan(0);
  });

  it('reports an exception type that is not class-name shaped as Error', async () => {
    const error = new Error('x');
    error.name = 'jane.doe-1980';
    const { json, event } = await sentFrames(error);
    expect(event.exception.values[0].type).toBe('Error');
    expect(json).not.toContain('jane');
  });
});

describe('message lines in exact frame syntax are not sent as frames', () => {
  const FORGED = [
    'bad input\n    at Jane.Doe (jane-doe-1980.js:1:1)',
    'bad input\nat nhs9434765919 (/x/dob-1980-01-01.ts:2:2)',
    'bad input\n    at async Jane.Doe [as NHS9434765919] (a.js:1:1)',
    'bad input\n    at jane.doe@example.com/notes.js:1:1',
    'at Jane.Doe (jane-doe-1980.js:1:1)\n  at nhs9434765919 (/x/dob-1980-01-01.ts:2:2)',
  ];

  function throwPatientError(message: string): never {
    throw new Error(message);
  }

  async function framesFor(send: (error: Error) => void | Promise<void>, message: string) {
    process.env.SENTRY_DSN = FAKE_DSN;
    const { envelopes, transport } = capturingTransport();
    initErrorReporting({ service: 'ehr-api', transport });
    let thrown: Error | undefined;
    try { throwPatientError(message); } catch (error) { thrown = error as Error; }
    await send(thrown!);
    await flushErrorReporting(500);
    expect(envelopes).toHaveLength(1);
    const items = (envelopes[0] as [unknown, Array<[unknown, Record<string, any>]>])[1];
    return items[0]![1].exception.values[0].stacktrace.frames as Array<Record<string, unknown>>;
  }

  function expectClean(frames: Array<Record<string, unknown>>) {
    const json = JSON.stringify(frames).toLowerCase();
    for (const secret of ['jane', 'doe', 'nhs', '1980', 'dob', 'example.com']) expect(json).not.toContain(secret);
    // The real frames of the throwing function and its caller are still there.
    expect(frames).toContainEqual(expect.objectContaining({ function: 'throwPatientError', filename: 'test/reporting.spec.ts' }));
    expect(frames.length).toBeGreaterThan(3);
  }

  it.each(FORGED)('captureServerError: %p', async (message) => {
    expectClean(await framesFor((error) => captureServerError(error), message));
  });

  it.each(FORGED)('captureServerError with route (interceptor path): %p', async (message) => {
    expectClean(await framesFor((error) => captureServerError(error, '/api/v1/patients/:pid'), message));
  });

  it.each(FORGED)('unhandled rejection handler: %p', async (message) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expectClean(await framesFor((error) => handleUnhandledRejection(error), message));
    exit.mockRestore();
    stderr.mockRestore();
  });
});

describe('unhandled rejections', () => {
  it('reports an AbortError rejection, flushes, prints it and exits 1', async () => {
    process.env.SENTRY_DSN = FAKE_DSN;
    const { envelopes, transport } = capturingTransport();
    initErrorReporting({ service: 'ocr-worker', transport });
    expect(process.listeners('unhandledRejection')).toContain(handleUnhandledRejection);
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const abort = new DOMException('The operation was aborted', 'AbortError');
    await handleUnhandledRejection(abort);
    expect(envelopes).toHaveLength(1);
    const json = JSON.stringify(envelopes[0]);
    expect(json).toContain('"type":"auto.node.onunhandledrejection"');
    expect(json).toContain('"handled":false');
    expect(stderr).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    stderr.mockRestore();
  });

  it('is not registered when reporting is disabled', () => {
    expect(initErrorReporting({ service: 'ocr-worker' })).toBe(false);
    expect(process.listeners('unhandledRejection')).not.toContain(handleUnhandledRejection);
  });
});

describe('release_id', () => {
  it('derives a short digest from the ECS image reference', () => {
    expect(releaseIdFromImage(`123456789012.dkr.ecr.eu-west-1.amazonaws.com/hid/ehr-api@sha256:${'ab12'.repeat(16)}`))
      .toBe('sha256:ab12ab12ab12');
    expect(releaseIdFromImage('hid/ehr-api:latest')).toBeUndefined();
    expect(releaseIdFromImage(undefined)).toBeUndefined();
  });

  it('reads the container metadata endpoint and never throws', async () => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/fake';
    const image = `repo/ehr-api@sha256:${'c0ffee00'.repeat(8)}`;
    const ok = jest.fn(async () => new Response(JSON.stringify({ Image: image })));
    await expect(resolveImageReleaseId(ok as unknown as typeof fetch)).resolves.toBe('sha256:c0ffee00c0ff');
    expect(ok).toHaveBeenCalledWith('http://169.254.170.2/v4/fake', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const failing = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(resolveImageReleaseId(failing as unknown as typeof fetch)).resolves.toBeUndefined();
    const notJson = jest.fn(async () => new Response('nope'));
    await expect(resolveImageReleaseId(notJson as unknown as typeof fetch)).resolves.toBeUndefined();
  });

  it('does not fetch when the metadata endpoint is not configured', async () => {
    const spy = jest.fn();
    await expect(resolveImageReleaseId(spy as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sets the release_id tag from the image digest after init', async () => {
    process.env.SENTRY_DSN = FAKE_DSN;
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/fake';
    const image = `repo/ehr-api@sha256:${'0123456789abcdef'.repeat(4)}`;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ Image: image })));
    initErrorReporting({ service: 'ehr-api', transport: capturingTransport().transport });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(Sentry.getGlobalScope().getScopeData().tags.release_id).toBe('sha256:0123456789ab');
    fetchSpy.mockRestore();
  });
});
