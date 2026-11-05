import type Anthropic from '@anthropic-ai/sdk';
import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { base64Length, IMAGE_MAX_BASE64_LENGTH, pngDimensions, resizedSize, type ImageTier,
  type PageImageMediaType } from './page-image';

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
 * - Decoded only up to ZOOM_MAX_DECODE_PIXELS (24 MP, below the 64 MP the picture itself may have), and a PNG only
 *   at 8 bits or fewer per sample and not interlaced; both are checked from the header before anything is inflated
 *   or decoded. The decoders are synchronous and in memory, so these limits are what bound the memory and the
 *   event-loop stall of one decode (measured on fictional pages at 24 MP: a JPEG about 3 s and about 1 GB at its
 *   peak, a PNG under 1 s and about 400 MB; the RGB raster kept is 72 MB). One process decodes one page at a time.
 * - A decode that fails, exceeds those limits or the decoders' own, gives a size other than the header's, or takes
 *   longer than ZOOM_DECODE_TIME_LIMIT_MS turns zoom off for the page ("zoom unavailable"), never the reading.
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
 * A decode slower than this turns zoom off for the page. It is checked once the synchronous decode has finished, so
 * it does not cut the stall short (the pixel and bit-depth limits bound that); it keeps a slow page from being
 * decoded again and stops zoom on a worker too slow for it.
 */
export const ZOOM_DECODE_TIME_LIMIT_MS = 5_000;
/** One crop's resample and encode slower than this turns zoom off for the page (checked after it, as above). */
export const ZOOM_CROP_TIME_LIMIT_MS = 3_000;
/**
 * The most pixels zoom decodes (a 24 MP photo, 6000 x 4000; A4 at about 400 dpi). A larger picture is still sent
 * whole for the re-read; only zoom is off for it. Kept below the 64 MP picture limit on purpose: jpeg-js needs about
 * 20 MB of its own count (about 40 MB of process memory) per megapixel, too much at 64 MP for the 2 GiB task.
 */
export const ZOOM_MAX_DECODE_PIXELS = 24_000_000;
/** jpeg-js limits: never more pixels than ZOOM_MAX_DECODE_PIXELS, and memory to match (24 MP needs about 481 MB). */
export const ZOOM_JPEG_MAX_RESOLUTION_MP = ZOOM_MAX_DECODE_PIXELS / 1_000_000;
export const ZOOM_JPEG_MAX_MEMORY_MB = 640;
/** pngjs: at most 8 bits per sample (16-bit is inflated and widened far beyond the pixel count's share). */
export const ZOOM_PNG_MAX_BIT_DEPTH = 8;
/** One crop's PNG, base64: well inside the API's 10 MB per-image limit. */
export const ZOOM_MAX_CROP_BASE64 = 4_000_000;
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

/** An RGB raster, 3 bytes per pixel, rows top to bottom. */
export interface Raster { readonly width: number; readonly height: number; readonly rgb: Uint8Array }

export interface ZoomCrop { mediaType: 'image/png'; base64: string; width: number; height: number;
  /** The box cut, clamped to the picture, in the picture's pixels as the model sees it. */
  region: ZoomBox; scale: number }
export type ZoomOutcome = { kind: 'crop'; crop: ZoomCrop } | { kind: 'invalid' } | { kind: 'unavailable' };

/** A page's zoom: crops of its picture, decoded once. */
export interface PageZoom {
  crop(box: ZoomBox, scale: number): Promise<ZoomOutcome>;
}

/** The page picture as the worker verified it (page-image.ts PageImageDecision 'image'). */
export interface ZoomSource { mediaType: PageImageMediaType; bytes: Uint8Array; width: number; height: number }

export interface PageZoomOptions {
  /** Milliseconds, for the time limits; tests inject a clock. */
  now?: () => number;
  decodeTimeLimitMs?: number;
  cropTimeLimitMs?: number;
  /** Tests replace the decoder (a slow or failing one). */
  decode?: (source: ZoomSource) => Raster;
}

