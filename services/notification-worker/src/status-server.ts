import { createServer, type Server } from 'node:http';
import type { NotificationWorkerConfig } from './config';
import type { NotificationOrchestrator } from './novu.orchestrator';
import type { NotificationRepository } from './repository';
import type { NotificationWorker } from './worker';

export class StatusServer {
  private server?: Server;
  constructor(private readonly config: NotificationWorkerConfig, private readonly worker?: NotificationWorker,
    private readonly repository?: NotificationRepository, private readonly orchestrator?: NotificationOrchestrator) {}

  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', 'application/json; charset=utf-8');
      if (request.method !== 'GET') { response.statusCode = 405; response.end('{"code":"METHOD_NOT_ALLOWED"}'); return; }
      if (request.url === '/api/v1/health/live') {
        response.statusCode = 200; response.end(JSON.stringify({ status: 'live', enabled: this.config.NOTIFICATION_WORKER_ENABLED })); return;
      }
      if (request.url === '/api/v1/health/ready') {
        let ready = Boolean(this.worker?.status().startupReady && !this.worker.status().stopping);
        await Promise.all([
          this.repository?.readiness().catch(() => { ready = false; }),
          this.orchestrator?.readiness().catch(() => { ready = false; }),
        ]);
        response.statusCode = ready ? 200 : 503;
        response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', enabled: this.config.NOTIFICATION_WORKER_ENABLED })); return;
      }
      response.statusCode = 404; response.end('{"code":"NOT_FOUND"}');
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.config.NOTIFICATION_WORKER_STATUS_PORT, this.config.NOTIFICATION_WORKER_STATUS_HOST, resolve);
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
  }
}
