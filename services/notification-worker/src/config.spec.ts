import { readConfig } from './config';

// NOVU_SUBSCRIBER_SYNC (ADR-064, migration 0095): the worker may give Novu the
// patient's verified login email only when the flag is set to `email`. It is
// off by default and refused for a production deployment, as notification-api
// refuses EMERGENCY_CONTACT_DELIVERY_ENABLED (HID_DEPLOYMENT_ENV defaults to
// production, so an unset deployment fails closed).
const local = { NODE_ENV: 'test', HID_DEPLOYMENT_ENV: 'development', NOVU_MODE: 'test' };
const stagingTask = {
  NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'staging', NOTIFICATION_WORKER_ENABLED: 'true',
  NOTIFICATION_WORKER_DATABASE_URL: 'postgresql://worker@db.example.invalid/hid',
  NOTIFICATION_WORKER_DATABASE_SSL: 'true', NOTIFICATION_WORKER_DATABASE_SSL_ROOT_CERT_BASE64: 'Y2E=',
  NOTIFICATION_WORKER_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/000000000000/hid-staging-notifications',
  NOVU_MODE: 'live', NOVU_API_KEY: 'synthetic-key', NOVU_API_URL: 'https://eu.api.novu.co',
};

describe('notification worker subscriber sync configuration', () => {
  it('is disabled by default and HID_DEPLOYMENT_ENV defaults to production', () => {
    const config = readConfig({ NODE_ENV: 'test' });
    expect(config.NOVU_SUBSCRIBER_SYNC).toBe('disabled');
    expect(config.HID_DEPLOYMENT_ENV).toBe('production');
  });

  it('refuses an unknown value', () => {
    expect(() => readConfig({ ...local, NOVU_SUBSCRIBER_SYNC: 'names' })).toThrow(/NOVU_SUBSCRIBER_SYNC/);
    expect(() => readConfig({ ...local, NOVU_SUBSCRIBER_SYNC: 'true' })).toThrow(/NOVU_SUBSCRIBER_SYNC/);
  });

  it('accepts email outside production with the test or live orchestrator', () => {
    expect(readConfig({ ...local, NOVU_SUBSCRIBER_SYNC: 'email' }).NOVU_SUBSCRIBER_SYNC).toBe('email');
    expect(readConfig({ ...local, NOVU_MODE: 'live', NOVU_API_KEY: 'synthetic-key', NOVU_SUBSCRIBER_SYNC: 'email' })
      .NOVU_SUBSCRIBER_SYNC).toBe('email');
  });

  it('refuses email without a Novu orchestrator', () => {
    expect(() => readConfig({ ...local, NOVU_MODE: 'disabled', NOVU_SUBSCRIBER_SYNC: 'email' }))
      .toThrow(/NOVU_SUBSCRIBER_SYNC: .*live Novu orchestrator/);
  });

  it('refuses email for a production deployment, including an unset deployment', () => {
    expect(() => readConfig({ ...local, HID_DEPLOYMENT_ENV: 'production', NOVU_SUBSCRIBER_SYNC: 'email' }))
      .toThrow(/NOVU_SUBSCRIBER_SYNC: .*not approved in production/);
    expect(() => readConfig({ NODE_ENV: 'test', NOVU_MODE: 'test', NOVU_SUBSCRIBER_SYNC: 'email' }))
      .toThrow(/not approved in production/);
    const { HID_DEPLOYMENT_ENV: _unset, ...unset } = stagingTask;
    expect(() => readConfig({ ...unset, NOVU_SUBSCRIBER_SYNC: 'email' })).toThrow(/not approved in production/);
    expect(() => readConfig({ ...stagingTask, HID_DEPLOYMENT_ENV: 'development', NOVU_SUBSCRIBER_SYNC: 'email' }))
      .toThrow(/not approved in production/);
  });

  it('accepts email in the staging task only with an approved Novu region origin', () => {
    expect(readConfig({ ...stagingTask, NOVU_SUBSCRIBER_SYNC: 'email' }).NOVU_SUBSCRIBER_SYNC).toBe('email');
    expect(readConfig({ ...stagingTask, NOVU_API_URL: 'https://api.novu.co', NOVU_SUBSCRIBER_SYNC: 'email' })
      .NOVU_SUBSCRIBER_SYNC).toBe('email');
    expect(() => readConfig({ ...stagingTask, NOVU_API_URL: 'https://example.test', NOVU_SUBSCRIBER_SYNC: 'email' }))
      .toThrow(/NOVU_API_URL: .*approved Novu region/);
  });

  it('leaves the disabled flag exactly as before: the staging task and an unset deployment still start', () => {
    expect(readConfig(stagingTask).NOVU_SUBSCRIBER_SYNC).toBe('disabled');
    const { HID_DEPLOYMENT_ENV: _unset, ...unset } = stagingTask;
    expect(readConfig({ ...unset, NOVU_API_URL: 'https://example.test' }).NOVU_SUBSCRIBER_SYNC).toBe('disabled');
  });
});
