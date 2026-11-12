import type { Event } from '@sentry/node';
import { relativeFilename, scrubEvent } from '../src';

/** Every string below must never leave the process. */
const SENSITIVE = [
  'Adaeze Okonkwo', // fake patient name
  '12345678901', // NIN-like number
  '/api/v1/patients/8f14e45f', // concrete path
  'nin=12345678901',
  'example.invalid',
  'Bearer eyJhbGciOi.fake.token',
  'hid_session=fake-session-cookie',
  'fake-session-cookie',
  'adaeze@example.invalid',
  'user-0042',
  '203.0.113.7',
  'ip-10-0-12-34.eu-west-1.compute.internal',
  'breadcrumb-secret',
  'extra-secret',
  'context-secret',
  'patientName',
  'const nin = row.nin',
  'pre-context-line',
  'post-context-line',
  '/home/adaeze',
  'leaky-tag-value',
  'leaky_tag',
  'transaction-secret',
  'fingerprint-secret',
  'release-from-ci',
  'sdk-processing-secret',
  'mechanism-data-secret',
  'module-secret',
  'debug-meta-secret',
];

function hostileEvent(): Event {
  return {
    event_id: 'abcdef0123456789abcdef0123456789',
    timestamp: 1_790_000_000.123,
    platform: 'node',
    level: 'error',
    environment: 'production',
    release: 'release-from-ci',
    server_name: 'ip-10-0-12-34.eu-west-1.compute.internal',
    transaction: 'GET /api/v1/patients/8f14e45f transaction-secret',
    message: 'Patient Adaeze Okonkwo with NIN 12345678901',
    logentry: { message: 'Patient Adaeze Okonkwo', params: ['12345678901'] },
    fingerprint: ['fingerprint-secret'],
    modules: { 'module-secret': '1.0.0' },
    request: {
      url: 'https://example.invalid/api/v1/patients/8f14e45f?nin=12345678901',
      method: 'POST',
      query_string: 'nin=12345678901',
      headers: {
        authorization: 'Bearer eyJhbGciOi.fake.token',
        cookie: 'hid_session=fake-session-cookie',
        'x-forwarded-for': '203.0.113.7',
      },
      cookies: { hid_session: 'fake-session-cookie' },
      data: { patientName: 'Adaeze Okonkwo', nin: '12345678901' },
      env: { REMOTE_ADDR: '203.0.113.7' },
    },
    user: { id: 'user-0042', ip_address: '203.0.113.7', email: 'adaeze@example.invalid' },
    breadcrumbs: [{ message: 'breadcrumb-secret', data: { nin: '12345678901' } }],
    extra: { note: 'extra-secret', patientName: 'Adaeze Okonkwo' },
    contexts: { patient: { name: 'context-secret' }, os: { name: 'Linux' } },
    tags: {
      service: 'ehr-api',
      release_id: 'sha256:0123456789ab',
      route: '/api/v1/patients/:pid',
      leaky_tag: 'leaky-tag-value',
    },
    sdkProcessingMetadata: { normalizedRequest: { url: 'sdk-processing-secret' } },
    debug_meta: { images: [{ type: 'sourcemap', code_file: 'debug-meta-secret', debug_id: 'debug-meta-secret' }] },
    exception: {
      values: [
        {
          type: 'QueryFailedError',
          value: 'duplicate key value violates unique constraint: (nin)=(12345678901) for Adaeze Okonkwo',
          module: 'module-secret',
          mechanism: { type: 'generic', handled: true, data: { secret: 'mechanism-data-secret' } },
          stacktrace: {
            frames: [
              {
                filename: '/home/adaeze/projects/hid/services/ehr-api/dist/patients/patients.service.js',
                abs_path: '/home/adaeze/projects/hid/services/ehr-api/dist/patients/patients.service.js',
                function: 'PatientsService.create',
                module: 'patients.service',
                lineno: 42,
                colno: 13,
                in_app: true,
                pre_context: ['pre-context-line'],
                context_line: 'const nin = row.nin',
                post_context: ['post-context-line'],
                vars: { patientName: 'Adaeze Okonkwo', nin: '12345678901' },
              },
            ],
          },
        },
      ],
    },
  };
}

/** Recursively collects every key path, e.g. "exception.values[].stacktrace.frames[].lineno". */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...keyPaths(child, path)];
    });
  }
  return [];
}

