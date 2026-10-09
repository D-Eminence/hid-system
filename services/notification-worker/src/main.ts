import { readConfig } from './config';
import { NovuOrchestrator } from './novu.orchestrator';
import { NotificationRepository } from './repository';
import { StatusServer } from './status-server';
import { NotificationWorker } from './worker';

async function main(): Promise<void> {
  const config = readConfig();
  if (!config.NOTIFICATION_WORKER_ENABLED) {
    const status = new StatusServer(config);
    await status.start();
    const shutdown = async () => { await status.close(); };
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
    process.stdout.write('notification_worker_disabled\n');
    return;
  }
  const repository = new NotificationRepository(config);
  const orchestrator = new NovuOrchestrator(config);
  const worker = new NotificationWorker(config, repository, orchestrator);
  const status = new StatusServer(config, worker, repository, orchestrator);
  await status.start();
  const shutdown = async () => {
    worker.stop();
    await Promise.all([status.close(), repository.close()]);
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  await worker.run();
}

void main().catch(() => {
  process.stderr.write('notification_worker_startup_failed\n');
  process.exitCode = 1;
});
