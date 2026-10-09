import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('separates process liveness from database readiness', async () => {
    const database = { healthCheck: jest.fn().mockResolvedValue(undefined) };
    const controller = new HealthController(database as never);
    expect(controller.live()).toEqual({ status: 'ok' });
    await expect(controller.ready()).resolves.toEqual({ status: 'ready' });
    expect(database.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('fails readiness when PostgreSQL is unavailable', async () => {
    const database = { healthCheck: jest.fn().mockRejectedValue(new Error('database unavailable')) };
    await expect(new HealthController(database as never).ready()).rejects.toThrow('database unavailable');
  });
});
