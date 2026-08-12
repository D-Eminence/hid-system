import type { DatabaseService } from './database/database.service';
import { HealthController } from './health.controller';
import type { StorageProvider } from './storage/storage.types';

describe('HealthController', () => {
  const database = {
    healthCheck: jest.fn<Promise<void>, []>(),
  };
  const storage = {
    checkReadiness: jest.fn<Promise<void>, []>(),
  };
  const controller = new HealthController(
    database as unknown as DatabaseService,
    storage as unknown as StorageProvider,
  );

  beforeEach(() => {
    database.healthCheck.mockReset().mockResolvedValue();
    storage.checkReadiness.mockReset().mockResolvedValue();
  });

  it('reports process liveness without probing dependencies', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(database.healthCheck).not.toHaveBeenCalled();
    expect(storage.checkReadiness).not.toHaveBeenCalled();
  });

  it('reports readiness only after all configured dependencies pass', async () => {
    await expect(controller.ready()).resolves.toEqual({ status: 'ready' });
    expect(database.healthCheck).toHaveBeenCalledTimes(1);
    expect(storage.checkReadiness).toHaveBeenCalledTimes(1);
  });

  it('fails readiness when PostgreSQL is unavailable', async () => {
    database.healthCheck.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(controller.ready()).rejects.toThrow('database unavailable');
    expect(storage.checkReadiness).not.toHaveBeenCalled();
  });

  it('fails readiness when configured object storage is unavailable', async () => {
    storage.checkReadiness.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(controller.ready()).rejects.toThrow('storage unavailable');
    expect(database.healthCheck).toHaveBeenCalledTimes(1);
  });
});
