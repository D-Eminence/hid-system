import { parentPort } from 'node:worker_threads';
import { cropPng, decodeRaster, type ZoomSource } from './zoom-raster';

/**
 * The zoom worker thread (zoom-jobs.ts starts one per job and ends it after): decodes a page picture, or cuts and
 * encodes one crop, off the main event loop. Pixels go back as transferred ArrayBuffers, never copied. A failure is
 * answered with no detail at all (an error could carry picture bytes; none is ever posted, logged or thrown on).
 */
export type ZoomJob =
  | { kind: 'decode'; source: ZoomSource }
  | { kind: 'crop'; width: number; height: number; rgb: ArrayBuffer;
    rect: { x: number; y: number; w: number; h: number }; outWidth: number; outHeight: number; maxBase64: number };

export type ZoomJobAnswer =
  | { kind: 'decode'; width: number; height: number; rgb: ArrayBuffer }
  | { kind: 'crop'; rgb: ArrayBuffer; png: ArrayBuffer | null; width: number; height: number };

export type ZoomWorkerMessage = { type: 'ready' } | { type: 'done'; answer: ZoomJobAnswer } | { type: 'failed' };

/** The buffer of exactly these bytes: the array's own when it spans it, else a copy. */
export function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

export function runZoomJob(job: ZoomJob): { answer: ZoomJobAnswer; transfer: ArrayBuffer[] } {
  if (job.kind === 'decode') {
    const raster = decodeRaster(job.source);
    const rgb = ownBuffer(raster.rgb);
    return { answer: { kind: 'decode', width: raster.width, height: raster.height, rgb }, transfer: [rgb] };
  }
  const raster = { width: job.width, height: job.height, rgb: new Uint8Array(job.rgb) };
  if (raster.rgb.length !== raster.width * raster.height * 3) throw new Error('ZOOM_CROP_SHAPE');
  const crop = cropPng(raster, job.rect, job.outWidth, job.outHeight, job.maxBase64);
  const png = crop.png === null ? null : ownBuffer(crop.png);
  return { answer: { kind: 'crop', rgb: job.rgb, png, width: crop.width, height: crop.height },
    transfer: png === null ? [job.rgb] : [job.rgb, png] };
}

const port = parentPort;
if (port !== null) {
  port.once('message', (job: ZoomJob) => {
    let message: ZoomWorkerMessage;
    let transfer: ArrayBuffer[] = [];
    try {
      const done = runZoomJob(job);
      message = { type: 'done', answer: done.answer };
      transfer = done.transfer;
    } catch {
      message = { type: 'failed' };
    }
    port.postMessage(message, transfer);
  });
  port.postMessage({ type: 'ready' } satisfies ZoomWorkerMessage);
}
