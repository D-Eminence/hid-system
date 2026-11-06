import * as jpeg from 'jpeg-js';
import { Worker } from 'node:worker_threads';
import { PNG } from 'pngjs';
import zlib = require('node:zlib');
import { HIGH_RESOLUTION_TIER, imageTokens, resizedSize, STANDARD_TIER } from './page-image';
import { desyncJpeg, fixtureJpeg, fixturePng, jpegFrame, jpegFromParts, jpegScan, jpegSegment, pngChunk,
  pngFromChunks, pngIhdr, syntheticJpeg, syntheticPng, withRepeatedScan } from './test-fixtures';
import { clampBox, createPageZoom, createZoomSession, decodeJpegWithin, decodePngWithin, decodeRaster, jpegMemoryBudget,
  jpegStructure, pngInflatedSize, pngStructure, resample, toOriginalRect, ZOOM_JPEG_MAX_DECODE_PIXELS,
  ZOOM_JPEG_MAX_SCANS, ZOOM_JPEG_MEMORY_SLACK_BYTES, ZOOM_LIMIT_MESSAGE, ZOOM_MAX_DECODE_PIXELS, ZOOM_MIN_BOX_PX, ZOOM_REQUEST_BASE64_BUDGET, ZOOM_TOOL,
  ZOOM_UNAVAILABLE_MESSAGE, zoomDecodable, zoomOutputSize, type JpegStructure, type PageZoom, type Raster,
  type ZoomSource } from './zoom';
import { createZoomWorkerRunner, liveZoomWorkers, spawnZoomWorker, ZOOM_WORKERS_AT_ONCE, zoomWorkerRunner,
  type ZoomJobRunner } from './zoom-jobs';

const source = (mediaType: 'image/png' | 'image/jpeg', width: number, height: number): ZoomSource => ({ mediaType,
  width, height, bytes: mediaType === 'image/png' ? syntheticPng(width, height) : syntheticJpeg(width, height) });

/**
 * A PNG whose chunks walk cleanly (IHDR, a PLTE for a palette picture, one IDAT holding an empty zlib stream, IEND):
 * enough for the header checks, which must refuse it before anything is inflated.
 */
function pngHeader(width: number, height: number, bitDepth: number, colourType: number, interlace = 0): Uint8Array {
  return pngFromChunks(pngIhdr(width, height, bitDepth, colourType, interlace),
    ...(colourType === 3 ? [pngChunk('PLTE', [0, 0, 0, 255, 255, 255])] : []),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(0))), pngChunk('IEND'));
}

function decodePng(base64: string) {
  return PNG.sync.read(Buffer.from(base64, 'base64'));
}

/** The real worker runner, counting the jobs it runs by kind. */
function countingRunner(inner: ZoomJobRunner = zoomWorkerRunner) {
  const jobs: string[] = [];
  const runner: ZoomJobRunner = (job, limit, signal) => { jobs.push(job.kind); return inner(job, limit, signal); };
  return { runner, jobs, decodes: () => jobs.filter((kind) => kind === 'decode').length };
}

/** A worker that says it is ready, then never answers (a synchronous loop): only terminate() ends it. */
const hangingWorker = () => new Worker(`const { parentPort } = require('node:worker_threads');
  parentPort.on('message', () => { for (;;) { /* spin */ } }); parentPort.postMessage({ type: 'ready' });`, { eval: true });
/** A worker that never even says it is ready. */
const silentWorker = () => new Worker('for (;;) { /* spin */ }', { eval: true });

afterEach(() => {
  // No zoom worker outlives its job, answered, failed, timed out or aborted.
  expect(liveZoomWorkers()).toBe(0);
});

describe('zoom geometry', () => {
  const seen = { width: 1000, height: 1400 };

  it('clamps a box to the picture and rejects tiny, empty or non-finite boxes', () => {
    expect(clampBox({ x: -50, y: 1300, w: 200, h: 300 }, seen)).toEqual({ x: 0, y: 1300, w: 150, h: 100 });
    expect(clampBox({ x: 10, y: 10, w: 100, h: 50 }, seen)).toEqual({ x: 10, y: 10, w: 100, h: 50 });
    for (const box of [{ x: 0, y: 0, w: ZOOM_MIN_BOX_PX - 1, h: 100 }, { x: 0, y: 0, w: 100, h: 0 },
      { x: 0, y: 0, w: -20, h: 20 }, { x: Number.NaN, y: 0, w: 20, h: 20 }, { x: 0, y: 0, w: Infinity, h: 20 },
      { x: 995, y: 0, w: 100, h: 100 }, { x: 2000, y: 2000, w: 50, h: 50 }]) {
      expect(clampBox(box, seen)).toBeNull();
    }
  });

  it('maps a box in the resized frame the model sees back to the original pixels', () => {
    // A4 at 300 dpi: the API reads it smaller, and the model's coordinates are in that smaller frame.
    const original = { width: 2480, height: 3508 };
    const frame = resizedSize(original.width, original.height, HIGH_RESOLUTION_TIER);
    expect(frame.width).toBeLessThan(original.width);
    const half = { x: frame.width / 2, y: frame.height / 4, w: frame.width / 2, h: frame.height / 4 };
    const rect = toOriginalRect(half, frame, original);
    expect(rect.x).toBeGreaterThanOrEqual(1239);
    expect(rect.x).toBeLessThanOrEqual(1240);
    expect(rect.x + rect.w).toBe(2480);
    expect(Math.abs(rect.y - 877)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.y + rect.h - 1754)).toBeLessThanOrEqual(1);
    // Not resized: the same pixels.
    expect(toOriginalRect({ x: 10, y: 20, w: 30, h: 40 }, original, original)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    // Always at least one pixel, inside the picture.
    expect(toOriginalRect({ x: frame.width - 0.1, y: 0, w: 0.1, h: 0.1 }, frame, original))
      .toMatchObject({ x: 2479, w: 1, h: 1 });
  });

  it('enlarges by the scale but never beyond the tier, so the API does not resize the crop again', () => {
    expect(zoomOutputSize({ x: 0, y: 0, w: 200, h: 50 }, 2, HIGH_RESOLUTION_TIER)).toEqual({ width: 400, height: 100 });
    for (const tier of [HIGH_RESOLUTION_TIER, STANDARD_TIER]) {
      const size = zoomOutputSize({ x: 0, y: 0, w: 1800, h: 1200 }, 4, tier);
      expect(Math.ceil(size.width / 28) * 28).toBeLessThanOrEqual(tier.maxEdge);
      expect(Math.ceil(size.height / 28) * 28).toBeLessThanOrEqual(tier.maxEdge);
      expect(imageTokens(size.width, size.height)).toBeLessThanOrEqual(tier.maxTokens);
      expect(resizedSize(size.width, size.height, tier)).toEqual(size);
      // The aspect is kept.
      expect(size.width / size.height).toBeCloseTo(1.5, 1);
    }
  });

  it('resamples bilinearly when enlarging and by area when shrinking', () => {
    // 2 x 1: black then white.
    const raster: Raster = { width: 2, height: 1, rgb: new Uint8Array([0, 0, 0, 255, 255, 255]) };
    const up = resample(raster, { x: 0, y: 0, w: 2, h: 1 }, 4, 1);
    expect([up[0], up[3], up[6], up[9]]).toEqual([0, 64, 191, 255]);
    const wide: Raster = { width: 4, height: 2, rgb: new Uint8Array([0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255,
      0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255]) };
    expect([...resample(wide, { x: 0, y: 0, w: 4, h: 2 }, 2, 1)]).toEqual([0, 0, 0, 255, 255, 255]);
  });
});

