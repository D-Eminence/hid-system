import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import type { OcrWorkerConfig } from './config';
import type { PaperReadingService } from './reading/reader';
import { S3SourceObjectEraser, SourceDeletionError, SourceDeletionSweeper, type SourceClaimResult,
  type SourcePurgeResult, type SourceDeletionCandidate,
  type SourceDeletionRepository, type SourceObjectEraser } from './source-deletion';
import type { DocumentReader, WorkerOcrProvider, WorkerRepository } from './types';
import { OcrWorker } from './worker';

const config = { AWS_REGION: 'eu-west-1', S3_FORCE_PATH_STYLE: false, OCR_WORKER_API_TIMEOUT_MS: 30_000 } as OcrWorkerConfig;
const KEY = 'clinical/objects/0c9e8a7b-6d5c-4b3a-9f8e-7d6c5b4a3f2e';
// Fictional text that must never reach a log line.
const SECRET = 'Test Patient Ifeoma Fictional-Example';

type Sent = { name: string; input: Record<string, unknown> };

function s3(pages: readonly unknown[][], options: { deleteError?: Error; listError?: Error } = {}) {
  const client = new S3Client({ region: 'eu-west-1' });
  const sent: Sent[] = [];
  // Each listing (a call without KeyMarker starts the next one; the last one repeats) is a list of pages; KeyMarker
  // is the page's index.
  let listing = -1;
  jest.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
    if (command instanceof ListObjectVersionsCommand) {
      sent.push({ name: 'ListObjectVersions', input: { ...command.input } });
      if (options.listError) throw options.listError;
      if (command.input.KeyMarker === undefined) listing += 1;
      return pages[Math.min(listing, pages.length - 1)]![Number(command.input.KeyMarker ?? 0)];
    }
    if (command instanceof DeleteObjectCommand) {
      sent.push({ name: 'DeleteObject', input: { ...command.input } });
      if (options.deleteError) throw options.deleteError;
      return {};
    }
    throw new Error('unexpected command');
  }) as never);
  return { client, sent };
}

