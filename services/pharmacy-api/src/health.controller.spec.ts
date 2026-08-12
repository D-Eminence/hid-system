import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('separates process liveness from dependency readiness', async () => {
    const database = { healthCheck: jest.fn().mockResolvedValue(undefined) };
    const controller = new HealthController(database as never);
    expect(controller.live()).toEqual({ status: 'ok' });
    await expect(controller.ready()).resolves.toEqual({ status: 'ready' });
    expect(database.healthCheck).toHaveBeenCalledTimes(1);
  });
});
