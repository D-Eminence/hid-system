import { HealthController } from './health.controller';
import { NO_AUDIT } from './common/decorators';
import type { DatabaseService } from './database/database.service';

describe('OCR health', () => {
  it('does not make health probes depend on audit persistence', () => {
    expect(Reflect.getMetadata(NO_AUDIT, HealthController)).toBe(true);
  });

  it('keeps liveness independent from databases, providers, workers, and downstream APIs', () => {
    const database = { healthCheck: jest.fn() } as unknown as DatabaseService;
    expect(new HealthController(database).live()).toEqual({ status: 'ok' });
    expect(database.healthCheck).not.toHaveBeenCalled();
  });

  it('uses only PostgreSQL for readiness', async () => {
    const database = { healthCheck: jest.fn().mockResolvedValue(undefined) } as unknown as DatabaseService;
    await expect(new HealthController(database).ready()).resolves.toEqual({ status: 'ready' });
    expect(database.healthCheck).toHaveBeenCalledTimes(1);
  });
});
