// Bootstrap order (ADR-064): the runtime-role guard runs first, as on main
// (main.ts, DB-LOGIN-VERIFY). With NOVU_SUBSCRIBER_SYNC=email the worker then
// proves it may execute the claim-bound recipient lookup of 0095, so a task
// that lands before the migration or its grants fails its rollout instead of
// handling events without it.
type Calls = string[];

async function boot(sync: 'disabled' | 'email', privilege: 'granted' | 'missing' = 'granted') {
  const calls: Calls = [];
  const stderr: string[] = [];
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
  jest.spyOn(process, 'once').mockImplementation(() => process);
  await jest.isolateModulesAsync(async () => {
    jest.doMock('./config', () => ({
      readConfig: () => ({ NOTIFICATION_WORKER_ENABLED: true, NOVU_SUBSCRIBER_SYNC: sync }),
    }));
    jest.doMock('./repository', () => ({
      NotificationRepository: jest.fn().mockImplementation(() => ({
        verifyRuntimeRole: jest.fn(async () => { calls.push('verifyRuntimeRole'); }),
        verifySubscriberSyncPrivilege: jest.fn(async () => {
          calls.push('verifySubscriberSyncPrivilege');
          if (privilege === 'missing') throw new Error('NOTIFICATION_RECIPIENT_LOOKUP_NOT_EXECUTABLE');
        }),
        close: jest.fn(),
      })),
    }));
    jest.doMock('./novu.orchestrator', () => ({ NovuOrchestrator: jest.fn().mockImplementation(() => ({})) }));
    jest.doMock('./status-server', () => ({
      StatusServer: jest.fn().mockImplementation(() => ({ start: jest.fn(async () => { calls.push('statusStart'); }), close: jest.fn() })),
    }));
    jest.doMock('./worker', () => ({
      NotificationWorker: jest.fn().mockImplementation(() => ({ run: jest.fn(async () => { calls.push('run'); }), stop: jest.fn() })),
    }));
    require('./main');
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  });
  return { calls, stderr };
}

describe('notification worker bootstrap', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.resetModules(); process.exitCode = undefined; });

  it('with the flag off runs the runtime-role guard only, as main does', async () => {
    const { calls } = await boot('disabled');
    expect(calls).toEqual(['verifyRuntimeRole', 'statusStart', 'run']);
  });

  it('with the flag email checks the lookup privilege after the runtime-role guard and before serving', async () => {
    const { calls } = await boot('email');
    expect(calls).toEqual(['verifyRuntimeRole', 'verifySubscriberSyncPrivilege', 'statusStart', 'run']);
  });

  it('refuses to start when the lookup is missing or not executable', async () => {
    const { calls, stderr } = await boot('email', 'missing');
    expect(calls).toEqual(['verifyRuntimeRole', 'verifySubscriberSyncPrivilege']);
    expect(stderr).toEqual(['notification_worker_startup_failed\n']);
    expect(process.exitCode).toBe(1);
  });
});
