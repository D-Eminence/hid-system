import type { Pool } from 'pg';
import { readConfig } from './config';
import { NotificationRepository } from './repository';

const patientId = '30000000-0000-4000-8000-000000000001';

function repositoryWith(rows: Array<{ email: string | null }>) {
  const pool = { query: jest.fn().mockResolvedValue({ rows }) };
  const config = readConfig({ NODE_ENV: 'test', NOTIFICATION_WORKER_DATABASE_URL: 'postgresql://test:test@localhost/hid' });
  return { pool, repository: new NotificationRepository(config, pool as unknown as Pool) };
}

describe('notification recipient lookup', () => {
  it('obtains a recipient only through the verified-email database function', async () => {
    const { pool, repository } = repositoryWith([{ email: 'patient@example.invalid' }]);
    await expect(repository.verifiedPatientEmail(patientId)).resolves.toBe('patient@example.invalid');
    expect(pool.query).toHaveBeenCalledWith('select notification.verified_patient_email($1) as email', [patientId]);
  });

  it('returns no recipient when the canonical account has no verified email', async () => {
    const { repository } = repositoryWith([{ email: null }]);
    await expect(repository.verifiedPatientEmail(patientId)).resolves.toBeNull();
  });
});
