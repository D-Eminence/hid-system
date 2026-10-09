import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readEventDispatcherConfig } from './config';
import { DeterministicEventTransport } from './deterministic.transport';
import { EventDispatcher } from './dispatcher';
import { EventBridgeEventTransport } from './eventbridge.transport';
import { PostgresDeliveryRepository } from './repository';
import { DispatcherStatusServer } from './status-server';

async function bootstrap(): Promise<void> {
  const config = readEventDispatcherConfig();
  if (!config.EVENT_DISPATCHER_ENABLED) {
    const status = new DispatcherStatusServer(config, null, null);
    const close = () => { void status.close(); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
    await status.start();
    process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn',
      event: 'event_dispatcher.disabled', acceptingDispatch: false }) + '\n');
    return;
  }
  const repository = new PostgresDeliveryRepository(config);
  const transport = config.EVENT_DISPATCHER_TRANSPORT === 'eventbridge'
    ? new EventBridgeEventTransport(config) : new DeterministicEventTransport();
  const generatedId = `event-dispatcher:${hostname().replace(/[^A-Za-z0-9._-]/g, '-')}:${process.pid}:${randomUUID()}`;
  const dispatcher = new EventDispatcher(config, repository, transport,
    (config.EVENT_DISPATCHER_ID ?? generatedId).slice(0, 128));
  const status = new DispatcherStatusServer(config, dispatcher, repository);
  process.once('SIGTERM', () => dispatcher.stop());
  process.once('SIGINT', () => dispatcher.stop());
  await status.start();
  try { await dispatcher.run(); } finally { await status.close(); }
}

void bootstrap().catch((error: unknown) => {
  const configuration = error instanceof Error
    && error.message.startsWith('Invalid event dispatcher configuration');
  process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error',
    event: 'event_dispatcher.startup_failed', code: configuration ? 'INVALID_CONFIGURATION' : 'STARTUP_FAILED',
    acceptingDispatch: false }) + '\n');
  process.exitCode = 1;
});
