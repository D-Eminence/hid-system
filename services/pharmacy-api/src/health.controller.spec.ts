import { DomainProblem } from './common/problem';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('separates process liveness from dependency readiness', async () => {
    const database = { healthCheck: jest.fn().mockResolvedValue(undefined),
      requiredSchemaPresent: jest.fn().mockResolvedValue(true) };
    const controller = new HealthController(database as never);
    expect(controller.live()).toEqual({ status: 'ok' });
    await expect(controller.ready()).resolves.toEqual({ status: 'ready' });
    expect(database.healthCheck).toHaveBeenCalledTimes(1);
    expect(database.requiredSchemaPresent).toHaveBeenCalledTimes(1);
  });

  it('ORD-12: is not ready (503) on a database without 0152\'s fill_number, while still live', async () => {
    const database = { healthCheck: jest.fn().mockResolvedValue(undefined),
      requiredSchemaPresent: jest.fn().mockResolvedValue(false) };
    const controller = new HealthController(database as never);
    expect(controller.live()).toEqual({ status: 'ok' });
    const refused = await controller.ready().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DomainProblem);
    expect((refused as DomainProblem).getStatus()).toBe(503);
    expect((refused as DomainProblem).code).toBe('PHARMACY_SCHEMA_NOT_READY');
  });
});