/**
 * Whether zoom may decode this picture, from its header alone: at most ZOOM_MAX_DECODE_PIXELS, and a PNG whose IHDR
 * gives at most ZOOM_PNG_MAX_BIT_DEPTH bits per sample and no interlacing (pngjs inflates an interlaced PNG
 * without a size limit).
 */
export function zoomDecodable(source: ZoomSource): boolean {
  if (source.width * source.height > ZOOM_MAX_DECODE_PIXELS) return false;
  if (source.mediaType !== 'image/png') return true;
  const size = pngDimensions(source.bytes);
  if (size === null || size.width * size.height > ZOOM_MAX_DECODE_PIXELS || source.bytes.length < 29) return false;
  // IHDR data from byte 16: width (4), height (4), bit depth, colour type, compression, filter, interlace.
  const bitDepth = source.bytes[24]!;
  const interlace = source.bytes[28]!;
  return bitDepth >= 1 && bitDepth <= ZOOM_PNG_MAX_BIT_DEPTH && interlace === 0;
}

/**
 * Decodes the exact stored bytes to RGB, within zoom's limits (zoomDecodable, checked first) and the decoders'.
 * Throws on any problem (never with pixels).
 */
export function decodeRaster(source: ZoomSource): Raster {
  if (!zoomDecodable(source)) throw new Error('ZOOM_DECODE_LIMIT');
  if (source.mediaType === 'image/jpeg') {
    const image = jpeg.decode(source.bytes, { useTArray: true, formatAsRGBA: false, tolerantDecoding: false,
      maxResolutionInMP: ZOOM_JPEG_MAX_RESOLUTION_MP, maxMemoryUsageInMB: ZOOM_JPEG_MAX_MEMORY_MB });
    if (image.data.length !== image.width * image.height * 3) throw new Error('ZOOM_DECODE_SHAPE');
    return { width: image.width, height: image.height, rgb: image.data };
  }
  const png = PNG.sync.read(Buffer.from(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength));
  const pixels = png.width * png.height;
  if (png.data.length !== pixels * 4) throw new Error('ZOOM_DECODE_SHAPE');
  // RGBA to RGB, any transparency over white (paper).
  const rgb = new Uint8Array(pixels * 3);
  for (let index = 0; index < pixels; index += 1) {
    const alpha = png.data[index * 4 + 3]!;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = png.data[index * 4 + channel]!;
      rgb[index * 3 + channel] = alpha === 255 ? value : Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return { width: png.width, height: png.height, rgb };
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

/** Resamples a rectangle of the raster to width x height: area averaging where smaller on both axes, else bilinear. */
export function resample(raster: Raster, rect: { x: number; y: number; w: number; h: number }, width: number,
  height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  const sx = rect.w / width;
  const sy = rect.h / height;
  const pixel = (x: number, y: number, channel: number) => raster.rgb[(y * raster.width + x) * 3 + channel]!;
  if (sx > 1 && sy > 1) {
    for (let oy = 0; oy < height; oy += 1) {
      const ya = rect.y + Math.floor(oy * sy);
      const yb = Math.max(ya + 1, rect.y + Math.floor((oy + 1) * sy));
      for (let ox = 0; ox < width; ox += 1) {
        const xa = rect.x + Math.floor(ox * sx);
        const xb = Math.max(xa + 1, rect.x + Math.floor((ox + 1) * sx));
        const count = (xb - xa) * (yb - ya);
        for (let channel = 0; channel < 3; channel += 1) {
          let sum = 0;
          for (let y = ya; y < yb; y += 1) for (let x = xa; x < xb; x += 1) sum += pixel(x, y, channel);
          out[(oy * width + ox) * 3 + channel] = Math.round(sum / count);
        }
      }
    }
    return out;
  }
  const maxX = rect.x + rect.w - 1;
  const maxY = rect.y + rect.h - 1;
  for (let oy = 0; oy < height; oy += 1) {
    // Pixel centres: output centre (oy + 0.5) maps to source (oy + 0.5) * sy - 0.5 within the rectangle.
    const fy = Math.min(maxY, Math.max(rect.y, rect.y + (oy + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(maxY, y0 + 1);
    const wy = fy - y0;
    for (let ox = 0; ox < width; ox += 1) {
      const fx = Math.min(maxX, Math.max(rect.x, rect.x + (ox + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(maxX, x0 + 1);
      const wx = fx - x0;
      for (let channel = 0; channel < 3; channel += 1) {
        const top = pixel(x0, y0, channel) * (1 - wx) + pixel(x1, y0, channel) * wx;
        const bottom = pixel(x0, y1, channel) * (1 - wx) + pixel(x1, y1, channel) * wx;
        out[(oy * width + ox) * 3 + channel] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return out;
}

/** RGB pixels to a PNG (8-bit RGB, no alpha). */
export function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const png = new PNG({ width, height, colorType: 2, inputColorType: 2, inputHasAlpha: false });
  png.data = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength);
  return PNG.sync.write(png, { colorType: 2, inputColorType: 2, inputHasAlpha: false, deflateLevel: 6 });
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * A page's zoom over its verified picture. `seen` is the picture's size as the model sees it (resizedSize for
 * `tier`). The raster is decoded on the first crop and kept for the reading; a decode problem or a time limit turns
 * zoom off for this page for good (every later call: unavailable).
 */
export function createPageZoom(source: ZoomSource, seen: { width: number; height: number }, tier: ImageTier,
  options: PageZoomOptions = {}): PageZoom {
  const now = options.now ?? (() => performance.now());
  const decodeLimit = options.decodeTimeLimitMs ?? ZOOM_DECODE_TIME_LIMIT_MS;
  const cropLimit = options.cropTimeLimitMs ?? ZOOM_CROP_TIME_LIMIT_MS;
  const decode = options.decode ?? decodeRaster;
  let raster: Raster | null | undefined;
  let off = false;
  const load = (): Raster | null => {
    if (raster !== undefined) return raster;
    // Over zoom's limits by the header: never decoded at all.
    if (!zoomDecodable(source)) { raster = null; return raster; }
    const started = now();
    try {
      const decoded = decode(source);
      // The header's size (checked against the picture limits) must be what was decoded.
      raster = decoded.width === source.width && decoded.height === source.height ? decoded : null;
    } catch {
      raster = null;
    }
    if (now() - started > decodeLimit) raster = null;
    return raster;
  };
  return {
    async crop(box, scale) {
      if (off) return { kind: 'unavailable' };
      if (!Number.isFinite(scale) || scale < 1 || scale > ZOOM_MAX_SCALE) return { kind: 'invalid' };
      const region = clampBox(box, seen);
      if (region === null) return { kind: 'invalid' };
      const decoded = load();
      if (decoded === null) { off = true; return { kind: 'unavailable' }; }
      const started = now();
      try {
        const rect = toOriginalRect(region, seen, decoded);
        let size = zoomOutputSize(region, scale, tier);
        for (let tries = 0; tries < 6; tries += 1) {
          const png = encodePng(resample(decoded, rect, size.width, size.height), size.width, size.height);
          if (now() - started > cropLimit) { off = true; raster = null; return { kind: 'unavailable' }; }
          if (base64Length(png.byteLength) <= Math.min(ZOOM_MAX_CROP_BASE64, IMAGE_MAX_BASE64_LENGTH)) {
            return { kind: 'crop', crop: { mediaType: 'image/png', base64: png.toString('base64'), width: size.width,
              height: size.height, region: { x: round1(region.x), y: round1(region.y), w: round1(region.w),
                h: round1(region.h) }, scale } };
          }
          // Too large an image (busy writing, a large box): the same view smaller.
          size = { width: Math.max(1, Math.floor(size.width * 0.75)), height: Math.max(1, Math.floor(size.height * 0.75)) };
        }
        return { kind: 'unavailable' };
      } catch {
        off = true;
        return { kind: 'unavailable' };
      }
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
  /** The tool_result for one tool call. Never throws; never echoes the input. */
  answer(call: ToolCall): Promise<Anthropic.ToolResultBlockParam>;
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
    async answer(call) {
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
        outcome = await zoom.crop(input.data.box, input.data.scale ?? ZOOM_DEFAULT_SCALE);
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
