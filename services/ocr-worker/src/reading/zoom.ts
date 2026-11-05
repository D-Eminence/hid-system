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
 * - Decoded only within limits checked from the bytes before anything is inflated or decoded (zoomDecodable): a PNG
 *   up to ZOOM_MAX_DECODE_PIXELS (24 MP), at 8 bits or fewer per sample and not interlaced; a JPEG up to
 *   ZOOM_JPEG_MAX_DECODE_PIXELS (12.5 MP), whose marker segments parse (jpegStructure) with one 8-bit baseline,
 *   extended or progressive Huffman frame of 1 or 3 components and at most ZOOM_JPEG_MAX_SCANS scans. The decoders are
 *   synchronous and in memory, so these limits are what bound the memory and the event-loop stall of one decode
 *   (measured on fictional pages at the limits: a JPEG at worst about 3 s and 570 MB peak RSS, a PNG at worst about
 *   1.3 s and 430 MB; the RGB raster kept is at most 72 MB). One process decodes one page at a time. A page that fails
 *   these checks is not offered the tool at all (reader.ts).
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
 * it does not cut the stall short (the checks made before decoding bound that); it keeps a slow page from being
 * decoded again and stops zoom on a worker too slow for it.
 */
export const ZOOM_DECODE_TIME_LIMIT_MS = 5_000;
/** One crop's resample and encode slower than this turns zoom off for the page (checked after it, as above). */
export const ZOOM_CROP_TIME_LIMIT_MS = 3_000;
/**
 * The most pixels zoom decodes from a PNG (a 24 MP page, 6000 x 4000; A4 at about 400 dpi). A larger picture is
 * still sent whole for the re-read; only zoom is off for it. Kept below the 64 MP picture limit on purpose. Measured
 * on fictional pages at 24 MP (8-bit RGBA, the heaviest PNG allowed): about 0.8 to 1.3 s and 350 to 430 MB peak RSS.
 */
export const ZOOM_MAX_DECODE_PIXELS = 24_000_000;
/**
 * The most pixels zoom decodes from a JPEG: 12.5 MP (4000 x 3125, or 4096 x 3051; a 12 MP phone photo, 4032 x 3024
 * or 4000 x 3000, fits; A4 at about 350 dpi). Lower than the PNG limit because jpeg-js is slower and larger per pixel: measured on
 * fictional pages (Node 22, one core), the worst case allowed at 12.5 MP (three components at 4:4:4, ZOOM_JPEG_MAX_SCANS
 * scans, noise filling the 10 MB base64 picture limit) took 2.7 to 3.0 s and about 570 MB peak RSS; a flat page of 16
 * scans 1.4 to 1.7 s. At the old 24 MP limit a baseline JPEG alone took 2.8 s and about 970 MB, a progressive one up to
 * 5 s, and with no limit on scans a small file could take minutes (jpeg-js walks every block in every scan).
 */
export const ZOOM_JPEG_MAX_DECODE_PIXELS = 12_500_000;
/** jpeg-js limits: never more pixels than ZOOM_JPEG_MAX_DECODE_PIXELS, and memory to match (its own count). */
export const ZOOM_JPEG_MAX_RESOLUTION_MP = ZOOM_JPEG_MAX_DECODE_PIXELS / 1_000_000;
export const ZOOM_JPEG_MAX_MEMORY_MB = 400;
/**
 * The most scans (SOS segments) zoom lets jpeg-js decode in one JPEG. jpeg-js walks every block of the scan's
 * components in every scan, data or not, so the decode time grows with the scan count, not the file size. 16: a
 * baseline JPEG has 1 scan (3 if not interleaved), libjpeg's standard progressive script 10 for colour and 6 for grey
 * (as measured on its output); 16 leaves room for other encoders' scripts and for an EXIF thumbnail or two (counted
 * too: see jpegStructure) and holds the worst case to the times measured above.
 */