describe('S3SourceObjectEraser', () => {
  it('deletes every version and delete marker of exactly the stored key, never a key that only shares its prefix', async () => {
    const { client, sent } = s3([
      [{ IsTruncated: false,
        Versions: [{ Key: KEY, VersionId: 'v1' }, { Key: `${KEY}-copy`, VersionId: 'other-1' }, { Key: KEY, VersionId: 'v2' }],
        DeleteMarkers: [{ Key: KEY, VersionId: 'marker-1' }, { Key: `${KEY}/child`, VersionId: 'other-2' }] }],
      [{ IsTruncated: false, Versions: [{ Key: `${KEY}-copy`, VersionId: 'other-1' }],
        DeleteMarkers: [{ Key: `${KEY}/child`, VersionId: 'other-2' }] }],
    ]);
    await expect(new S3SourceObjectEraser(config, client).eraseAllVersions('synthetic-bucket', KEY,
      new AbortController().signal)).resolves.toBe(3);
    expect(sent.filter((call) => call.name === 'ListObjectVersions').map((call) => call.input))
      .toEqual([{ Bucket: 'synthetic-bucket', Prefix: KEY }, { Bucket: 'synthetic-bucket', Prefix: KEY }]);
    expect(sent.filter((call) => call.name === 'DeleteObject').map((call) => call.input)).toEqual([
      { Bucket: 'synthetic-bucket', Key: KEY, VersionId: 'v1' },
      { Bucket: 'synthetic-bucket', Key: KEY, VersionId: 'v2' },
      { Bucket: 'synthetic-bucket', Key: KEY, VersionId: 'marker-1' },
    ]);
  });

  it('follows the listing across pages', async () => {
    const { client, sent } = s3([
      [{ IsTruncated: true, NextKeyMarker: '1', NextVersionIdMarker: 'v1', Versions: [{ Key: KEY, VersionId: 'v1' }] },
        { IsTruncated: false, DeleteMarkers: [{ Key: KEY, VersionId: 'marker-2' }] }],
      [{ IsTruncated: false }],
    ]);
    await expect(new S3SourceObjectEraser(config, client).eraseAllVersions('synthetic-bucket', KEY,
      new AbortController().signal)).resolves.toBe(2);
    expect(sent[1]?.input).toEqual({ Bucket: 'synthetic-bucket', Prefix: KEY, KeyMarker: '1', VersionIdMarker: 'v1' });
    expect(sent.filter((call) => call.name === 'DeleteObject')).toHaveLength(2);
  });

  it('answers 0 when nothing is left (a retry after the objects were already deleted)', async () => {
    const { client, sent } = s3([[{ IsTruncated: false }]]);
    await expect(new S3SourceObjectEraser(config, client).eraseAllVersions('synthetic-bucket', KEY,
      new AbortController().signal)).resolves.toBe(0);
    expect(sent.filter((call) => call.name === 'DeleteObject')).toHaveLength(0);
  });

  it('fails when a version is still there after the deletes, with how many it deleted', async () => {
    const { client } = s3([[{ IsTruncated: false, Versions: [{ Key: KEY, VersionId: 'v1' }] }]]);
    await expect(new S3SourceObjectEraser(config, client).eraseAllVersions('synthetic-bucket', KEY,
      new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_VERSIONS_REMAIN', deleted: 1 });
  });

  it('refuses a key outside clinical/objects/ without calling S3', async () => {
    const { client, sent } = s3([[{ IsTruncated: false }]]);
    for (const key of ['migration-quarantine/abc', 'clinical/objects/', 'clinical/objects/a/b', 'clinical/objects']) {
      await expect(new S3SourceObjectEraser(config, client).eraseAllVersions('synthetic-bucket', key,
        new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_KEY_OUTSIDE_LAYOUT' });
    }
    expect(sent).toHaveLength(0);
  });

  it('turns S3 errors into codes', async () => {
    const listFailure = s3([[{}]], { listError: new Error(`AccessDenied for ${SECRET}`) });
    await expect(new S3SourceObjectEraser(config, listFailure.client).eraseAllVersions('synthetic-bucket', KEY,
      new AbortController().signal)).rejects.toEqual(new SourceDeletionError('SOURCE_LIST_FAILED'));
    const deleteFailure = s3([[{ IsTruncated: false, Versions: [{ Key: KEY, VersionId: 'v1' }] }]],
      { deleteError: new Error('AccessDenied') });
    await expect(new S3SourceObjectEraser(config, deleteFailure.client).eraseAllVersions('synthetic-bucket', KEY,
      new AbortController().signal)).rejects.toMatchObject({ code: 'SOURCE_DELETE_FAILED', deleted: 0 });
  });
});

const candidate = (n: number): SourceDeletionCandidate => ({
  documentId: `0c9e8a7b-6d5c-4b3a-9f8e-00000000000${n}`, facilityId: '11111111-2222-4333-8444-555555555555',
  storageBucket: 'synthetic-bucket', storageKey: `clinical/objects/0c9e8a7b-6d5c-4b3a-9f8e-00000000000${n}`,
  dueSeconds: n * 3600 });

function sweeperMocks() {
  const order: string[] = [];
  const repository: jest.Mocked<SourceDeletionRepository> = {
    sourceDeletionBacklog: jest.fn().mockResolvedValue({ due: 2, overdue: 1 }),
    listSourceDeletions: jest.fn().mockResolvedValue([candidate(1), candidate(3)]),
    claimSourceDeletion: jest.fn(async (documentId: string, _correlationId: string) => {
      order.push(`claim ${documentId}`);
      return { outcome: 'claimed', storageBucket: 'synthetic-bucket', storageKey: `clinical/objects/${documentId}` } as SourceClaimResult;
    }),
    purgeSourceDocument: jest.fn(async (documentId: string, versions: number, _correlationId: string) => {
      order.push(`purge ${documentId} ${versions}`);
      return { outcome: 'deleted', extractions: 1, validations: 1, confirmations: 1 } as SourcePurgeResult;
    }),
  };
  const eraser: jest.Mocked<SourceObjectEraser> = { eraseAllVersions: jest.fn(async (_bucket: string, key: string, _signal: AbortSignal) => {
    order.push(`erase ${key}`);
    return 2;
  }) };
  const lines: Record<string, unknown>[] = [];
  const log = jest.fn((level: string, event: string, fields: Readonly<Record<string, unknown>>) => {
    lines.push({ level, event, ...fields });
  });
  return { repository, eraser, log, lines, order, sweeper: new SourceDeletionSweeper(repository, eraser, log) };
}

describe('SourceDeletionSweeper', () => {
  it('claims each document before any S3 call, then deletes, then purges with the count; one overdue line', async () => {
    const { repository, eraser, lines, order, sweeper } = sweeperMocks();
    await expect(sweeper.runRound(new AbortController().signal))
      .resolves.toEqual({ due: 2, overdue: 1, deleted: 2, failed: 0 });
    const [one, three] = [candidate(1), candidate(3)];
    expect(order).toEqual([`claim ${one.documentId}`, `erase ${one.storageKey}`, `purge ${one.documentId} 2`,
      `claim ${three.documentId}`, `erase ${three.storageKey}`, `purge ${three.documentId} 2`]);
    expect(eraser.eraseAllVersions).toHaveBeenCalledWith('synthetic-bucket', one.storageKey, expect.anything());
    expect(repository.listSourceDeletions).toHaveBeenCalledWith(100, expect.stringMatching(/^ocr-source-deletion-/));
    expect(lines.filter((line) => line.event === 'ocr.source_deletion.done')).toHaveLength(2);
    expect(lines.at(-1)).toEqual({ level: 'info', event: 'ocr.source_deletion.overdue', overdue: 1, due: 2, deleted: 2 });
  });

  it('writes the overdue line with zeros when nothing is due', async () => {
    const { repository, lines, sweeper } = sweeperMocks();
    repository.sourceDeletionBacklog.mockResolvedValue({ due: 0, overdue: 0 });
    repository.listSourceDeletions.mockResolvedValue([]);
    await sweeper.runRound(new AbortController().signal);
    expect(lines).toEqual([{ level: 'info', event: 'ocr.source_deletion.overdue', overdue: 0, due: 0, deleted: 0 }]);
  });

  it('makes no S3 call when the claim is refused (a job, retry or legal hold came after the listing)', async () => {
    const { repository, eraser, lines, sweeper } = sweeperMocks();
    repository.listSourceDeletions.mockResolvedValue([candidate(1)]);
    repository.claimSourceDeletion.mockResolvedValue({ outcome: 'not_due', storageBucket: null, storageKey: null });
    await expect(sweeper.runRound(new AbortController().signal)).resolves.toMatchObject({ deleted: 0, failed: 0 });
    expect(eraser.eraseAllVersions).not.toHaveBeenCalled();
    expect(repository.purgeSourceDocument).not.toHaveBeenCalled();
    expect(lines).toContainEqual(expect.objectContaining({ event: 'ocr.source_deletion.skipped',
      code: 'SOURCE_NO_LONGER_DUE' }));
  });

  it('makes no S3 call when the claim fails', async () => {
    const { repository, eraser, lines, sweeper } = sweeperMocks();
    repository.listSourceDeletions.mockResolvedValue([candidate(1)]);
    repository.claimSourceDeletion.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    await expect(sweeper.runRound(new AbortController().signal)).resolves.toMatchObject({ failed: 1 });
    expect(eraser.eraseAllVersions).not.toHaveBeenCalled();
    expect(repository.purgeSourceDocument).not.toHaveBeenCalled();
    expect(lines).toContainEqual(expect.objectContaining({ event: 'ocr.source_deletion.failed', stage: 'claim',
      code: '57014' }));
  });

  it('skips the purge when S3 fails, and next round finishes the claimed document with the cumulative count', async () => {
    const { repository, eraser, lines, sweeper } = sweeperMocks();
    repository.listSourceDeletions.mockResolvedValue([candidate(1)]);
    eraser.eraseAllVersions.mockRejectedValueOnce(new SourceDeletionError('SOURCE_DELETE_FAILED', 1));
    await expect(sweeper.runRound(new AbortController().signal))
      .resolves.toEqual({ due: 2, overdue: 1, deleted: 0, failed: 1 });
    expect(repository.purgeSourceDocument).not.toHaveBeenCalled();
    expect(lines).toContainEqual(expect.objectContaining({ event: 'ocr.source_deletion.failed',
      documentId: candidate(1).documentId, stage: 'storage', code: 'SOURCE_DELETE_FAILED' }));
    expect(lines.at(-1)).toMatchObject({ event: 'ocr.source_deletion.overdue', deleted: 0 });

    // Next round: the document is listed again (claimed documents first) and its claim is already held.
    repository.claimSourceDeletion.mockResolvedValueOnce({ outcome: 'already_claimed', storageBucket: 'synthetic-bucket',
      storageKey: candidate(1).storageKey });
    eraser.eraseAllVersions.mockResolvedValueOnce(1);
    await expect(sweeper.runRound(new AbortController().signal)).resolves.toMatchObject({ deleted: 1, failed: 0 });
    expect(repository.purgeSourceDocument).toHaveBeenLastCalledWith(candidate(1).documentId, 2, expect.any(String));
  });

  it('keeps the count when the purge fails after S3 succeeded, and retries with it', async () => {
    const { repository, eraser, lines, sweeper } = sweeperMocks();
    repository.listSourceDeletions.mockResolvedValue([candidate(1)]);
    repository.purgeSourceDocument.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '57P01' }));
    await sweeper.runRound(new AbortController().signal);
    expect(lines).toContainEqual(expect.objectContaining({ event: 'ocr.source_deletion.failed', stage: 'purge',
      code: '57P01', objectVersionsDeleted: 2 }));
    repository.claimSourceDeletion.mockResolvedValueOnce({ outcome: 'already_claimed', storageBucket: 'synthetic-bucket',
      storageKey: candidate(1).storageKey });
    eraser.eraseAllVersions.mockResolvedValueOnce(0);
    await sweeper.runRound(new AbortController().signal);
    expect(repository.purgeSourceDocument).toHaveBeenLastCalledWith(candidate(1).documentId, 2, expect.any(String));
  });

  it('logs a purge that is not done (not_claimed) as failed, never as done', async () => {
    const { repository, lines, sweeper } = sweeperMocks();
    repository.listSourceDeletions.mockResolvedValue([candidate(1)]);
    repository.purgeSourceDocument.mockResolvedValue({ outcome: 'not_claimed', extractions: 0, validations: 0,
      confirmations: 0 });
    await expect(sweeper.runRound(new AbortController().signal)).resolves.toMatchObject({ deleted: 0, failed: 1 });
    expect(lines).toContainEqual(expect.objectContaining({ event: 'ocr.source_deletion.failed', stage: 'purge',
      code: 'SOURCE_NOT_CLAIMED' }));
    expect(lines.filter((line) => line.event === 'ocr.source_deletion.done')).toEqual([]);
  });

  it('is idempotent: an already deleted document gets no S3 call, only the purge (residual blanking), not counted', async () => {
    const { repository, eraser, lines, sweeper } = sweeperMocks();
    repository.listSourceDeletions.mockResolvedValue([candidate(1)]);
    repository.claimSourceDeletion.mockResolvedValue({ outcome: 'already_deleted', storageBucket: null, storageKey: null });
    repository.purgeSourceDocument.mockResolvedValue({ outcome: 'already_deleted', extractions: 0, validations: 0,
      confirmations: 0 });
    await expect(sweeper.runRound(new AbortController().signal)).resolves.toMatchObject({ deleted: 0, failed: 0 });
    expect(eraser.eraseAllVersions).not.toHaveBeenCalled();
    expect(repository.purgeSourceDocument).toHaveBeenCalledWith(candidate(1).documentId, 0, expect.any(String));
    expect(lines.at(-1)).toEqual({ level: 'info', event: 'ocr.source_deletion.overdue', overdue: 1, due: 2, deleted: 0 });
  });

  it('logs a failure and no overdue line when the round cannot count or list (the alarm sees missing data)', async () => {
    for (const fail of ['backlog', 'list'] as const) {
      const { repository, eraser, lines, sweeper } = sweeperMocks();
      const error = Object.assign(new Error(`permission denied near ${SECRET}`), { code: '42501' });
      if (fail === 'backlog') repository.sourceDeletionBacklog.mockRejectedValue(error);
      else repository.listSourceDeletions.mockRejectedValue(error);
      await expect(sweeper.runRound(new AbortController().signal)).resolves.toBeNull();
      expect(lines).toEqual([expect.objectContaining({ level: 'error', event: 'ocr.source_deletion.failed',
        stage: 'list', code: '42501' })]);
      expect(repository.claimSourceDeletion).not.toHaveBeenCalled();
      expect(eraser.eraseAllVersions).not.toHaveBeenCalled();
    }
  });

  it('logs ids, codes and counts only: no text, file name, key or error message', async () => {
    const { repository, eraser, lines, sweeper } = sweeperMocks();
    eraser.eraseAllVersions.mockRejectedValueOnce(new Error(`S3 said: ${SECRET}`));
    repository.purgeSourceDocument.mockRejectedValueOnce(Object.assign(new Error(`row for ${SECRET}`),
      { code: `bad code with ${SECRET}` }));
    await sweeper.runRound(new AbortController().signal);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('clinical/objects');
    expect(logged).not.toContain('synthetic-bucket');
    expect(lines.filter((line) => line.event === 'ocr.source_deletion.failed').map((line) => line.code))
      .toEqual(['UNKNOWN', 'UNKNOWN']);
  });
});

describe('OcrWorker source deletion loop', () => {
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => { stdout.mockRestore(); stderr.mockRestore(); });

  function worker(enabled: boolean) {
    const repository = { checkReadiness: jest.fn(), claim: jest.fn().mockResolvedValue(null), close: jest.fn() } as
      unknown as WorkerRepository;
    const provider = { name: 'test', checkReadiness: jest.fn() } as unknown as WorkerOcrProvider;
    const sweeper = { runRound: jest.fn().mockResolvedValue(null) } as unknown as jest.Mocked<SourceDeletionSweeper>;
    const instance = new OcrWorker({ OCR_WORKER_CONCURRENCY: 1, OCR_WORKER_POLL_MS: 100, OCR_WORKER_LEASE_SECONDS: 60,
      OCR_SOURCE_DELETION_ENABLED: enabled, OCR_SOURCE_DELETION_INTERVAL_SECONDS: 900 } as OcrWorkerConfig,
    repository, {} as DocumentReader, provider, {} as PaperReadingService, sweeper);
    return { instance, sweeper };
  }

  it('runs a round at start when enabled, and stops with the worker', async () => {
    const { instance, sweeper } = worker(true);
    const running = instance.run();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    instance.stop();
    await running;
    expect(sweeper.runRound).toHaveBeenCalledTimes(1);
  });

  it('runs no round when OCR_SOURCE_DELETION_ENABLED is false', async () => {
    const { instance, sweeper } = worker(false);
    const running = instance.run();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    instance.stop();
    await running;
    expect(sweeper.runRound).not.toHaveBeenCalled();
  });
});
