import type { OcrWorkerConfig } from './config';
import { PostgresWorkerRepository } from './repository';

const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery, on: jest.fn(), connect: jest.fn(), end: jest.fn() })),
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