export const ZOOM_JPEG_MAX_SCANS = 16;
/**
 * The most colour components zoom decodes in a JPEG: 1 (grey) or 3 (YCbCr or RGB). A 4-component (CMYK or Adobe
 * YCCK) JPEG is refused: measured at 24 MP it peaked at about 1.25 GB RSS (680 MB at 12.5 MP), and paper photos are not
 * CMYK. 2 components is not a JPEG colour model jpeg-js converts either.
 */
export const ZOOM_JPEG_ALLOWED_COMPONENTS: readonly number[] = [1, 3];
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
  /**
   * Whether the picture passes zoom's checks from its bytes (zoomDecodable, worked out once). A page that does not
   * is never offered the tool.
   */
  available(): boolean;
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

/** A JPEG's frame and scan count, as jpegStructure reads them. */
export interface JpegStructure {
  /** The frame's SOF marker: 0xC0 baseline, 0xC1 extended, 0xC2 progressive (all Huffman coded). */
  frameMarker: number;
  precision: number;
  width: number;
  height: number;
  components: number;
  /** SOS segments in the marker walk, up to EOI. */
  scans: number;
  /** Every 0xFF 0xDA byte pair anywhere in the bytes (an upper bound on what any decoder could take as a scan). */
  scanMarkersAnywhere: number;
}

/**
 * Walks a JPEG's marker segments from SOI to EOI without decoding anything, or null when the structure is not one
 * zoom trusts jpeg-js to follow the same way:
 * - every segment's length is read and must fit the bytes; DQT, DHT, SOF, DRI and SOS must be exactly as long as
 *   their contents (jpeg-js reads those by their contents, not their lengths, so a length that disagrees would put
 *   it somewhere else in the file);
 * - only APPn, COM, DQT, DHT, DRI, SOF0-SOF2 and SOS segments, fill bytes before a marker, and EOI; any other marker
 *   (another SOF type, arithmetic coding, DNL, a stray SOI or RST) and anything that is not a marker where one must
 *   be gives null;
 * - exactly one frame, before the first scan, with 1 to 4 components of sampling factors 1 to 4 and distinct ids;
 *   each scan names 1 to 4 of the frame's components;
 * - after each SOS header the entropy-coded data is skipped to the next marker: 0xFF 0x00 is a stuffed byte and
 *   0xFF 0xD0-0xD7 a restart marker, both inside the scan; the bytes must end with EOI.
 * scanMarkersAnywhere also counts 0xFF 0xDA inside other segments (an EXIF thumbnail's scan, say) and after EOI, so a
 * limit on it holds even were jpeg-js to resynchronise somewhere the walk did not.
 */
