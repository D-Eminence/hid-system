import { Logger } from '@nestjs/common';
import * as environment from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { ClinicianApplicationSweeper } from './clinician-application.sweeper';

/** The clinician application sweep (ADR-064): C15 then C16, never under test, logging only the SQLSTATE. */
describe('ClinicianApplicationSweeper', () => {
  afterEach(() => jest.restoreAllMocks());

  function sweeper(nodeEnv: string, query = jest.fn().mockResolvedValue({ rows: [] })) {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NODE_ENV: nodeEnv,
      CLINICIAN_APPLICATION_SWEEP_SECONDS: 900 } as environment.Environment);
    const correlations: string[] = [];
    const database = { withSystemTransaction: jest.fn(async (correlationId: string,
      work: (client: { query: jest.Mock }) => Promise<unknown>) => {
      correlations.push(correlationId);
      return work({ query });
    }) };
    return { sweeper: new ClinicianApplicationSweeper(database as unknown as DatabaseService), query, correlations };
  }

  it('expires a batch of due applications, then prunes, in system transactions with a sweep correlation', async () => {
    const { sweeper: instance, query, correlations } = sweeper('test');
    await instance.runOnce();
    expect(query.mock.calls).toEqual([['select identity.expire_clinician_applications($1)', [50]],
      ['select identity.prune_clinician_application_artifacts()']]);
    expect(correlations).toHaveLength(2);
    expect(correlations[0]).toMatch(/^clinician-application-sweep-[0-9a-f-]{36}$/);
    expect(correlations[1]).toBe(correlations[0]);
  });

  it('does not schedule itself under NODE_ENV=test and schedules every CLINICIAN_APPLICATION_SWEEP_SECONDS otherwise', () => {
    const interval = jest.spyOn(global, 'setInterval');
    sweeper('test').sweeper.onApplicationBootstrap();
    expect(interval).not.toHaveBeenCalled();
    const { sweeper: live } = sweeper('production');
    live.onApplicationBootstrap();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 900_000);
    live.onApplicationShutdown();
  });

  it('logs only the SQLSTATE of a failure', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const failing = jest.fn().mockRejectedValue(Object.assign(new Error('row for synthetic@example.invalid'),
      { code: '40P01' }));
    await sweeper('test', failing).sweeper.runOnce();
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    expect(line).toMatch(/^Clinician application sweep failed \(code=40P01, correlation=clinician-application-sweep-/);
    expect(line).not.toContain('synthetic@example.invalid');
  });
});
