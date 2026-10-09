import { setTimeout as delay } from 'node:timers/promises';
import { agentConfiguration, TokenAgent } from './agent.mjs';
// Health checks must not acquire credentials, rotate, remove, or write tokens.
if (process.argv.includes('--healthcheck')) {
  await import('./health.mjs');
} else {
const agent = new TokenAgent(agentConfiguration(process.env));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
await agent.start();
let nextRenewal = 0;
while (!stopping) {
  if (Date.now() >= nextRenewal) {
    try {
      await agent.renew();
      nextRenewal = Date.now() + 90_000;
    } catch {
      // Never log token material, credentials, response bodies, or SDK errors.
      process.stderr.write('Workload token renewal unavailable\n');
      nextRenewal = Date.now() + 10_000;
    }
  }
  await agent.purgeExpired();
  await delay(1000);
}
await agent.clear();

}
