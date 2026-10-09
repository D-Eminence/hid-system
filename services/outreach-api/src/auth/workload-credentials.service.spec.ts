jest.mock('node:fs/promises', () => ({ readFile: jest.fn(), stat: jest.fn() }));

import { readFile, stat } from 'node:fs/promises';
import { resetEnvironmentForTests } from '../config/environment';
import { WorkloadCredentialsService } from './workload-credentials.service';

describe('WorkloadCredentialsService', () => {
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      DATABASE_SSL: 'false', CORS_ORIGINS: 'http://localhost:3000',
      OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
      OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE: '/run/secrets/outreach-token' });
    resetEnvironmentForTests();
    jest.mocked(readFile).mockReset();
    jest.mocked(stat).mockReset();
  });

  it('normalizes a bounded token file to one Bearer authorization header', async () => {
    jest.mocked(stat).mockResolvedValue({ isFile: () => true, size: 40 } as never);
    jest.mocked(readFile).mockResolvedValue('Bearer signed-outreach-workload-token-1234\n');
    await expect(new WorkloadCredentialsService().headers()).resolves.toEqual({
      'x-hid-service-authorization': 'Bearer signed-outreach-workload-token-1234',
    });
  });

  it('rejects an oversized token source before reading it', async () => {
    jest.mocked(stat).mockResolvedValue({ isFile: () => true, size: 16_385 } as never);
    await expect(new WorkloadCredentialsService().headers())
      .rejects.toMatchObject({ status: 503, code: 'WORKLOAD_IDENTITY_UNAVAILABLE' });
    expect(readFile).not.toHaveBeenCalled();
  });
});
