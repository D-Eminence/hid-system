import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { resizedSize, type ImageTier } from './page-image';
import { zoomWorkerRunner, type ZoomJobRunner } from './zoom-jobs';
import { ZOOM_MAX_CROP_BASE64, zoomDecodable, type Raster, type ZoomSource } from './zoom-raster';

export * from './zoom-raster';

/**
 * ZOOM (owner decision of 2026-11-05, about 18:45 UTC, "Zoom in our reader (Recommended)"; Anthropic's code-execution
 * sandbox was declined because it keeps page photos for up to 30 days). During each of a hard page's two best-guess
 * reads (reader.ts, readHard) the model may call a client tool, zoom(page, box, scale): the worker cuts the box out
 * of the same verified bytes the page picture came from, enlarges it and returns it as an image tool_result. The crop
 * is made here, in memory, from pure-JS decoders (jpeg-js, pngjs): it is never logged, stored or put in an error, and
 * it goes only to the same Claude API request (US only) the picture itself goes to.
 *
 * - Decoded only for a page already eligible for the image re-read (page-image.ts pageImageFor: one-page PNG or JPEG,
 *   10 MB base64, 8000 x 8000 px, an upright JPEG), and only on the first zoom call; once per page, shared by both
 *   reads of the page, and dropped with the reading.
 * - Decoded only within limits checked from the bytes before anything is inflated or decoded (zoomDecodable): a PNG
 *   up to ZOOM_MAX_DECODE_PIXELS (24 MP), at 8 bits or fewer per sample and not interlaced; a JPEG up to
 *   ZOOM_JPEG_MAX_DECODE_PIXELS (12.5 MP), whose marker segments parse (jpegStructure) with one 8-bit baseline,
 *   extended or progressive Huffman frame of 1 or 3 components and at most ZOOM_JPEG_MAX_SCANS scans, with none of
 *   the byte patterns where jpeg-js would find markers the walk did not (zoom-raster.ts). jpeg-js is also given its
 *   own pixel and memory limits from that checked frame, so a frame it found anywhere else is refused by its own count
 *   before its blocks are allocated. A page that fails these checks is not offered the tool at all (reader.ts).
 * - Every decode and every crop runs in a worker thread of its own (zoom-jobs.ts), one at a time in the process,
 *   ended by worker.terminate() when it takes longer than ZOOM_DECODE_TIME_LIMIT_MS or ZOOM_CROP_TIME_LIMIT_MS or the
 *   job is aborted, under V8 heap limits: the main event loop never stalls on it (measured on fictional pages at the
 *   limits: a JPEG at worst about 3 s and 570 MB peak RSS in the worker, a PNG at worst about 1.3 s and 430 MB; the
 *   RGB raster kept is at most 72 MB).
 * - A decode or crop that fails, is terminated, exceeds a limit, or gives a size other than the header's turns zoom
 *   off for the page ("zoom unavailable"), never the reading.
 * - The box is in the pixels of the picture AS THE MODEL SEES IT (resizedSize for the model's tier: the same frame as
 *   the line boxes and the answer boxes) and is mapped back to the original pixels before cutting.
 * - The crop is enlarged by `scale` (1-4, default 2) relative to the picture as the model sees it, with bilinear
 *   filtering (area averaging where it is in fact made smaller), and capped so it is never resized by the API
 *   (within the tier's edge and token limits), then encoded as PNG and held to ZOOM_MAX_CROP_BASE64.
 */
export const ZOOM_TOOL_NAME = 'zoom';
export const ZOOM_DEFAULT_SCALE = 2;
export const ZOOM_MAX_SCALE = 4;
/** The most zoom calls one read may make (OCR_AI_ZOOM_MAX_CALLS may lower it). */
export const ZOOM_MAX_CALLS = 8;
/** The smallest box (after clamping to the picture), in the picture's pixels as the model sees it. */
export const ZOOM_MIN_BOX_PX = 8;
/**
 * A decode not answered within this (from when its worker is ready) is ended with worker.terminate() and turns zoom
 * off for the page.
 */
