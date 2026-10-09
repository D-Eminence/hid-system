import type { DatabaseService } from './database/database.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const database = {
    healthCheck: jest.fn<Promise<void>, []>(),
  };
  const controller = new HealthController(database as unknown as DatabaseService);

  beforeEach(() => {
    database.healthCheck.mockReset().mockResolvedValue();
  });

  it('reports process liveness without probing dependencies', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(database.healthCheck).not.toHaveBeenCalled();
  });

  it('reports readiness only after PostgreSQL passes', async () => {
    await expect(controller.ready()).resolves.toEqual({ status: 'ready' });
    expect(database.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('fails readiness when PostgreSQL is unavailable', async () => {
    database.healthCheck.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(controller.ready()).rejects.toThrow('database unavailable');
  });
});