describe('page zoom over the stored bytes', () => {
  for (const mediaType of ['image/png', 'image/jpeg'] as const) {
    it(`decodes a ${mediaType} once and returns an enlarged PNG crop of the box`, async () => {
      const page = source(mediaType, 640, 480);
      const counted = countingRunner();
      const zoom = createPageZoom(page, { width: 640, height: 480 }, HIGH_RESOLUTION_TIER, { runner: counted.runner });
      // A box over the first dark bar (x 0-3) and white (x 4-15), above the grey band.
      const outcome = await zoom.crop({ x: 0, y: 0, w: 16, h: 16 }, 4);
      expect(outcome.kind).toBe('crop');
      const crop = outcome.kind === 'crop' ? outcome.crop : null;
      expect(crop).toMatchObject({ mediaType: 'image/png', width: 64, height: 64, scale: 4,
        region: { x: 0, y: 0, w: 16, h: 16 } });
      const png = decodePng(crop!.base64);
      expect([png.width, png.height]).toEqual([64, 64]);
      const at = (x: number, y: number) => png.data[(y * 64 + x) * 4]!;
      expect(at(2, 30)).toBeLessThan(60);
      expect(at(40, 30)).toBeGreaterThan(220);
      // The default scale and the grey band.
      const band = await zoom.crop({ x: 300, y: 200, w: 40, h: 40 }, 2);
      expect(band.kind === 'crop' && [band.crop.width, band.crop.height]).toEqual([80, 80]);
      const grey = decodePng((band as { crop: { base64: string } }).crop.base64);
      expect(Math.abs(grey.data[(40 * 80 + 70) * 4]! - 128)).toBeLessThan(12);
      expect(counted.jobs).toEqual(['decode', 'crop', 'crop']);
    });
  }

  it('cuts from the original pixels when the model saw the picture smaller', async () => {
    const page = source('image/png', 3200, 400);
    const seen = resizedSize(3200, 400, HIGH_RESOLUTION_TIER);
    expect(seen.width).toBeLessThan(3200);
    const zoom = createPageZoom(page, seen, HIGH_RESOLUTION_TIER);
    const factor = 3200 / seen.width;
    // In the seen frame, a box exactly one source bar period wide (16 original px).
    const outcome = await zoom.crop({ x: 0, y: 0, w: 16 / factor * 4, h: 40 }, 1);
    expect(outcome.kind).toBe('crop');
    const png = decodePng((outcome as { crop: { base64: string } }).crop.base64);
    // Four bars in the crop: dark columns where the original had them.
    const row = Array.from({ length: png.width }, (_, x) => png.data[(5 * png.width + x) * 4]! < 128 ? 1 : 0);
    const starts = row.filter((dark, x) => dark === 1 && (x === 0 || row[x - 1] === 0)).length;
    expect(starts).toBe(4);
  });

  it('rejects a bad box or scale without decoding, and turns zoom off for the page on a decode problem', async () => {
    const counted = countingRunner();
    const decodes = counted.decodes;
    const broken = createPageZoom({ mediaType: 'image/png', bytes: fixturePng(640, 480), width: 640, height: 480 },
      { width: 640, height: 480 }, HIGH_RESOLUTION_TIER, { runner: counted.runner });
    await expect(broken.crop({ x: 0, y: 0, w: 2, h: 2 }, 2)).resolves.toEqual({ kind: 'invalid' });
    await expect(broken.crop({ x: 0, y: 0, w: 20, h: 20 }, 5)).resolves.toEqual({ kind: 'invalid' });
    await expect(broken.crop({ x: 0, y: 0, w: 20, h: 20 }, 0.5)).resolves.toEqual({ kind: 'invalid' });
    expect(decodes()).toBe(0);
    await expect(broken.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    await expect(broken.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    expect(decodes()).toBe(1);
    // A decoded size other than the header's.
    const page = source('image/png', 64, 48);
    const mismatch = createPageZoom({ ...page, width: 65 }, { width: 65, height: 48 }, HIGH_RESOLUTION_TIER);
    await expect(mismatch.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('refuses a JPEG over the pixel limit or that does not parse, and its error carries no picture data', () => {
    // Over zoom's JPEG pixel limit by the header: refused before any pixel is decoded.
    expect(() => decodeRaster({ mediaType: 'image/jpeg', bytes: fixtureJpeg(9_000, 9_000), width: 9_000, height: 9_000 }))
      .toThrow(/ZOOM_DECODE_LIMIT/);
    // A frame claiming another size than the picture's: refused too (jpeg-js's own limits stay behind this).
    const real = syntheticJpeg(64, 48);
    expect(() => decodeRaster({ mediaType: 'image/jpeg', bytes: real, width: 640, height: 480 }))
      .toThrow(/ZOOM_DECODE_LIMIT/);
    // An undecodable JPEG throws, and the message has none of its bytes.
    const bytes = fixtureJpeg(640, 480);
    let message = '';
    try { decodeRaster({ mediaType: 'image/jpeg', bytes, width: 640, height: 480 }); } catch (error) {
      message = String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(Buffer.from(bytes).toString('base64').slice(40, 80));
  });

  it('refuses, before inflating anything, a PNG over 8 bits per sample, interlaced, or over the pixel limit', async () => {
    const read = jest.spyOn(zlib, 'inflateSync');
    try {
      // A tiny, very compressible 16-bit RGBA page at the picture limit (about 1.5 GB to decode): never inflated.
      const refused = [pngHeader(8_000, 8_000, 16, 6), pngHeader(3_000, 4_000, 16, 2), pngHeader(3_000, 4_000, 8, 2, 1),
        pngHeader(5_000, 5_000, 8, 2), pngHeader(6_000, 4_001, 8, 0)];
      for (const bytes of refused) {
        const width = new DataView(bytes.buffer).getUint32(16);
        const height = new DataView(bytes.buffer).getUint32(20);
        const page: ZoomSource = { mediaType: 'image/png', bytes, width, height };
        expect(zoomDecodable(page)).toBe(false);
        expect(() => decodeRaster(page)).toThrow(/ZOOM_DECODE_LIMIT/);
        const zoom = createPageZoom(page, resizedSize(width, height, HIGH_RESOLUTION_TIER), HIGH_RESOLUTION_TIER);
        await expect(zoom.crop({ x: 0, y: 0, w: 200, h: 200 }, 2)).resolves.toEqual({ kind: 'unavailable' });
      }
      expect(read).not.toHaveBeenCalled();
      // At the limits: allowed (8-bit or less, not interlaced, 24 MP).
      for (const [depth, colour] of [[8, 6], [8, 2], [1, 0], [8, 3]] as const) {
        expect(zoomDecodable({ mediaType: 'image/png', bytes: pngHeader(6_000, 4_000, depth, colour), width: 6_000,
          height: 4_000 })).toBe(true);
      }
    } finally { read.mockRestore(); }
  });

  it('never decodes a JPEG over the pixel limit, though the picture itself may be sent', async () => {
    const counted = countingRunner();
    for (const [width, height] of [[8_000, 8_000], [4_096, 3_052], [6_000, 4_000]] as const) {
      expect(width * height).toBeGreaterThan(ZOOM_JPEG_MAX_DECODE_PIXELS);
      const page: ZoomSource = { mediaType: 'image/jpeg', bytes: fixtureJpeg(width, height), width, height };
      expect(zoomDecodable(page)).toBe(false);
      const zoom = createPageZoom(page, resizedSize(width, height, HIGH_RESOLUTION_TIER), HIGH_RESOLUTION_TIER,
        { runner: counted.runner });
      expect(zoom.available()).toBe(false);
      await expect(zoom.crop({ x: 0, y: 0, w: 200, h: 200 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    }
    expect(counted.jobs).toEqual([]);
  });

  it('decodes and crops a JPEG photo at the 12.5 MP limit (4096 x 3051), within jpeg-js\'s memory limit', async () => {
    // A fictional synthetic page, not anyone's. Time limits wide here: this checks the memory cap, not the speed.
    const page = source('image/jpeg', 4_096, 3_051);
    expect(page.width * page.height).toBeLessThanOrEqual(ZOOM_JPEG_MAX_DECODE_PIXELS);
    expect(page.width * (page.height + 1)).toBeGreaterThan(ZOOM_JPEG_MAX_DECODE_PIXELS);
    const seen = resizedSize(page.width, page.height, HIGH_RESOLUTION_TIER);
    const zoom = createPageZoom(page, seen, HIGH_RESOLUTION_TIER, { decodeTimeLimitMs: 120_000, cropTimeLimitMs: 120_000 });
    expect(zoom.available()).toBe(true);
    const outcome = await zoom.crop({ x: 100, y: 200, w: 300, h: 120 }, 2);
    expect(outcome.kind).toBe('crop');
  }, 120_000);

  it('still decodes a PNG at the 24 MP limit by the header checks (its limit is separate from the JPEG one)', () => {
    expect(ZOOM_MAX_DECODE_PIXELS).toBe(24_000_000);
    expect(zoomDecodable({ mediaType: 'image/png', bytes: pngHeader(6_000, 4_000, 8, 6), width: 6_000, height: 4_000 }))
      .toBe(true);
  });

  it('terminates a decode that does not finish in its time limit, and zoom is off for the page, not the reading', async () => {
    const counted = countingRunner(createZoomWorkerRunner({ spawn: hangingWorker }));
    const zoom = createPageZoom(source('image/png', 64, 48), { width: 64, height: 48 }, HIGH_RESOLUTION_TIER,
      { runner: counted.runner, decodeTimeLimitMs: 300 });
    const started = performance.now();
    await expect(zoom.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    // Ended by terminate() at the limit, not when the (never-ending) loop finishes.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(liveZoomWorkers()).toBe(0);
    await expect(zoom.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    expect(counted.jobs).toEqual(['decode']);
  }, 20_000);

  it('terminates a crop that does not finish in its time limit, and zoom is off for the page from then on', async () => {
    const hanging = createZoomWorkerRunner({ spawn: hangingWorker });
    const counted = countingRunner((job, limit, signal) => (job.kind === 'crop' ? hanging : zoomWorkerRunner)(job, limit,
      signal));
    const zoom = createPageZoom(source('image/png', 64, 48), { width: 64, height: 48 }, HIGH_RESOLUTION_TIER,
      { runner: counted.runner, cropTimeLimitMs: 300 });
    await expect(zoom.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    await expect(zoom.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    expect(counted.jobs).toEqual(['decode', 'crop']);
  }, 20_000);

  it('terminates a worker that never starts, within its start limit', async () => {
    const runner = createZoomWorkerRunner({ spawn: silentWorker, startLimitMs: 300 });
    const zoom = createPageZoom(source('image/png', 64, 48), { width: 64, height: 48 }, HIGH_RESOLUTION_TIER, { runner });
    await expect(zoom.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
  }, 20_000);

  it('ends a running decode at once on abort (shutdown), leaving no worker behind', async () => {
    const runner = createZoomWorkerRunner({ spawn: hangingWorker });
    const zoom = createPageZoom(source('image/png', 64, 48), { width: 64, height: 48 }, HIGH_RESOLUTION_TIER,
      { runner, decodeTimeLimitMs: 60_000 });
    const controller = new AbortController();
    const started = performance.now();
    const pending = zoom.crop({ x: 0, y: 0, w: 20, h: 20 }, 2, controller.signal);
    // Abort once the worker is up and spinning.
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort(new Error('worker shutdown'));
    await expect(pending).resolves.toEqual({ kind: 'unavailable' });
    expect(performance.now() - started).toBeLessThan(10_000);
    // An abort before the job starts never starts a worker.
    const spawn = jest.fn(hangingWorker);
    const never = createPageZoom(source('image/png', 64, 48), { width: 64, height: 48 }, HIGH_RESOLUTION_TIER,
      { runner: createZoomWorkerRunner({ spawn }) });
    await expect(never.crop({ x: 0, y: 0, w: 20, h: 20 }, 2, controller.signal)).resolves.toEqual({ kind: 'unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  }, 20_000);

  it(`runs at most ${ZOOM_WORKERS_AT_ONCE} zoom worker at a time in the process, however many pages zoom at once`, async () => {
    expect(ZOOM_WORKERS_AT_ONCE).toBe(1);
    let most = 0;
    const watch = setInterval(() => { most = Math.max(most, liveZoomWorkers()); }, 5);
    try {
      const runner = createZoomWorkerRunner({ spawn: hangingWorker });
      const pages = [0, 1, 2].map(() => createPageZoom(source('image/png', 64, 48), { width: 64, height: 48 },
        HIGH_RESOLUTION_TIER, { runner, decodeTimeLimitMs: 250 }));
      const outcomes = await Promise.all(pages.map((page) => page.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)));
      expect(outcomes.map((outcome) => outcome.kind)).toEqual(['unavailable', 'unavailable', 'unavailable']);
    } finally { clearInterval(watch); }
    expect(most).toBe(1);
  }, 30_000);

  it('does not block the event loop while a page decodes: timers keep firing (lease renewal goes on)', async () => {
    // A fictional synthetic page large enough for a decode of several hundred milliseconds.
    const page = source('image/jpeg', 2_400, 1_800);
    const zoom = createPageZoom(page, resizedSize(2_400, 1_800, HIGH_RESOLUTION_TIER), HIGH_RESOLUTION_TIER,
      { decodeTimeLimitMs: 60_000, cropTimeLimitMs: 60_000 });
    let ticks = 0;
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now;
      ticks += 1; }, 10);
    const started = performance.now();
    try {
      await expect(zoom.crop({ x: 100, y: 100, w: 200, h: 100 }, 2)).resolves.toMatchObject({ kind: 'crop' });
    } finally { clearInterval(timer); }
    const elapsed = performance.now() - started;
    // The decode in-process alone stalls the loop for its whole length; in the worker the timer keeps its pace.
    const inProcess = performance.now();
    decodeRaster(page);
    const stall = performance.now() - inProcess;
    expect(stall).toBeGreaterThan(100);
    expect(ticks).toBeGreaterThan(elapsed / 10 / 3);
    expect(longest).toBeLessThan(Math.max(150, stall / 2));
  }, 60_000);

  it('moves the raster to each crop\'s worker and back, so later crops still have it', async () => {
    const zoom = createPageZoom(source('image/png', 640, 480), { width: 640, height: 480 }, HIGH_RESOLUTION_TIER);
    // Both reads of a page may ask at once: their crops run one after another over the same raster.
    const outcomes = await Promise.all([zoom.crop({ x: 0, y: 0, w: 16, h: 16 }, 4), zoom.crop({ x: 300, y: 200, w: 40,
      h: 40 }, 2), zoom.crop({ x: 10, y: 10, w: 2, h: 2 }, 2), zoom.crop({ x: 0, y: 0, w: 600, h: 400 }, 1)]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['crop', 'crop', 'invalid', 'crop']);
  }, 30_000);

  it('starts the real worker from the built JavaScript or, under ts-jest, the TypeScript', async () => {
    const worker = spawnZoomWorker();
    try {
      const first = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
      expect(first).toEqual({ type: 'ready' });
    } finally { await worker.terminate(); }
  }, 20_000);
});

describe('JPEG structure checks before any decode', () => {
  const frame = jpegFrame(64, 48);
  const structure = (...parts: number[][]) => jpegStructure(jpegFromParts(...parts));
  const decodable = (bytes: Uint8Array, width = 64, height = 48) =>
    zoomDecodable({ mediaType: 'image/jpeg', bytes, width, height });

  it('reads a real baseline JPEG\'s frame and its one scan', () => {
    expect(jpegStructure(syntheticJpeg(64, 48))).toEqual({ frameMarker: 0xc0, precision: 8, width: 64, height: 48,
      components: 3, scans: 1, scanMarkersAnywhere: 1, sampling: [{ h: 1, v: 1 }, { h: 1, v: 1 }, { h: 1, v: 1 }],
      tableBytes: 2 * 256 + 2 * (16 + 12) + 2 * (16 + 162) });
    expect(decodable(syntheticJpeg(64, 48))).toBe(true);
  });

  it('skips entropy-coded data correctly: stuffed 0xFF 0x00, restart markers and fill bytes stay inside the scan', () => {
    const entropy = [0x01, 0xff, 0x00, 0x02, 0xff, 0xd0, 0x03, 0xff, 0x00, 0xff, 0xd7, 0x04, 0xff, 0xff];
    expect(structure(jpegSegment(0xdd, [0, 4]), frame, jpegScan([1, 2, 3], entropy))).toMatchObject({ scans: 1 });
    // A second scan after it is counted as a second scan.
    expect(structure(frame, jpegScan([1, 2, 3], entropy), jpegScan([1]))).toMatchObject({ scans: 2 });
    // A COM segment holding marker-like bytes is skipped by its length (but its 0xFF 0xDA pairs are counted anywhere).
    expect(structure(jpegSegment(0xfe, [0xff, 0xda, 0xff, 0xc0, 0xff, 0xd9]), frame, jpegScan([1, 2, 3])))
      .toMatchObject({ scans: 1, scanMarkersAnywhere: 2 });
  });

  it('refuses structures it cannot parse or that jpeg-js could read another way', () => {
    const dqt = jpegSegment(0xdb, [0, ...new Array(64).fill(1)]);
    const dht = jpegSegment(0xc4, [0, 1, ...new Array(15).fill(0), 0x05]);
    expect(structure(dqt, dht, frame, jpegScan([1, 2, 3]))).not.toBeNull();
    const refused: Array<[string, Uint8Array]> = [
      ['no SOI', new Uint8Array([0xff, 0xd9])],
      ['no frame', jpegFromParts(jpegScan([1]))],
      ['no scan', jpegFromParts(frame)],
      ['two frames', jpegFromParts(frame, frame, jpegScan([1]))],
      ['a scan before the frame', jpegFromParts(jpegScan([1]), frame)],
      ['lossless SOF3', jpegFromParts(jpegFrame(64, 48, 3, 0xc3), jpegScan([1]))],
      ['arithmetic SOF9', jpegFromParts(jpegFrame(64, 48, 3, 0xc9), jpegScan([1]))],
      ['arithmetic conditioning DAC', jpegFromParts(jpegSegment(0xcc, [0, 0]), frame, jpegScan([1]))],
      ['a DNL marker', jpegFromParts(frame, jpegScan([1]), jpegSegment(0xdc, [0, 48]))],
      ['a stray RST between segments', jpegFromParts([0xff, 0xd0], frame, jpegScan([1]))],
      ['a scan naming a component not in the frame', jpegFromParts(frame, jpegScan([7]))],
      ['a scan naming a component twice', jpegFromParts(frame, jpegScan([1, 1]))],
      ['a DQT longer than its tables', jpegFromParts(jpegSegment(0xdb, [0, ...new Array(65).fill(1)]), frame, jpegScan([1]))],
      ['a DQT shorter than its table', jpegFromParts(jpegSegment(0xdb, [0, ...new Array(63).fill(1)]), frame, jpegScan([1]))],
      ['a DHT whose counts run past its length', jpegFromParts(jpegSegment(0xc4, [0, 9, ...new Array(15).fill(0), 1]), frame,
        jpegScan([1]))],
      ['an SOF whose length disagrees with its components', jpegFromParts([...jpegFrame(64, 48).slice(0, 3), 18,
        ...jpegFrame(64, 48).slice(4), 0], jpegScan([1]))],
      ['a DRI of the wrong length', jpegFromParts(jpegSegment(0xdd, [0, 4, 0]), frame, jpegScan([1]))],
      ['a segment running past the end', new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0x40, 0x00, 1, 2, 3])],
      ['bytes where a marker must be', jpegFromParts(frame, [0x00, 0x01], jpegScan([1]))],
      ['no EOI after the scan', jpegFromParts(frame, jpegScan([1])).subarray(0, -2)],
    ];
    for (const [name, bytes] of refused) {
      expect([name, jpegStructure(bytes)]).toEqual([name, null]);
      expect([name, decodable(bytes)]).toEqual([name, false]);
    }
  });

  it(`refuses a JPEG of more than ${ZOOM_JPEG_MAX_SCANS} scans before decoding it, baseline or progressive`, async () => {
    const page = syntheticJpeg(64, 48);
    const atLimit = withRepeatedScan(page, ZOOM_JPEG_MAX_SCANS);
    const overLimit = withRepeatedScan(page, ZOOM_JPEG_MAX_SCANS + 1);
    expect(jpegStructure(atLimit)).toMatchObject({ scans: ZOOM_JPEG_MAX_SCANS });
    expect(jpegStructure(overLimit)).toMatchObject({ scans: ZOOM_JPEG_MAX_SCANS + 1 });
    // At the limit: decoded (each scan again) and cropped.
    const allowed = createPageZoom({ mediaType: 'image/jpeg', bytes: atLimit, width: 64, height: 48 },
      { width: 64, height: 48 }, HIGH_RESOLUTION_TIER);
    expect(allowed.available()).toBe(true);
    await expect(allowed.crop({ x: 0, y: 0, w: 16, h: 16 }, 2)).resolves.toMatchObject({ kind: 'crop' });
    // Over it: never decoded. A progressive frame is held to the same count.
    const counted = countingRunner();
    const progressive = (scans: number) => jpegFromParts(jpegFrame(64, 48, 3, 0xc2),
      ...Array.from({ length: scans }, () => jpegScan([1])));
    expect(decodable(progressive(ZOOM_JPEG_MAX_SCANS))).toBe(true);
    for (const bytes of [overLimit, progressive(ZOOM_JPEG_MAX_SCANS + 1), progressive(5_000)]) {
      const zoom = createPageZoom({ mediaType: 'image/jpeg', bytes, width: 64, height: 48 }, { width: 64, height: 48 },
        HIGH_RESOLUTION_TIER, { runner: counted.runner });
      expect(zoom.available()).toBe(false);
      await expect(zoom.crop({ x: 0, y: 0, w: 16, h: 16 }, 2)).resolves.toEqual({ kind: 'unavailable' });
      expect(() => decodeRaster({ mediaType: 'image/jpeg', bytes, width: 64, height: 48 })).toThrow(/ZOOM_DECODE_LIMIT/);
    }
    // Scan markers hidden where the walk does not look (a comment, after EOI) count against the limit too.
    const hidden = Array.from({ length: ZOOM_JPEG_MAX_SCANS }, () => [0xff, 0xda]).flat();
    expect(decodable(jpegFromParts(jpegSegment(0xfe, hidden), frame, jpegScan([1])))).toBe(false);
    expect(decodable(new Uint8Array([...jpegFromParts(frame, jpegScan([1])), ...hidden]))).toBe(false);
    expect(counted.jobs).toEqual([]);
  }, 30_000);

  it('refuses 12-bit samples and any component count but 1 or 3 (CMYK, YCCK, two)', () => {
    expect(decodable(jpegFromParts(jpegFrame(64, 48, 1), jpegScan([1])))).toBe(true);
    expect(decodable(jpegFromParts(jpegFrame(64, 48, 3), jpegScan([1, 2, 3])))).toBe(true);
    expect(decodable(jpegFromParts(jpegFrame(64, 48, 3, 0xc1), jpegScan([1, 2, 3])))).toBe(true);
    expect(decodable(jpegFromParts(jpegFrame(64, 48, 3, 0xc1, 12), jpegScan([1, 2, 3])))).toBe(false);
    for (const components of [2, 4]) {
      const bytes = jpegFromParts(jpegFrame(64, 48, components), jpegScan([1]));
      expect(jpegStructure(bytes)).toMatchObject({ components });
      expect(decodable(bytes)).toBe(false);
    }
  });
});

describe('where jpeg-js and the marker walk could disagree (defence in depth)', () => {
  const frame = jpegFrame(64, 48);
  const scanWith = (entropy: number[]) => jpegFromParts(frame, jpegScan([1, 2, 3], entropy), jpegSegment(0xfe, [1, 2]));

  it('refuses, after a restart marker in scan data, 0x00 0xE0, 0x00 0xE1, 0xFF 0x00 and another restart marker', () => {
    for (const after of [[0x00, 0xe0], [0x00, 0xe1], [0xff, 0x00], [0xff, 0xd0], [0xff, 0xd7]]) {
      for (const rst of [0xd0, 0xd5]) {
        expect([after, jpegStructure(scanWith([0x12, 0xff, rst, ...after, 0, 6, 0, 0]))]).toEqual([after, null]);
      }
    }
    // Ordinary data after a restart marker, and those bytes elsewhere, are fine.
    expect(jpegStructure(scanWith([0x12, 0xff, 0xd0, 0x00, 0xe2, 0x00, 0xe0, 0, 6]))).toMatchObject({ scans: 1 });
    expect(jpegStructure(scanWith([0x12, 0xff, 0xd0, 0x34, 0xff, 0x00, 0xff, 0xd1, 0x56]))).toMatchObject({ scans: 1 });
  });

  it('refuses, after a stuffed 0xFF 0x00, a "malformed APP" recovery jump jpeg-js could take (its target is 0xFF)', () => {
    // 0x00 0xE0, distance 6: jpeg-js would check the byte 6 on from the distance, here the COM's 0xFF.
    expect(jpegStructure(jpegFromParts(frame, jpegScan([1, 2, 3], [0x12, 0xff, 0x00, 0x00, 0xe1, 0x00, 0x06, 0x01, 0x02,
      0x03, 0x04]), jpegSegment(0xfe, [1, 2])))).toBeNull();
    // The same bytes with a jump that would not land on 0xFF: jpeg-js would throw there, so the walk accepts them.
    expect(jpegStructure(jpegFromParts(frame, jpegScan([1, 2, 3], [0x12, 0xff, 0x00, 0x00, 0xe1, 0x00, 0x04, 0x01, 0x02,
      0x03, 0x04]), jpegSegment(0xfe, [1, 2])))).toMatchObject({ scans: 1 });
  });

  it('refuses the reviewer\'s layout (a second frame hidden behind a restart marker and 0x00 0xE0) before decoding', async () => {
    const counted = countingRunner();
    for (const [visible, hidden, components] of [[{ width: 16, height: 16 }, { width: 4_000, height: 3_125 }, 4],
      [{ width: 16, height: 16 }, { width: 4_000, height: 3_125 }, 3], [{ width: 512, height: 512 }, { width: 512,
        height: 512 }, 1]] as const) {
      const bytes = desyncJpeg(visible, hidden, components);
      expect(jpegStructure(bytes)).toBeNull();
      const page: ZoomSource = { mediaType: 'image/jpeg', bytes, ...visible };
      expect(zoomDecodable(page)).toBe(false);
      expect(() => decodeRaster(page)).toThrow(/ZOOM_DECODE_LIMIT/);
      const zoom = createPageZoom(page, visible, HIGH_RESOLUTION_TIER, { runner: counted.runner });
      expect(zoom.available()).toBe(false);
      await expect(zoom.crop({ x: 0, y: 0, w: 16, h: 16 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    }
    expect(counted.jobs).toEqual([]);
  });

  it('and were the walk fooled, jpeg-js\'s own limits from the checked frame refuse the hidden frame before allocating it', () => {
    // The checked frame as the walk reads it from the same layout without the desync (what it believed).
    const checked = (visible: { width: number; height: number }): JpegStructure => ({ frameMarker: 0xc0, precision: 8,
      ...visible, components: 3, scans: 1, scanMarkersAnywhere: 1, sampling: [{ h: 1, v: 1 }, { h: 1, v: 1 },
        { h: 1, v: 1 }], tableBytes: 256 + 2 * 17 });
    const rssBefore = process.memoryUsage().rss;
    // A tiny checked frame and a 12.5 MP hidden one: over jpeg-js's pixel limit at once.
    const tiny = desyncJpeg({ width: 16, height: 16 }, { width: 4_000, height: 3_125 }, 4);
    expect(() => decodeJpegWithin(tiny, checked({ width: 16, height: 16 }))).toThrow(/maxResolutionInMP/);
    // A hidden frame as large as the checked one, with more components: over jpeg-js's memory count.
    const same = desyncJpeg({ width: 1_024, height: 1_024 }, { width: 1_024, height: 1_024 }, 4);
    expect(() => decodeJpegWithin(same, checked({ width: 1_024, height: 1_024 }))).toThrow(/maxMemoryUsageInMB/);
    // Refused by count before the blocks are made (the 12.5 MP 4-component frame alone would be 800 MB of them).
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(100 * 1024 * 1024);
  });

  it('gives jpeg-js exactly the memory its own count needs for the checked frame, at every common sampling', () => {
    // syntheticJpeg is 4:2:0 from jpeg-js's encoder; the others are hand-built frames over all-zero entropy data.
    const zeroJpeg = (width: number, height: number, sampling: Array<[number, number]>) => {
      const body = [8, height >> 8, height & 0xff, width >> 8, width & 0xff, sampling.length];
      sampling.forEach(([h, v], index) => body.push(index + 1, h << 4 | v, 0));
      const counts = [1, ...new Array<number>(15).fill(0)];
      const maxH = Math.max(...sampling.map(([h]) => h));
      const maxV = Math.max(...sampling.map(([, v]) => v));
      const blocks = Math.ceil(width / 8 / maxH) * Math.ceil(height / 8 / maxV)
        * sampling.reduce((sum, [h, v]) => sum + h * v, 0);
      return jpegFromParts(jpegSegment(0xdb, [0, ...new Array<number>(64).fill(1)]),
        jpegSegment(0xc4, [0x00, ...counts, 0, 0x10, ...counts, 0x00]), jpegSegment(0xc0, body),
        jpegSegment(0xda, [sampling.length, ...sampling.flatMap((_, index) => [index + 1, 0]), 0, 63, 0]),
        new Array<number>(Math.ceil(blocks * 2 / 8) + 4).fill(0));
    };
    const pages = [syntheticJpeg(333, 251), zeroJpeg(333, 251, [[1, 1], [1, 1], [1, 1]]),
      zeroJpeg(333, 251, [[2, 2], [1, 1], [1, 1]]), zeroJpeg(333, 251, [[2, 1], [1, 1], [1, 1]]),
      zeroJpeg(101, 77, [[1, 1]]), zeroJpeg(250, 250, [[4, 2], [1, 1], [1, 1]])];
    for (const bytes of pages) {
      const structure = jpegStructure(bytes)!;
      expect(structure).not.toBeNull();
      const budget = jpegMemoryBudget(structure);
      const decodeWith = (bytesAllowed: number) => jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false,
        tolerantDecoding: false, maxMemoryUsageInMB: bytesAllowed / (1024 * 1024) });
      // Without the slack it still fits (the count is exact); a little less does not.
      expect(decodeWith(budget - ZOOM_JPEG_MEMORY_SLACK_BYTES + 1)).toMatchObject({ width: structure.width });
      expect(() => decodeWith(budget - ZOOM_JPEG_MEMORY_SLACK_BYTES - 64)).toThrow(/maxMemoryUsageInMB/);
      expect(decodeJpegWithin(bytes, structure)).toMatchObject({ width: structure.width, height: structure.height });
    }
  });
});

describe('PNG chunk checks before any inflate, and the inflate bounded by the checked header (defence in depth)', () => {
  const iend = pngChunk('IEND');
  /** Raw rows, filter byte 0 before each, deflated: an IDAT chunk. */
  const idatOf = (rows: readonly number[][]) => pngChunk('IDAT',
    zlib.deflateSync(Buffer.from(rows.flatMap((row) => [0, ...row]))));
  /** Zeros for a width x height picture of `channels` 8-bit samples, deflated: a tiny IDAT that inflates large. */
  const zerosIdat = (width: number, height: number, channels: number) =>
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc((width * channels + 1) * height), { level: 9 }));
  const page = (bytes: Uint8Array, width = 100, height = 100): ZoomSource =>
    ({ mediaType: 'image/png', bytes, width, height });
  /** pngjs's own full decode, composited over white the same way: the reference for decodeRaster. */
  const reference = (bytes: Uint8Array) => {
    const png = PNG.sync.read(Buffer.from(bytes));
    const rgb: number[] = [];
    for (let index = 0; index < png.width * png.height; index += 1) {
      const alpha = png.data[index * 4 + 3]!;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = png.data[index * 4 + channel]!;
        rgb.push(alpha === 255 ? value : Math.round((value * alpha + 255 * (255 - alpha)) / 255));
      }
    }
    return rgb;
  };

  it('refuses the reviewer\'s layout (a 100 x 100 IHDR, then a large second one) before inflating anything', async () => {
    const inflate = jest.spyOn(zlib, 'inflateSync');
    try {
      for (const interlace of [0, 1]) {
        const bytes = pngFromChunks(pngIhdr(100, 100), pngIhdr(2_000, 1_500, 8, 6, interlace), zerosIdat(2_000, 1_500, 4),
          iend);
        expect(pngStructure(bytes)).toBeNull();
        expect(zoomDecodable(page(bytes))).toBe(false);
        expect(() => decodeRaster(page(bytes))).toThrow(/ZOOM_DECODE_LIMIT/);
        const zoom = createPageZoom(page(bytes), { width: 100, height: 100 }, HIGH_RESOLUTION_TIER);
        expect(zoom.available()).toBe(false);
        await expect(zoom.crop({ x: 0, y: 0, w: 50, h: 50 }, 2)).resolves.toEqual({ kind: 'unavailable' });
      }
      // A second IHDR after the IDAT, too.
      expect(pngStructure(pngFromChunks(pngIhdr(100, 100), zerosIdat(100, 100, 3), pngIhdr(2_000, 1_500), iend)))
        .toBeNull();
      expect(inflate).not.toHaveBeenCalled();
    } finally { inflate.mockRestore(); }
  });

  it('and were the walk bypassed, inflates no more than the checked header needs and refuses the rest', () => {
    // The reviewer's layout, with the structure taken from the first IHDR as if the walk had passed it.
    const big = zerosIdat(2_000, 1_500, 4);
    const bytes = pngFromChunks(pngIhdr(100, 100), pngIhdr(2_000, 1_500, 8, 6), big, iend);
    const idatData = bytes.subarray(bytes.length - 12 - (big.length - 12) - 4, bytes.length - 12 - 4);
    expect(Buffer.from(idatData).equals(big.subarray(8, big.length - 4))).toBe(true);
    const bypassed = { width: 100, height: 100, bitDepth: 8, colourType: 2, interlaced: false, palette: null,
      transparency: null, idat: [idatData] };
    expect(pngInflatedSize(bypassed)).toBe(100 * (1 + 300));
    const inflate = jest.spyOn(zlib, 'inflateSync');
    try {
      expect(() => decodePngWithin(bypassed)).toThrow();
      expect(inflate).toHaveBeenCalledTimes(1);
      expect(inflate.mock.calls[0]![1]).toMatchObject({ maxOutputLength: 30_100 });
    } finally { inflate.mockRestore(); }
    // A clean walk whose IDAT inflates to more (or less) than its own IHDR needs: refused at the decode.
    for (const idat of [zerosIdat(2_000, 1_500, 3), zerosIdat(100, 99, 3), zerosIdat(100, 101, 3)]) {
      const lying = pngFromChunks(pngIhdr(100, 100), idat, iend);
      expect(zoomDecodable(page(lying))).toBe(true);
      expect(() => decodeRaster(page(lying))).toThrow();
    }
    // An interlaced or 16-bit structure is never decoded here, whatever the walk said.
    expect(() => decodePngWithin({ ...bypassed, interlaced: true })).toThrow(/ZOOM_DECODE_LIMIT/);
    expect(() => decodePngWithin({ ...bypassed, bitDepth: 16 })).toThrow(/ZOOM_DECODE_LIMIT/);
  });

  it('refuses unknown chunks, chunks out of place, cut short or with a bad CRC, and a missing IEND', () => {
    const ok = [pngIhdr(2, 1), idatOf([[1, 2, 3, 4, 5, 6]]), iend] as const;
    expect(pngStructure(pngFromChunks(...ok))).toMatchObject({ width: 2, height: 1, bitDepth: 8, colourType: 2 });
    const refused: Uint8Array[][] = [
      // An unknown critical chunk (uppercase first letter), Apple's CgBI, an unknown ancillary one, APNG's acTL.
      [ok[0], pngChunk('ABCD', [1]), ok[1], iend],
      [pngChunk('CgBI', [0, 0, 0, 0]), ...ok],
      [ok[0], pngChunk('prVt', [1]), ok[1], iend],
      [ok[0], pngChunk('acTL', [0, 0, 0, 1, 0, 0, 0, 0]), ok[1], iend],
      // IHDR not first; no IEND; no IDAT; IDATs not in one run.
      [pngChunk('tEXt', [0x61, 0, 0x62]), ...ok],
      [ok[0], ok[1]],
      [ok[0], iend],
      [ok[0], ok[1], pngChunk('tEXt', [0x61, 0, 0x62]), pngChunk('IDAT', []), iend],
      // PLTE for grey, PLTE after IDAT, two PLTEs, a palette picture without one, a palette not of whole entries.
      [pngIhdr(2, 1, 8, 0), pngChunk('PLTE', [0, 0, 0]), idatOf([[1, 2]]), iend],
      [pngIhdr(2, 1, 8, 3), idatOf([[0, 0]]), pngChunk('PLTE', [0, 0, 0]), iend],
      [pngIhdr(2, 1, 8, 3), pngChunk('PLTE', [0, 0, 0]), pngChunk('PLTE', [0, 0, 0]), idatOf([[0, 0]]), iend],
      [pngIhdr(2, 1, 8, 3), idatOf([[0, 0]]), iend],
      [pngIhdr(2, 1, 8, 3), pngChunk('PLTE', [0, 0, 0, 1]), idatOf([[0, 0]]), iend],
      [pngIhdr(2, 1, 1, 3), pngChunk('PLTE', [0, 0, 0, 1, 1, 1, 2, 2, 2]), idatOf([[0]]), iend],
      // tRNS of the wrong size, with alpha, or before PLTE.
      [pngIhdr(2, 1, 8, 0), pngChunk('tRNS', [0]), idatOf([[1, 2]]), iend],
      [pngIhdr(2, 1, 8, 6), pngChunk('tRNS', [0, 0]), idatOf([[1, 2, 3, 4, 5, 6, 7, 8]]), iend],
      [pngIhdr(2, 1, 8, 3), pngChunk('tRNS', [0]), pngChunk('PLTE', [0, 0, 0]), idatOf([[0, 0]]), iend],
      // A bit depth the colour type does not allow; another compression or filter method; interlace 2.
      [pngIhdr(2, 1, 4, 2), idatOf([[1, 2, 3]]), iend],
      [pngIhdr(2, 1, 16, 3), pngChunk('PLTE', [0, 0, 0]), idatOf([[0, 0, 0, 0]]), iend],
      [pngChunk('IHDR', [0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 1, 0, 0]), ok[1], iend],
      [pngChunk('IHDR', [0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 1, 0]), ok[1], iend],
      [pngIhdr(2, 1, 8, 2, 2), ok[1], iend],
    ];
    for (const chunks of refused) {
      const bytes = pngFromChunks(...chunks);
      expect(pngStructure(bytes)).toBeNull();
    }
    // Cut short anywhere, or a CRC off by one bit.
    const whole = pngFromChunks(...ok);
    for (const cut of [8, 20, 33, whole.length - 20, whole.length - 1]) {
      expect(pngStructure(whole.subarray(0, cut))).toBeNull();
    }
    const flipped = Buffer.from(whole);
    flipped[40]! ^= 1;
    expect(pngStructure(flipped)).toBeNull();
    // Known ancillary chunks, in their places, pass.
    expect(pngStructure(pngFromChunks(ok[0], pngChunk('gAMA', [0, 0, 0xb1, 0x8f]), pngChunk('pHYs', new Uint8Array(9)),
      ok[1], pngChunk('tEXt', [0x61, 0, 0x62]), iend))).not.toBeNull();
  });

  it('still decodes normal PNGs (RGB, RGBA, grey, grey and alpha, palette, 1-bit, tRNS) exactly as pngjs does', () => {
    const cases: Array<{ name: string; bytes: Uint8Array }> = [
      { name: 'RGB', bytes: pngFromChunks(pngIhdr(3, 2, 8, 2), idatOf([[255, 0, 0, 0, 255, 0, 0, 0, 255],
        [10, 20, 30, 40, 50, 60, 70, 80, 90]]), iend) },
      { name: 'RGBA', bytes: pngFromChunks(pngIhdr(2, 2, 8, 6), idatOf([[255, 0, 0, 255, 0, 0, 0, 0],
        [0, 0, 255, 128, 9, 9, 9, 255]]), iend) },
      { name: 'grey', bytes: pngFromChunks(pngIhdr(3, 1, 8, 0), idatOf([[0, 128, 255]]), iend) },
      { name: 'grey with tRNS', bytes: pngFromChunks(pngIhdr(3, 1, 8, 0), pngChunk('tRNS', [0, 128]),
        idatOf([[0, 128, 255]]), iend) },
      { name: 'grey and alpha', bytes: pngFromChunks(pngIhdr(2, 1, 8, 4), idatOf([[50, 255, 50, 0]]), iend) },
      { name: '1-bit grey', bytes: pngFromChunks(pngIhdr(10, 2, 1, 0), idatOf([[0b10110000, 0b01000000],
        [0b11111111, 0b11000000]]), iend) },
      { name: '2-bit palette with tRNS', bytes: pngFromChunks(pngIhdr(4, 1, 2, 3),
        pngChunk('PLTE', [255, 0, 0, 0, 255, 0, 0, 0, 255]), pngChunk('tRNS', [255, 0]), idatOf([[0b00011000]]), iend) },
      { name: '8-bit palette', bytes: pngFromChunks(pngIhdr(2, 2, 8, 3), pngChunk('PLTE', [1, 2, 3, 4, 5, 6]),
        idatOf([[0, 1], [1, 0]]), iend) },
      { name: 'RGB with tRNS', bytes: pngFromChunks(pngIhdr(2, 1, 8, 2), pngChunk('tRNS', [0, 1, 0, 2, 0, 3]),
        idatOf([[1, 2, 3, 4, 5, 6]]), iend) },
      // pngjs's own encoder, every row filter (sub, up, average, Paeth) tried: real filtered data.
      { name: 'pngjs RGBA, all filters', bytes: new Uint8Array(PNG.sync.write(Object.assign(new PNG({ width: 37, height: 23 }),
        { data: Buffer.from(Array.from({ length: 37 * 23 * 4 }, (_, index) => (index * 37) % 251)) }))) },
      { name: 'pngjs RGB', bytes: new Uint8Array(PNG.sync.write(Object.assign(new PNG({ width: 19, height: 11 }),
        { data: Buffer.from(Array.from({ length: 19 * 11 * 4 }, (_, index) => index % 4 === 3 ? 255 : (index * 13) % 256)) }),
        { colorType: 2 })) },
      { name: 'synthetic page', bytes: syntheticPng(64, 48) },
    ];
    for (const { name, bytes } of cases) {
      const structure = pngStructure(bytes);
      expect({ name, structure: structure !== null }).toEqual({ name, structure: true });
      const raster = decodeRaster(page(bytes, structure!.width, structure!.height));
      expect({ name, rgb: Array.from(raster.rgb) }).toEqual({ name, rgb: reference(bytes) });
    }
    // Spot checks: the 2-bit palette's first pixel is red (index 0, opaque), the second blue over white is not.
    const palette = decodeRaster(page(cases[6]!.bytes, 4, 1));
    expect(Array.from(palette.rgb.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(palette.rgb.subarray(3, 6))).toEqual([255, 255, 255]);
  });

  it('carries no picture data in its errors', () => {
    const marker = [0x5a, 0x51, 0x5a, 0x51, 0x5a, 0x51];
    const lying = pngFromChunks(pngIhdr(100, 100), pngChunk('IDAT', zlib.deflateSync(Buffer.from(
      Array.from({ length: 40_000 }, (_, index) => marker[index % marker.length]!)))), iend);
    try { decodeRaster(page(lying)); throw new Error('expected a refusal'); } catch (error) {
      const text = String(error) + String((error as Error).stack);
      expect(text).not.toContain('ZQZQ');
      expect(text).not.toContain(Buffer.from(lying.subarray(40, 60)).toString('base64'));
    }
  });
});

describe('zoom tool session', () => {
  const crop = { mediaType: 'image/png' as const, base64: 'Q1JPUA==', width: 64, height: 64,
    region: { x: 1, y: 2, w: 16, h: 16 }, scale: 4 };
  const fixed = (outcome: Awaited<ReturnType<PageZoom['crop']>>): PageZoom & { crop: jest.Mock } =>
    ({ available: () => true, crop: jest.fn(async () => outcome) });
  const call = (input: unknown, id = 'toolu_1', name = 'zoom') => ({ id, name, input });
  const good = { page: 1, box: { x: 1, y: 2, w: 16, h: 16 }, scale: 4 };

  it('declares a strict tool whose box is in the picture\'s pixels', () => {
    expect(ZOOM_TOOL).toMatchObject({ name: 'zoom', strict: true, input_schema: { required: ['page', 'box'],
      additionalProperties: false } });
    expect(ZOOM_TOOL.description).toContain('hard-to-read writing');
    expect(ZOOM_TOOL.description).toContain('picture\'s pixels');
    expect(JSON.stringify(ZOOM_TOOL.input_schema)).not.toMatch(/minimum|maximum/);
  });

  it('returns the crop as an image tool_result with its place in the picture', async () => {
    const zoom = fixed({ kind: 'crop', crop });
    const session = createZoomSession(zoom, 1, 8, 1_000);
    const result = await session.answer(call({ ...good, scale: undefined, box: good.box }));
    expect(zoom.crop).toHaveBeenCalledWith(good.box, 2, undefined);
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(result).not.toHaveProperty('is_error');
    const content = result.content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(String(content[0]!.text)).toContain('x 1, y 2, width 16, height 16');
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Q1JPUA==' } });
    expect(session.stats).toEqual({ calls: 1, limited: 0, failed: 0 });
  });

  it('passes the read\'s abort signal to the crop, so a shutdown ends a running decode or crop', async () => {
    const zoom = fixed({ kind: 'crop', crop });
    const signal = new AbortController().signal;
    await createZoomSession(zoom, 1, 8, 1_000).answer(call(good), signal);
    expect(zoom.crop).toHaveBeenCalledWith(good.box, 4, signal);
  });

  it('answers at most the call limit; every later call is told the limit is reached', async () => {
    const zoom = fixed({ kind: 'crop', crop });
    const session = createZoomSession(zoom, 1, 8, 1_000);
    const results = [];
    for (let index = 0; index < 9; index += 1) results.push(await session.answer(call(good, `toolu_${index}`)));
    expect(zoom.crop).toHaveBeenCalledTimes(8);
    expect(results.slice(0, 8).every((result) => result.is_error === undefined)).toBe(true);
    expect(results[8]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_8', is_error: true, content: ZOOM_LIMIT_MESSAGE });
    expect(session.stats).toEqual({ calls: 8, limited: 1, failed: 0 });
  });

  it('refuses malformed input, another page and an unknown tool as errors, never throwing or echoing input', async () => {
    const zoom = fixed({ kind: 'crop', crop });
    const session = createZoomSession(zoom, 1, 8, 1_000);
    const inputs: unknown[] = [null, 'zoom please', { page: 1 }, { page: 1, box: { x: 'a', y: 0, w: 1, h: 1 } },
      { ...good, extra: 'Test Patient' }, { ...good, box: { ...good.box, w: Number.NaN } }, { ...good, scale: 'big' }];
    for (const input of inputs) {
      const result = await session.answer(call(input));
      expect(result).toMatchObject({ is_error: true });
      expect(String(result.content)).not.toContain('Test Patient');
    }
    await expect(session.answer(call({ ...good, page: 2 }))).resolves.toMatchObject({ is_error: true,
      content: 'only page 1 can be zoomed' });
    await expect(session.answer(call(good, 'toolu_x', 'bash'))).resolves.toMatchObject({ is_error: true, content: 'unknown tool' });
    expect(zoom.crop).not.toHaveBeenCalled();
    expect(session.stats).toEqual({ calls: 0, limited: 0, failed: 9 });
  });

  it('tells the model zoom is unavailable when a crop fails or the box is bad, and the read goes on', async () => {
    const unavailable = createZoomSession(fixed({ kind: 'unavailable' }), 1, 8, 1_000);
    await expect(unavailable.answer(call(good))).resolves.toEqual({ type: 'tool_result', tool_use_id: 'toolu_1',
      is_error: true, content: ZOOM_UNAVAILABLE_MESSAGE });
    const throwing = createZoomSession({ available: () => true, crop: async () => { throw new Error('boom'); } }, 1, 8, 1_000);
    await expect(throwing.answer(call(good))).resolves.toMatchObject({ is_error: true, content: ZOOM_UNAVAILABLE_MESSAGE });
    const invalid = createZoomSession(fixed({ kind: 'invalid' }), 1, 8, 1_000);
    await expect(invalid.answer(call(good))).resolves.toMatchObject({ is_error: true,
      content: expect.stringContaining('invalid box') });
    expect([unavailable.stats, throwing.stats, invalid.stats].map((stats) => stats.failed)).toEqual([1, 1, 1]);
  });

  it('keeps the crops of one read within the request size budget beside the picture', async () => {
    const big = { ...crop, base64: 'A'.repeat(4_000_000) };
    const session = createZoomSession(fixed({ kind: 'crop', crop: big }), 1, 8, ZOOM_REQUEST_BASE64_BUDGET - 9_000_000);
    const results = [];
    for (let index = 0; index < 3; index += 1) results.push(await session.answer(call(good, `toolu_${index}`)));
    expect(results.map((result) => result.is_error === true)).toEqual([false, false, true]);
    expect(results[2]!.content).toBe(ZOOM_LIMIT_MESSAGE);
    expect(session.stats).toEqual({ calls: 2, limited: 1, failed: 0 });
  });
});