export const ZOOM_DECODE_TIME_LIMIT_MS = 5_000;
/** One crop's resample and encode, likewise (terminated, then zoom off for the page). */
export const ZOOM_CROP_TIME_LIMIT_MS = 3_000;
/**
 * All crops of one read together, base64, beside the page picture: the Claude API takes at most 32 MB per request
 * and every crop is sent again on each later turn of the read. 30,000,000 less the picture, so 2 MB stays for the
 * text, the thinking and the JSON.
 */
export const ZOOM_REQUEST_BASE64_BUDGET = 30_000_000;

export const ZOOM_LIMIT_MESSAGE = 'zoom limit reached; finish your answer';
export const ZOOM_UNAVAILABLE_MESSAGE = 'zoom unavailable';

export interface ZoomBox { x: number; y: number; w: number; h: number }

/** The tool as declared to the model (hard-page reads only). Strict: the API holds the input to the schema. */
export const ZOOM_TOOL: Anthropic.Tool = {
  name: ZOOM_TOOL_NAME,
  description: 'Look closer at part of the page picture. Returns an enlarged view of the box you give, cut from the '
    + 'same picture. Use it to look closer at hard-to-read writing (a drug name, a dose, a number, a word) before you '
    + 'answer. "page" is the page number of this picture. "box" is in the picture\'s pixels, the same pixels as the line '
    + 'boxes and the boxes in your answer: x and y the top-left corner, w and h the width and height. "scale" is how '
    + 'much to enlarge it, from 1 to 4 (2 when not given). The boxes in your answer stay in the full picture\'s pixels, '
    + 'never in the enlarged view\'s.',
  strict: true,
  input_schema: {
    type: 'object', additionalProperties: false, required: ['page', 'box'],
    properties: {
      page: { type: 'integer', description: 'The page number of this picture.' },
      box: { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'], description:
        'The part of the picture to look at, in the picture\'s pixels.',
      properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
      scale: { type: 'number', description: 'How much to enlarge, 1 to 4 (default 2).' },
    },
  },
};

/** The tool input, checked in code as well (a tool input is never trusted, strict or not). */
const zoomInputSchema = z.strictObject({
  page: z.number().int(),
  box: z.strictObject({ x: z.number().finite(), y: z.number().finite(), w: z.number().finite(), h: z.number().finite() }),
  scale: z.number().finite().optional(),
});


export interface ZoomCrop { mediaType: 'image/png'; base64: string; width: number; height: number;
  /** The box cut, clamped to the picture, in the picture's pixels as the model sees it. */
  region: ZoomBox; scale: number }
export type ZoomOutcome = { kind: 'crop'; crop: ZoomCrop } | { kind: 'invalid' } | { kind: 'unavailable' };

/** A page's zoom: crops of its picture, decoded once. */
export interface PageZoom {
  /**
   * Whether the picture passes zoom's checks from its bytes (zoomDecodable, worked out once). A page that does not
   * is never offered the tool.
   */
  available(): boolean;
  /** One crop; an abort (shutdown) ends its worker at once, and the answer is then "unavailable". */
  crop(box: ZoomBox, scale: number, signal?: AbortSignal): Promise<ZoomOutcome>;
}


export interface PageZoomOptions {
  decodeTimeLimitMs?: number;
  cropTimeLimitMs?: number;
  /** How the decode and crops run: in worker threads (zoom-jobs.ts) by default; tests count, slow or fail them. */
  runner?: ZoomJobRunner;
}


/**
 * The box clamped to the picture as the model sees it (`seen`), or null when a number is not finite, the box has no
 * positive width or height, or what is left inside the picture is under ZOOM_MIN_BOX_PX on either side.
 */
export function clampBox(box: ZoomBox, seen: { width: number; height: number }): ZoomBox | null {
  const values = [box.x, box.y, box.w, box.h];
  if (!values.every(Number.isFinite) || !(box.w > 0) || !(box.h > 0)) return null;
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(seen.width, box.x + box.w);
  const bottom = Math.min(seen.height, box.y + box.h);
  if (right - left < ZOOM_MIN_BOX_PX || bottom - top < ZOOM_MIN_BOX_PX) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The clamped box in the original picture's pixels (the decoded raster): scaled by original / seen on each axis,
 * widened outwards to whole pixels, kept inside the picture and at least one pixel.
 */
export function toOriginalRect(box: ZoomBox, seen: { width: number; height: number },
  original: { width: number; height: number }): { x: number; y: number; w: number; h: number } {
  const sx = original.width / seen.width;
  const sy = original.height / seen.height;
  const x0 = Math.min(original.width - 1, Math.max(0, Math.floor(box.x * sx + 1e-9)));
  const y0 = Math.min(original.height - 1, Math.max(0, Math.floor(box.y * sy + 1e-9)));
  const x1 = Math.max(x0 + 1, Math.min(original.width, Math.ceil((box.x + box.w) * sx - 1e-9)));
  const y1 = Math.max(y0 + 1, Math.min(original.height, Math.ceil((box.y + box.h) * sy - 1e-9)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The size the crop is shown at: the clamped box (in the picture's pixels as seen) times `scale`, then made to fit
 * the tier so the API never resizes it again (resizedSize leaves a fitting size as it is), at least 1 x 1.
 */
export function zoomOutputSize(box: ZoomBox, scale: number, tier: ImageTier): { width: number; height: number } {
  const width = Math.max(1, Math.round(box.w * scale));
  const height = Math.max(1, Math.round(box.h * scale));
  return resizedSize(width, height, tier);
}


const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * A page's zoom over its verified picture. `seen` is the picture's size as the model sees it (resizedSize for
 * `tier`). The raster is decoded on the first crop and kept for the reading (moved to each crop's worker and back);
 * a decode or crop problem, a time limit or an abort turns zoom off for this page for good (every later call:
 * unavailable). Calls on one page run one after another (both reads share the raster).
 */
export function createPageZoom(source: ZoomSource, seen: { width: number; height: number }, tier: ImageTier,
  options: PageZoomOptions = {}): PageZoom {
  const decodeLimit = options.decodeTimeLimitMs ?? ZOOM_DECODE_TIME_LIMIT_MS;
  const cropLimit = options.cropTimeLimitMs ?? ZOOM_CROP_TIME_LIMIT_MS;
  const runner = options.runner ?? zoomWorkerRunner;
  let raster: Raster | null | undefined;
  let off = false;
  let decodable: boolean | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const available = () => (decodable ??= zoomDecodable(source));
  const load = async (signal?: AbortSignal): Promise<Raster | null> => {
    if (raster !== undefined) return raster;
    // Over zoom's limits by the header: never decoded at all.
    if (!available()) { raster = null; return raster; }
    try {
      const answer = await runner({ kind: 'decode', source }, decodeLimit, signal);
      // The header's size (checked against the picture limits) must be what was decoded.
      raster = answer.kind === 'decode' && answer.width === source.width && answer.height === source.height
        && answer.rgb.byteLength === source.width * source.height * 3
        ? { width: answer.width, height: answer.height, rgb: new Uint8Array(answer.rgb) } : null;
    } catch {
      raster = null;
    }
    return raster;
  };
  const cropNow = async (box: ZoomBox, scale: number, signal?: AbortSignal): Promise<ZoomOutcome> => {
    if (off) return { kind: 'unavailable' };
    if (!Number.isFinite(scale) || scale < 1 || scale > ZOOM_MAX_SCALE) return { kind: 'invalid' };
    const region = clampBox(box, seen);
    if (region === null) return { kind: 'invalid' };
    const decoded = await load(signal);
    if (decoded === null) { off = true; return { kind: 'unavailable' }; }
    try {
      const rect = toOriginalRect(region, seen, decoded);
      const size = zoomOutputSize(region, scale, tier);
      // The raster goes to the worker (moved, not copied) and comes back with the answer.
      raster = null;
      const answer = await runner({ kind: 'crop', width: decoded.width, height: decoded.height,
        rgb: decoded.rgb.buffer as ArrayBuffer, rect, outWidth: size.width, outHeight: size.height,
        maxBase64: ZOOM_MAX_CROP_BASE64 }, cropLimit, signal);
      if (answer.kind !== 'crop' || answer.rgb.byteLength !== decoded.width * decoded.height * 3) throw new Error();
      raster = { width: decoded.width, height: decoded.height, rgb: new Uint8Array(answer.rgb) };
      // Too large an image even at its smallest try: this call only.
      if (answer.png === null) return { kind: 'unavailable' };
      return { kind: 'crop', crop: { mediaType: 'image/png', base64: Buffer.from(answer.png).toString('base64'),
        width: answer.width, height: answer.height, region: { x: round1(region.x), y: round1(region.y),
          w: round1(region.w), h: round1(region.h) }, scale } };
    } catch {
      off = true;
      raster = null;
      return { kind: 'unavailable' };
    }
  };
  return {
    available,
    crop(box, scale, signal) {
      const next = queue.then(() => cropNow(box, scale, signal));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** Counts only, for the logs. */
export interface ZoomStats {
  /** Zoom calls answered with a crop. */
  calls: number;
  /** Zoom calls refused because the read's call limit or the request size budget was reached. */
  limited: number;
  /** Zoom calls answered "zoom unavailable" or refused for malformed input, a wrong page or an unknown tool. */
  failed: number;
}
export const noZoomStats = (): ZoomStats => ({ calls: 0, limited: 0, failed: 0 });

/** What a tool_use block carries (the SDK's ToolUseBlock). */
export interface ToolCall { id: string; name: string; input: unknown }

/** One read's zoom tool: the per-read call limit, the request size budget and the counts. */
export interface ZoomToolSession {
  readonly maxCalls: number;
  readonly stats: ZoomStats;
  /** The tool_result for one tool call. Never throws; never echoes the input. An abort ends a running crop. */
  answer(call: ToolCall, signal?: AbortSignal): Promise<Anthropic.ToolResultBlockParam>;
}

const errorResult = (id: string, text: string): Anthropic.ToolResultBlockParam =>
  ({ type: 'tool_result', tool_use_id: id, is_error: true, content: text });

/**
 * A session for one read of `page`: at most `maxCalls` zoom calls (each call counts, answered or not; beyond it
 * every call gets ZOOM_LIMIT_MESSAGE), and crops together within the request budget beside a picture of
 * `pictureBase64Length`.
 */
export function createZoomSession(zoom: PageZoom, page: number, maxCalls: number, pictureBase64Length: number):
  ZoomToolSession {
  const stats = noZoomStats();
  let requested = 0;
  let used = 0;
  const budget = Math.max(0, ZOOM_REQUEST_BASE64_BUDGET - pictureBase64Length);
  return {
    maxCalls,
    stats,
    async answer(call, signal) {
      if (call.name !== ZOOM_TOOL_NAME) { stats.failed += 1; return errorResult(call.id, 'unknown tool'); }
      requested += 1;
      if (requested > maxCalls) { stats.limited += 1; return errorResult(call.id, ZOOM_LIMIT_MESSAGE); }
      const input = zoomInputSchema.safeParse(call.input);
      if (!input.success) {
        stats.failed += 1;
        return errorResult(call.id, 'invalid zoom input: give page, box {x, y, w, h} in the picture\'s pixels, scale 1 to 4');
      }
      if (input.data.page !== page) { stats.failed += 1; return errorResult(call.id, `only page ${page} can be zoomed`); }
      let outcome: ZoomOutcome;
      try {
        outcome = await zoom.crop(input.data.box, input.data.scale ?? ZOOM_DEFAULT_SCALE, signal);
      } catch {
        outcome = { kind: 'unavailable' };
      }
      if (outcome.kind === 'invalid') {
        stats.failed += 1;
        return errorResult(call.id, `invalid box: give a box inside the picture, at least ${ZOOM_MIN_BOX_PX} pixels on each `
          + `side, and a scale from 1 to ${ZOOM_MAX_SCALE}`);
      }
      if (outcome.kind === 'unavailable') { stats.failed += 1; return errorResult(call.id, ZOOM_UNAVAILABLE_MESSAGE); }
      const { crop } = outcome;
      if (used + crop.base64.length > budget) { stats.limited += 1; return errorResult(call.id, ZOOM_LIMIT_MESSAGE); }
      used += crop.base64.length;
      stats.calls += 1;
      return { type: 'tool_result', tool_use_id: call.id, content: [
        { type: 'text', text: `Enlarged view of the box x ${crop.region.x}, y ${crop.region.y}, width ${crop.region.w}, `
          + `height ${crop.region.h} of the picture, shown at ${crop.width} x ${crop.height} pixels. Give every box in `
          + 'your answer in the full picture\'s pixels, not in this view\'s.' },
        { type: 'image', source: { type: 'base64', media_type: crop.mediaType, data: crop.base64 } },
      ] };
    },
  };
}
