import { readOcrWorkerConfig } from './config';
import { ClaudePageClient } from './reading/claude.client';
import { PaperReadingService } from './reading/reader';
import { PostgresWorkerRepository } from './repository';
import { S3ExactDocumentReader } from './s3-document-reader';
import { S3SourceObjectEraser, SourceDeletionSweeper } from './source-deletion';
import { TestOcrProvider } from './test.provider';
import { TextractOcrProvider } from './textract.provider';
import type { WorkerOcrProvider } from './types';
import { OcrWorker } from './worker';

async function bootstrap(): Promise<void> {
  const config = readOcrWorkerConfig();
  if (config.OCR_PROVIDER === 'disabled') {
    throw new Error('OCR worker is explicitly disabled and will not accept claims');
  }
  const provider: WorkerOcrProvider = config.OCR_PROVIDER === 'textract'
    ? new TextractOcrProvider(config) : new TestOcrProvider();
  // One provider and one Claude client for the whole process: their call limits (OCR_TEXTRACT_MAX_CONCURRENT,
  // OCR_AI_MAX_CONCURRENT_REQUESTS) are shared by every claim loop.
  const reading = new PaperReadingService(config,
    config.OCR_AI_MODE === 'claude' ? new ClaudePageClient(config) : null);
  const repository = new PostgresWorkerRepository(config);
  // Source deletion 24 hours after the job finished (migration 0111); OCR_SOURCE_DELETION_ENABLED=false stops it.
  const sourceDeletion = new SourceDeletionSweeper(repository, new S3SourceObjectEraser(config));
  const worker = new OcrWorker(config, repository, new S3ExactDocumentReader(config), provider, reading, sourceDeletion);
  process.once('SIGTERM', () => worker.stop());
  process.once('SIGINT', () => worker.stop());
  await worker.run();
}

void bootstrap().catch((error: unknown) => {
  const code = error instanceof Error && error.message.startsWith('Invalid OCR worker configuration')
    ? 'INVALID_CONFIGURATION' : 'STARTUP_FAILED';
  process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error',
    event: 'ocr.worker.startup_failed', code, acceptingClaims: false }) + '\n');
  process.exitCode = 1;
});
