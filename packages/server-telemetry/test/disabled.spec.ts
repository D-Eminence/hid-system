/**
 * With SENTRY_DSN unset the SDK must not even be loaded: no Sentry code runs,
 * so no handlers, hooks or network activity can exist.
 */
describe('disabled reporting', () => {
  it('never loads @sentry/node when SENTRY_DSN is unset', async () => {
    const saved = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    const factory = jest.fn(() => ({}));
    jest.doMock('@sentry/node', factory);
    const telemetry = await import('../src');
    expect(telemetry.initErrorReporting({ service: 'ehr-api' })).toBe(false);
    telemetry.captureServerError(new Error('boom'), '/api/v1/patients/:pid');
    await expect(telemetry.flushErrorReporting()).resolves.toBe(true);
    const intercepted = new telemetry.ErrorReportingInterceptor();
    expect(intercepted).toBeDefined();
    expect(factory).not.toHaveBeenCalled();
    if (saved !== undefined) process.env.SENTRY_DSN = saved;
  });
});
