import { readOcrWorkerConfig } from './config';
import { PostgresWorkerRepository } from './repository';
import { S3ExactDocumentReader } from './s3-document-reader';
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
  const worker = new OcrWorker(config, new PostgresWorkerRepository(config),
    new S3ExactDocumentReader(config), provider);
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
