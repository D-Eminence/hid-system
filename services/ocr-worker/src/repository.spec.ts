import type { OcrWorkerConfig } from './config';
import { PostgresWorkerRepository } from './repository';
import type { ClaimedOcrJob } from './types';

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery, on: jest.fn(), end: jest.fn(),
    connect: jest.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease }) })),
}));

const config = {
  OCR_WORKER_DATABASE_URL: 'postgresql://worker@localhost/hid', OCR_WORKER_SUBJECT: 'workload:ocr-worker',
  OCR_WORKER_DATABASE_SSL: false, OCR_WORKER_POOL_MAX: 1,
} as OcrWorkerConfig;

describe('PostgresWorkerRepository queue metrics', () => {
  beforeEach(() => mockQuery.mockReset());

  it('reads queue depth and age from the aggregate command, not from ocr.jobs', async () => {
    mockQuery.mockResolvedValue({ rows: [{ queue_depth: '7', oldest_queue_age_seconds: '7260' }] });
    const repository = new PostgresWorkerRepository(config);

    await expect(repository.metrics()).resolves.toEqual({ queueDepth: 7, oldestQueueAgeSeconds: 7260 });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = String(mockQuery.mock.calls[0]?.[0]);
    expect(sql).toMatch(/\bfrom\s+ocr\.worker_queue_metrics\(\)/);
    expect(sql).not.toMatch(/\bocr\.jobs\b/);
  });

  it('fails rather than reporting an empty queue when the command returns no row', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const repository = new PostgresWorkerRepository(config);

    await expect(repository.metrics()).rejects.toThrow('OCR queue metrics returned no row');
  });
});

describe('PostgresWorkerRepository page allowance (migration 0110)', () => {
  const job = { jobId: '00000000-0000-4000-8000-000000000001', claimToken: '00000000-0000-4000-8000-000000000002',
    correlationId: 'ocr-worker-correlation' } as ClaimedOcrJob;
  const row = { pages_used: 12, pages_limit: 500, resets_on: '2026-12-01', paused: false };
  beforeEach(() => {
    mockClientQuery.mockReset();
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (/ocr\.pause_worker_job_for_allowance/.test(sql)) return { rows: [{ resume_at: new Date('2026-11-30T23:00:00Z') }] };
      if (/ocr\.(worker_page_allowance|record_worker_pages)/.test(sql)) return { rows: [row] };
      return { rows: [] };
    });
  });

  function calls() { return mockClientQuery.mock.calls.map(([sql, params]) => [String(sql), params]); }

  it('reads the allowance inside the worker transaction with actor subject and correlation', async () => {
    const repository = new PostgresWorkerRepository(config);
    await expect(repository.pageAllowance(job)).resolves.toEqual({ pagesUsed: 12, pagesLimit: 500,
      resetsOn: '2026-12-01', paused: false });
    const [begin, setConfig, call, commit] = calls();
    expect(begin![0]).toBe('begin');
    expect(setConfig![0]).toMatch(/set_config\('app\.actor_subject'.*set_config\('app\.correlation_id'/);
    expect(setConfig![1]).toEqual(['workload:ocr-worker', 'ocr-worker-correlation']);
    expect(call![0]).toMatch(/from ocr\.worker_page_allowance\(\$1, \$2\)/);
    expect(call![1]).toEqual([job.jobId, job.claimToken]);
    expect(commit![0]).toBe('commit');
  });

  it('records pages with the correlation id and pauses until the returned time', async () => {
    const repository = new PostgresWorkerRepository(config);
    await repository.recordPages(job, 3);
    expect(calls()[2]![1]).toEqual([job.jobId, job.claimToken, 3, job.correlationId]);
    mockClientQuery.mockClear();
    await expect(repository.pauseForAllowance(job)).resolves.toEqual(new Date('2026-11-30T23:00:00Z'));
    expect(calls()[2]![0]).toMatch(/ocr\.pause_worker_job_for_allowance\(\$1, \$2, \$3\)/);
  });

  it('answers null when the pause changed nothing (allowance no longer used up or pages already counted)', async () => {
    const repository = new PostgresWorkerRepository(config);
    mockClientQuery.mockImplementation(async (sql: string) => ({ rows: /pause_worker_job_for_allowance/.test(sql)
      ? [{ resume_at: null }] : [] }));
    await expect(repository.pauseForAllowance(job)).resolves.toBeNull();
  });

  it('fails rather than guessing when the allowance command returns no row or a bad one', async () => {
    const repository = new PostgresWorkerRepository(config);
    mockClientQuery.mockImplementation(async (sql: string) => ({ rows: /allowance/.test(sql) ? [] : [] }));
    await expect(repository.pageAllowance(job)).rejects.toThrow('OCR page allowance returned no row');
    mockClientQuery.mockImplementation(async (sql: string) => ({ rows: /allowance/.test(sql)
      ? [{ ...row, paused: 'yes' }] : [] }));
    await expect(repository.pageAllowance(job)).rejects.toThrow('invalid row');
    expect(calls().some(([sql]) => sql === 'rollback')).toBe(true);
  });
});