describe('scrubEvent', () => {
  it('keeps only the allowlisted keys of a hostile event', () => {
    const scrubbed = scrubEvent(hostileEvent());
    expect(scrubbed).not.toBeNull();
    expect([...new Set(keyPaths(scrubbed))].sort()).toEqual([
      'environment',
      'event_id',
      'exception',
      'exception.values',
      'exception.values[].mechanism',
      'exception.values[].mechanism.handled',
      'exception.values[].mechanism.type',
      'exception.values[].stacktrace',
      'exception.values[].stacktrace.frames',
      'exception.values[].stacktrace.frames[].colno',
      'exception.values[].stacktrace.frames[].filename',
      'exception.values[].stacktrace.frames[].function',
      'exception.values[].stacktrace.frames[].in_app',
      'exception.values[].stacktrace.frames[].lineno',
      'exception.values[].stacktrace.frames[].module',
      'exception.values[].type',
      'level',
      'platform',
      'tags',
      'tags.release_id',
      'tags.route',
      'tags.service',
      'timestamp',
    ]);
  });

  it('contains none of the sensitive values', () => {
    const json = JSON.stringify(scrubEvent(hostileEvent()));
    for (const secret of SENSITIVE) expect(json).not.toContain(secret);
    expect(json).not.toMatch(/\d{11}/);
  });

  it('keeps the useful, non-sensitive values', () => {
    expect(scrubEvent(hostileEvent())).toEqual({
      event_id: 'abcdef0123456789abcdef0123456789',
      timestamp: 1_790_000_000.123,
      platform: 'node',
      level: 'error',
      environment: 'production',
      tags: { service: 'ehr-api', release_id: 'sha256:0123456789ab', route: '/api/v1/patients/:pid' },
      exception: {
        values: [
          {
            type: 'QueryFailedError',
            mechanism: { type: 'generic', handled: true },
            stacktrace: {
              frames: [
                {
                  filename: 'patients.service.js',
                  function: 'PatientsService.create',
                  module: 'patients.service',
                  lineno: 42,
                  colno: 13,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    });
  });

  it('builds a new object and never mutates the input', () => {
    const input = hostileEvent();
    const before = JSON.stringify(input);
    const output = scrubEvent(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(output).not.toBe(input);
    expect(output?.exception?.values?.[0]).not.toBe(input.exception?.values?.[0]);
  });

  it('drops message-only and empty events', () => {
    expect(scrubEvent({ message: 'Adaeze Okonkwo 12345678901' })).toBeNull();
    expect(scrubEvent({ exception: { values: [] } })).toBeNull();
    expect(scrubEvent(null)).toBeNull();
  });

  it('replaces an exception type that is not a code identifier', () => {
    const event = hostileEvent();
    event.exception!.values![0]!.type = 'Adaeze Okonkwo 12345678901';
    const json = JSON.stringify(scrubEvent(event));
    expect(json).toContain('"type":"Error"');
    expect(json).not.toContain('Adaeze');
  });
});

describe('relativeFilename', () => {
  it('makes paths relative to the working directory', () => {
    expect(relativeFilename('/app/services/ehr-api/dist/main.js', '/app/services/ehr-api')).toBe('dist/main.js');
  });
  it('keeps only the node_modules suffix of dependency paths', () => {
    expect(relativeFilename('/home/adaeze/hid/node_modules/pg/lib/client.js', '/app')).toBe('node_modules/pg/lib/client.js');
  });
  it('keeps only the base name of other absolute paths', () => {
    expect(relativeFilename('/home/adaeze/hid/x.js', '/app')).toBe('x.js');
    expect(relativeFilename('file:///home/adaeze/hid/x.mjs', '/app')).toBe('x.mjs');
  });
  it('keeps node internals and relative names', () => {
    expect(relativeFilename('node:internal/process/task_queues', '/app')).toBe('node:internal/process/task_queues');
    expect(relativeFilename('dist/main.js', '/app')).toBe('dist/main.js');
  });
});

describe('scrubEvent class names', () => {
  it('uses the thrown class name when the error did not set `name`', () => {
    class LabResultConflict extends Error {}
    const event = { exception: { values: [{ type: 'Error', value: 'Adaeze' }] } };
    expect(scrubEvent(event, { originalException: new LabResultConflict('x') })?.exception?.values?.[0]?.type)
      .toBe('LabResultConflict');
    expect(scrubEvent(event, { originalException: { constructor: { name: 'Adaeze Okonkwo' } } })?.exception?.values?.[0]?.type)
      .toBe('Error');
  });
});

describe('scrubEvent server_name', () => {
  it('never keeps server_name, whatever its value', () => {
    for (const serverName of ['ip-10-0-12-34.eu-west-1.compute.internal', 'localhost', '']) {
      const event = hostileEvent();
      event.server_name = serverName;
      const scrubbed = scrubEvent(event) as unknown as Record<string, unknown>;
      expect(scrubbed).not.toHaveProperty('server_name');
      if (serverName) expect(JSON.stringify(scrubbed)).not.toContain(serverName);
    }
  });
});
