import * as path from 'node:path';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import { Semaphore } from '../semaphore';
import type { ZoomJob, ZoomJobAnswer, ZoomWorkerMessage } from './zoom-worker';

/**
 * Runs zoom's decodes and crops each in a worker thread of its own (zoom-worker.ts), so that:
 * - time is bounded whatever the bytes: a job not answered within its limit (decode 5 s, crop 3 s, from when the
 *   worker is ready) is ended with worker.terminate(), which stops even a synchronous loop; starting the worker has
 *   its own limit (ZOOM_WORKER_START_LIMIT_MS);
 * - the main event loop never stalls on a decode (the other job's reads and every lease renewal go on);
 * - memory is bounded by the worker's heap limits (ZOOM_WORKER_RESOURCE_LIMITS) beside jpeg-js's own count;
 * - at most ZOOM_WORKERS_AT_ONCE zoom workers run in the process, whatever the number of jobs (others wait, and an
 *   abort ends the wait);
 * - an abort (the worker's shutdown) terminates the job's worker at once; every worker is terminated when its job
 *   ends, answered or not, so none outlives its job (liveZoomWorkers counts them).
 * Any failure (a decoder error, a limit, a crash, out of memory, a timeout, an abort) rejects with a fixed message,
 * never with anything from the picture; the caller turns zoom off for the page and the read goes on.
 */

/** From starting a worker to its first message (loading jpeg-js and pngjs takes tens of milliseconds). */
export const ZOOM_WORKER_START_LIMIT_MS = 10_000;
/** Zoom worker threads at once in the process: one, so two jobs never decode at the same time. */
export const ZOOM_WORKERS_AT_ONCE = 1;
/**
 * The worker's V8 heap limits: a backstop sized well above need, not the thing that bounds memory (jpeg-js's own
 * count from the checked frame and the pixel limits do that). jpeg-js keeps each 8 x 8 block as its own Int32Array,
 * a heap object beside its 256 bytes outside the heap; measured on fictional pages at the worst JPEG allowed (12.5
 * MP, 3 components at 4:4:4, 6 to 7 MB of noise, baseline or progressive), the decode failed with a 96 MB old
 * generation and passed with 128 MB; the worst PNG passed with 96 MB. 512 MB is four times that. Pixel and PNG
 * buffers are outside the heap. A worker over its heap limit is meant to end with an error (zoom off), but V8 can
 * instead abort the whole process when the limit is hit while allocating a buffer (seen once in testing at 64 MB):
 * hence the wide margin.
 */
export const ZOOM_WORKER_RESOURCE_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64,
  codeRangeSizeMb: 16, stackSizeMb: 4 };

export type ZoomJobRunner = (job: ZoomJob, limitMs: number, signal?: AbortSignal) => Promise<ZoomJobAnswer>;

export interface ZoomWorkerRunnerOptions {
  /** Starts the worker for one job (tests start a slow or broken one); the real zoom-worker by default. */
  spawn?: () => Worker;
  startLimitMs?: number;
}

const slots = new Semaphore(ZOOM_WORKERS_AT_ONCE);
const live = new Set<Worker>();

/** Zoom worker threads running now (0 whenever no zoom job is running). */
export function liveZoomWorkers(): number { return live.size; }

/** Starts the real zoom worker: the built JavaScript, or under ts-jest the TypeScript through ts-node. */
export function spawnZoomWorker(): Worker {
  const extension = path.extname(__filename);
  const entry = path.join(__dirname, `zoom-worker${extension}`);
  const options = { resourceLimits: ZOOM_WORKER_RESOURCE_LIMITS };
  if (extension !== '.ts') return new Worker(entry, options);
  const tsNode = require.resolve('ts-node');
  return new Worker(`require(${JSON.stringify(tsNode)}).register({ transpileOnly: true, `
    + `compilerOptions: { module: 'commonjs' } }); require(${JSON.stringify(entry)});`, { ...options, eval: true });
}

class ZoomJobFailed extends Error {
  constructor(code: string) { super(code); this.name = 'ZoomJobFailed'; }
}

export function createZoomWorkerRunner(options: ZoomWorkerRunnerOptions = {}): ZoomJobRunner {
  const spawn = options.spawn ?? spawnZoomWorker;
  const startLimitMs = options.startLimitMs ?? ZOOM_WORKER_START_LIMIT_MS;
  return async (job, limitMs, signal) => {
    const release = await slots.acquire(signal).catch(() => { throw new ZoomJobFailed('ZOOM_ABORTED'); });
    let worker: Worker | undefined;
    try {
      worker = spawn();
      live.add(worker);
      return await answerOf(worker, job, limitMs, startLimitMs, signal);
    } finally {
      if (worker) {
        await worker.terminate().catch(() => undefined);
        live.delete(worker);
      }
      release();
    }
  };
}

function answerOf(worker: Worker, job: ZoomJob, limitMs: number, startLimitMs: number, signal?: AbortSignal):
  Promise<ZoomJobAnswer> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const settle = (error: ZoomJobFailed | null, answer?: ZoomJobAnswer) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.removeAllListeners('message');
      if (error) reject(error); else resolve(answer!);
    };
    const onAbort = () => { settle(new ZoomJobFailed('ZOOM_ABORTED')); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => settle(new ZoomJobFailed('ZOOM_WORKER_START_LIMIT')), startLimitMs);
    worker.on('error', () => settle(new ZoomJobFailed('ZOOM_WORKER_ERROR')));
    worker.on('exit', () => settle(new ZoomJobFailed('ZOOM_WORKER_EXIT')));
    let started = false;
    worker.on('message', (message: ZoomWorkerMessage) => {
      if (message.type === 'ready' && !started) {
        started = true;
        clearTimeout(timer);
        timer = setTimeout(() => settle(new ZoomJobFailed('ZOOM_TIME_LIMIT')), limitMs);
        if (job.kind === 'decode') {
          // Exactly the picture's bytes, copied once and moved (cloning a view would copy its whole buffer).
          const bytes = job.source.bytes.slice();
          worker.postMessage({ kind: 'decode', source: { ...job.source, bytes } } satisfies ZoomJob, [bytes.buffer]);
        } else {
          // The raster is moved to the worker and back with the answer (never copied; lost if the worker dies).
          worker.postMessage(job, [job.rgb]);
        }
      } else if (message.type === 'done' && started && message.answer.kind === job.kind) {
        settle(null, message.answer);
      } else {
        settle(new ZoomJobFailed('ZOOM_JOB_FAILED'));
      }
    });
  });
}

/** The process's zoom runner (one worker at a time, shared by every job). */
export const zoomWorkerRunner: ZoomJobRunner = createZoomWorkerRunner();
