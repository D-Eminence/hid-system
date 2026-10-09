import type { EventDispatcherConfig } from './config';
import type { EventDispatcher } from './dispatcher';
import { dispatcherReadiness } from './status-server';
import type { DeliveryRepository } from './types';

function dependencies() {
  const repository = { checkReadiness: jest.fn().mockResolvedValue(undefined),
    metrics: jest.fn(), terminalFailures: jest.fn().mockResolvedValue([]), claim: jest.fn(), delivered: jest.fn(), failed: jest.fn(),
    close: jest.fn() } as jest.Mocked<DeliveryRepository>;
  const dispatcher = { status: jest.fn().mockReturnValue({ acceptingDispatch: true,
    startupReady: true, transport: 'eventbridge' }),
  checkTransportReadiness: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<EventDispatcher>;
  return { repository, dispatcher };
}

describe('dispatcher status server', () => {
  it('reports explicit database and transport readiness', async () => {
    const { repository, dispatcher } = dependencies();
    const config = { EVENT_DISPATCHER_ENABLED: true, EVENT_DISPATCHER_TRANSPORT: 'eventbridge',
    } as EventDispatcherConfig;
    await expect(dispatcherReadiness(config, dispatcher, repository)).resolves.toMatchObject({
      statusCode: 200, body: { status: 'ready', acceptingDispatch: true,
        dependencies: { database: 'ready', transport: { name: 'eventbridge', status: 'ready' } } },
    });
  });

  it('fails readiness without leaking dependency errors', async () => {
    const { repository, dispatcher } = dependencies();
    repository.checkReadiness.mockRejectedValue(new Error('postgres secret detail'));
    dispatcher.checkTransportReadiness.mockRejectedValue(new Error('provider secret detail'));
    const config = { EVENT_DISPATCHER_ENABLED: true, EVENT_DISPATCHER_TRANSPORT: 'eventbridge',
    } as EventDispatcherConfig;
    const readiness = await dispatcherReadiness(config, dispatcher, repository);
    expect(readiness.statusCode).toBe(503);
    const body = JSON.stringify(readiness.body);
    expect(body).toContain('"database":"unavailable"');
    expect(body).toContain('"status":"unavailable"');
    expect(body).not.toContain('secret detail');
  });
});