export function jpegStructure(bytes: Uint8Array): JpegStructure | null {
  const length = bytes.length;
  if (length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  let frame: Omit<JpegStructure, 'scans' | 'scanMarkersAnywhere'> | null = null;
  const ids = new Set<number>();
  let scans = 0;
  let at = 2;
  for (;;) {
    if (at + 1 >= length || bytes[at] !== 0xff) return null;
    // Fill bytes: any number of 0xFF before the marker.
    while (at + 1 < length && bytes[at + 1] === 0xff) at += 1;
    if (at + 1 >= length) return null;
    const marker = bytes[at + 1]!;
    at += 2;
    if (marker === 0xd9) break;
    const known = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe || marker === 0xdb || marker === 0xc4
      || marker === 0xdd || marker === 0xda || (marker >= 0xc0 && marker <= 0xc2);
    if (!known || at + 2 > length) return null;
    const size = u16(at);
    const start = at + 2;
    const end = at + size;
    if (size < 2 || end > length) return null;
    if (marker === 0xdb) {
      // DQT: tables of 1 + 64 bytes (8-bit) or 1 + 128 (16-bit), filling the segment exactly.
      let p = start;
      while (p < end) {
        const precision = bytes[p]! >> 4;
        if (precision > 1 || (bytes[p]! & 15) > 3) return null;
        p += 1 + 64 * (precision + 1);
      }
      if (p !== end) return null;
    } else if (marker === 0xc4) {
      // DHT: tables of 1 + 16 counts + their values, filling the segment exactly.
      let p = start;
      while (p < end) {
        if (p + 17 > end || bytes[p]! >> 4 > 1 || (bytes[p]! & 15) > 3) return null;
        let values = 0;
        for (let index = 1; index <= 16; index += 1) values += bytes[p + index]!;
        p += 17 + values;
      }
      if (p !== end) return null;
    } else if (marker === 0xdd) {
      if (size !== 4) return null;
    } else if (marker >= 0xc0 && marker <= 0xc2) {
      if (frame !== null || size < 8) return null;
      const components = bytes[start + 5]!;
      if (components < 1 || components > 4 || size !== 8 + 3 * components) return null;
      for (let index = 0; index < components; index += 1) {
        const id = bytes[start + 6 + 3 * index]!;
        const h = bytes[start + 7 + 3 * index]! >> 4;
        const v = bytes[start + 7 + 3 * index]! & 15;
        if (ids.has(id) || h < 1 || h > 4 || v < 1 || v > 4 || bytes[start + 8 + 3 * index]! > 3) return null;
        ids.add(id);
      }
      frame = { frameMarker: marker, precision: bytes[start]!, height: u16(start + 1), width: u16(start + 3),
        components };
    } else if (marker === 0xda) {
      if (frame === null || size < 3) return null;
      const selectors = bytes[start]!;
      if (selectors < 1 || selectors > 4 || size !== 6 + 2 * selectors) return null;
      const seen = new Set<number>();
      for (let index = 0; index < selectors; index += 1) {
        const id = bytes[start + 1 + 2 * index]!;
        if (!ids.has(id) || seen.has(id)) return null;
        seen.add(id);
      }
      scans += 1;
      // The entropy-coded data, to the next marker.
      let p = end;
      for (;;) {
        if (p + 1 >= length) return null;
        if (bytes[p] !== 0xff) { p += 1; continue; }
        const next = bytes[p + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { p += 2; continue; }
        break;
      }
      at = p;
      continue;
    }
    at = end;
  }
  if (frame === null || scans === 0) return null;
  let scanMarkersAnywhere = 0;
  for (let index = 0; index + 1 < length; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xda) scanMarkersAnywhere += 1;
  }
  return { ...frame, scans, scanMarkersAnywhere };
}

/**
 * Whether zoom may decode this picture, from its bytes alone and without inflating or decoding anything: a PNG of at
 * most ZOOM_MAX_DECODE_PIXELS whose IHDR gives at most ZOOM_PNG_MAX_BIT_DEPTH bits per sample and no interlacing
 * (pngjs inflates an interlaced PNG without a size limit); a JPEG of at most ZOOM_JPEG_MAX_DECODE_PIXELS whose
 * structure parses (jpegStructure) with the picture's size, 8-bit samples, 1 or 3 components and at most
 * ZOOM_JPEG_MAX_SCANS scans, counted both in the walk and anywhere in the bytes.
 */
export function zoomDecodable(source: ZoomSource): boolean {
  if (source.mediaType === 'image/jpeg') {
    if (source.width * source.height > ZOOM_JPEG_MAX_DECODE_PIXELS) return false;
    const structure = jpegStructure(source.bytes);
    return structure !== null && structure.width === source.width && structure.height === source.height
      && structure.width * structure.height <= ZOOM_JPEG_MAX_DECODE_PIXELS && structure.precision === 8
      && ZOOM_JPEG_ALLOWED_COMPONENTS.includes(structure.components) && structure.scans <= ZOOM_JPEG_MAX_SCANS
      && structure.scanMarkersAnywhere <= ZOOM_JPEG_MAX_SCANS;
  }
  if (source.width * source.height > ZOOM_MAX_DECODE_PIXELS) return false;
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
  let decodable: boolean | undefined;
  const available = () => (decodable ??= zoomDecodable(source));
  const load = (): Raster | null => {
    if (raster !== undefined) return raster;
    // Over zoom's limits by the header: never decoded at all.
    if (!available()) { raster = null; return raster; }
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
    available,
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
