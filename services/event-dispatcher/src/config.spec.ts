import { readEventDispatcherConfig } from './config';

const enabled = { NODE_ENV: 'test', EVENT_DISPATCHER_ENABLED: 'true',
  EVENT_DISPATCHER_TRANSPORT: 'deterministic',
  EVENT_DISPATCHER_DATABASE_URL: 'postgresql://dispatcher:secret@localhost:5432/hid' };

describe('event dispatcher configuration', () => {
  const trustedCa = Buffer.from(
    '-----BEGIN CERTIFICATE-----\nacceptance-ca\n-----END CERTIFICATE-----',
  ).toString('base64');
  it('requires explicit coherent enablement and transport', () => {
    expect(readEventDispatcherConfig(enabled).EVENT_DISPATCHER_BATCH_SIZE).toBe(10);
    expect(() => readEventDispatcherConfig({ ...enabled, EVENT_DISPATCHER_ENABLED: 'false' }))
      .toThrow(/Disabled dispatcher/);
    expect(() => readEventDispatcherConfig({ ...enabled, EVENT_DISPATCHER_TRANSPORT: 'disabled' }))
      .toThrow(/active transport/);
  });

  it('rejects missing dependencies and unsafe operational bounds', () => {
    expect(() => readEventDispatcherConfig({ ...enabled, EVENT_DISPATCHER_DATABASE_URL: '' }))
      .toThrow(/requires its database URL/);
    expect(() => readEventDispatcherConfig({ ...enabled, EVENT_DISPATCHER_TRANSPORT: 'eventbridge' }))
      .toThrow(/requires a bus name/);
    expect(() => readEventDispatcherConfig({ ...enabled, EVENT_DISPATCHER_BATCH_SIZE: '11' }))
      .toThrow(/Too big/);
    expect(() => readEventDispatcherConfig({ ...enabled, EVENT_DISPATCHER_LEASE_SECONDS: '4' }))
      .toThrow(/Too small/);
    expect(() => readEventDispatcherConfig({ ...enabled,
      EVENT_DISPATCHER_RETRY_BASE_MS: '5000', EVENT_DISPATCHER_RETRY_MAX_MS: '1000' }))
      .toThrow(/must not exceed/);
  });

  it('forbids deterministic transport and static AWS credentials in production', () => {
    expect(() => readEventDispatcherConfig({ ...enabled, NODE_ENV: 'production' }))
      .toThrow(/forbidden in production/);
    expect(() => readEventDispatcherConfig({ ...enabled, NODE_ENV: 'production',
      EVENT_DISPATCHER_TRANSPORT: 'eventbridge', EVENTBRIDGE_EVENT_BUS_NAME: 'hid-events',
      EVENT_DISPATCHER_DATABASE_SSL: 'true',
      EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64: trustedCa,
      AWS_ACCESS_KEY_ID: 'static', AWS_SECRET_ACCESS_KEY: 'static' })).toThrow(/workload IAM/);
  });

  it('requires production database TLS and a trusted CA', () => {
    expect(() => readEventDispatcherConfig({ ...enabled, NODE_ENV: 'production',
      EVENT_DISPATCHER_TRANSPORT: 'eventbridge', EVENTBRIDGE_EVENT_BUS_NAME: 'hid-events' }))
      .toThrow(/trusted CA/);
  });

  it('requires an explicit production EventBridge region', () => {
    expect(() => readEventDispatcherConfig({ ...enabled, NODE_ENV: 'production',
      EVENT_DISPATCHER_TRANSPORT: 'eventbridge', EVENTBRIDGE_EVENT_BUS_NAME: 'hid-events',
      EVENT_DISPATCHER_DATABASE_SSL: 'true', EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64: trustedCa }))
      .toThrow(/region must be explicit/);
    expect(readEventDispatcherConfig({ ...enabled, NODE_ENV: 'production',
      EVENT_DISPATCHER_TRANSPORT: 'eventbridge', EVENTBRIDGE_EVENT_BUS_NAME: 'hid-events',
      EVENT_DISPATCHER_DATABASE_SSL: 'true', EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64: trustedCa,
      AWS_REGION: 'eu-west-1' }).AWS_REGION).toBe('eu-west-1');
  });

  it('rejects a global production TLS verification bypass', () => {
    expect(() => readEventDispatcherConfig({ ...enabled, NODE_ENV: 'production',
      EVENT_DISPATCHER_TRANSPORT: 'eventbridge', EVENTBRIDGE_EVENT_BUS_NAME: 'hid-events',
      EVENT_DISPATCHER_DATABASE_SSL: 'true', EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64: trustedCa,
      AWS_REGION: 'eu-west-1', NODE_TLS_REJECT_UNAUTHORIZED: '0' }))
      .toThrow(/cannot be disabled globally/);
  });

  it('rejects malformed trust material and production URL TLS overrides', () => {
    expect(() => readEventDispatcherConfig({ ...enabled,
      EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64: Buffer.from('not a certificate').toString('base64') }))
      .toThrow(/base64-encoded PEM/);
    expect(() => readEventDispatcherConfig({ ...enabled, NODE_ENV: 'production',
      EVENT_DISPATCHER_TRANSPORT: 'eventbridge', EVENTBRIDGE_EVENT_BUS_NAME: 'hid-events',
      EVENT_DISPATCHER_DATABASE_SSL: 'true', EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64: trustedCa,
      EVENT_DISPATCHER_DATABASE_URL: `${enabled.EVENT_DISPATCHER_DATABASE_URL}?sslmode=no-verify` }))
      .toThrow(/must not override/);
    expect(() => readEventDispatcherConfig({ ...enabled, NODE_ENV: 'production',
      EVENT_DISPATCHER_TRANSPORT: 'eventbridge', EVENTBRIDGE_EVENT_BUS_NAME: 'hid-events',
      EVENT_DISPATCHER_DATABASE_SSL: 'true', EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64: trustedCa,
      AWS_ENDPOINT_URL: 'http://eventbridge.test.invalid' }))
      .toThrow(/must use HTTPS/);
  });
});
