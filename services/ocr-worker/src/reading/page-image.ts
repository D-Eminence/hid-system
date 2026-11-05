import type { ImageRereadSkipReason } from './contract';

/**
 * The picture of a page, for the re-read of a flagged page (owner decisions "Yes, send image for hard pages" and the
 * flag-based routing, both 2026-11-05). v1 sends only a single-page PNG or JPEG, as stored (the exact bytes the worker verified, with
 * their detected media type): nothing is resized or re-encoded, and nothing here is ever logged or stored.
 *
 * Claude API image limits (platform.claude.com/docs/en/build-with-claude/vision, read 2026-11-05): at most
 * 10 MB per image, base64-encoded, and at most 8000x8000 px. The size limit is taken as 10,000,000 base64
 * characters (decimal megabytes, the stricter reading). A picture over either limit is never sent.
 */
export const IMAGE_MAX_BASE64_LENGTH = 10_000_000;
export const IMAGE_MAX_DIMENSION_PX = 8_000;

export type PageImageMediaType = 'image/png' | 'image/jpeg';
/** The picture as sent: its media type, its base64 and its own size in pixels (from its header). */
export interface PageImage { readonly mediaType: PageImageMediaType; readonly base64: string; readonly width: number;
  readonly height: number }

export interface SourceDocument { readonly mediaType: string; readonly bytes: Uint8Array }

export type PageImageDecision =
  | { kind: 'image'; mediaType: PageImageMediaType; bytes: Uint8Array; width: number; height: number }
  | { kind: 'skip'; reason: ImageRereadSkipReason };

/** The base64 length of n bytes (padded). */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk, or null where the bytes are not a PNG that starts with one. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  // The first chunk: a 4-byte length (13), then the type "IHDR", then width and height (big-endian).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Width and height from a JPEG's first start-of-frame segment (SOF0-SOF15, not DHT, JPG or DAC), walking the
 * segments from the start; null where the bytes are not a JPEG or no frame header comes before the scan.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    let marker = bytes[at + 1]!;
    // Fill bytes: any number of 0xFF before a marker.
    while (marker === 0xff && at + 2 < bytes.length) { at += 1; marker = bytes[at + 1]!; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (at + 3 >= bytes.length) return null;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 8 >= bytes.length || length < 7) return null;
      const height = (bytes[at + 5]! << 8) | bytes[at + 6]!;
      const width = (bytes[at + 7]! << 8) | bytes[at + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + length;
  }
  return null;
}

/**
 * The EXIF Orientation (tag 0x0112) of a JPEG, from its APP1 "Exif" segment, walking the segments from the start
 * up to the scan; both TIFF byte orders ("II" little-endian, "MM" big-endian). null where the JPEG has no EXIF
 * segment or its first IFD has no Orientation; 'unreadable' where an EXIF segment is there but cut short or not
 * well formed, or the value is not 1-8. Nothing is decoded and no dependency is used.
 */
export function jpegOrientation(bytes: Uint8Array): number | null | 'unreadable' {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    let marker = bytes[at + 1]!;
    while (marker === 0xff && at + 2 < bytes.length) { at += 1; marker = bytes[at + 1]!; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (at + 3 >= bytes.length) return null;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2) return null;
    const end = Math.min(bytes.length, at + 2 + length);
    if (marker === 0xe1 && end - (at + 4) >= 6 && EXIF_HEADER.every((byte, index) => bytes[at + 4 + index] === byte)) {
      return exifOrientation(bytes, at + 10, end);
    }
    at += 2 + length;
  }
  return null;
}

/** "Exif" and two zero bytes: the start of an APP1 segment that holds EXIF (not XMP). */
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const ORIENTATION_TAG = 0x0112;

/** The Orientation in the TIFF structure that starts at `tiff` and ends before `end`. */
function exifOrientation(bytes: Uint8Array, tiff: number, end: number): number | null | 'unreadable' {
  if (tiff + 8 > end) return 'unreadable';
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!little && !big) return 'unreadable';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, little);
  if (u16(tiff + 2) !== 42) return 'unreadable';
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd < tiff + 8 || ifd + 2 > end) return 'unreadable';
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 'unreadable';
    if (u16(entry) !== ORIENTATION_TAG) continue;
    // SHORT (type 3), one value, held in the first two bytes of the value field.
    if (u16(entry + 2) !== 3 || view.getUint32(entry + 4, little) !== 1) return 'unreadable';
    const orientation = u16(entry + 8);
    return orientation >= 1 && orientation <= 8 ? orientation : 'unreadable';
  }
  return null;
}

/**
 * Whether this page's re-read may carry the picture, by the document alone (the page's own reasons are the
 * reader's): a one-page PNG or JPEG by its detected type, page 1, whose header gives a size within the limits,
 * and, for a JPEG, no EXIF Orientation other than 1 (upright).
 */
export function pageImageFor(document: SourceDocument | undefined, page: number, pageCount: number): PageImageDecision {
  if (document === undefined) return { kind: 'skip', reason: 'image_not_given' };
  if (document.mediaType === 'application/pdf') return { kind: 'skip', reason: 'image_not_available_pdf' };
  if (document.mediaType === 'image/tiff') return { kind: 'skip', reason: 'image_not_available_tiff' };
  if (document.mediaType !== 'image/png' && document.mediaType !== 'image/jpeg') {
    return { kind: 'skip', reason: 'image_not_available_type' };
  }
  if (page !== 1 || pageCount !== 1) return { kind: 'skip', reason: 'not_single_page' };
  if (base64Length(document.bytes.byteLength) > IMAGE_MAX_BASE64_LENGTH) return { kind: 'skip', reason: 'image_too_large' };
  const size = document.mediaType === 'image/png' ? pngDimensions(document.bytes) : jpegDimensions(document.bytes);
  if (size === null) return { kind: 'skip', reason: 'image_size_unknown' };
  if (size.width > IMAGE_MAX_DIMENSION_PX || size.height > IMAGE_MAX_DIMENSION_PX) {
    return { kind: 'skip', reason: 'image_too_large' };
  }
  // A JPEG turned by its EXIF Orientation would be seen turned (or not) differently from the page the text service
  // read, so the line boxes and the model's boxes would not match: v1 sends only an upright picture.
  if (document.mediaType === 'image/jpeg') {
    const orientation = jpegOrientation(document.bytes);
    if (orientation !== null && orientation !== 1) return { kind: 'skip', reason: 'image_orientation_unsupported' };
  }
  return { kind: 'image', mediaType: document.mediaType, bytes: document.bytes, width: size.width, height: size.height };
}

/**
 * Image limits by model tier (platform.claude.com/docs/en/build-with-claude/vision, "Resolution and token cost",
 * read 2026-11-05): the high-resolution tier reads up to 2,576 px on the long edge and 4,784 visual tokens; the
 * standard tier up to 1,568 px and 1,568 tokens.
 */
export interface ImageTier { readonly maxEdge: number; readonly maxTokens: number }
export const HIGH_RESOLUTION_TIER: ImageTier = { maxEdge: 2_576, maxTokens: 4_784 };
export const STANDARD_TIER: ImageTier = { maxEdge: 1_568, maxTokens: 1_568 };

/**
 * The tier of each model id the worker may send a picture to, written out (never guessed from the id): the
 * line boxes and the model's pixel coordinates are in the size the API resizes the picture to, which depends on
 * the tier. From Anthropic's model documentation (claude-api reference, models and migration guides, cached
 * 2026-10-06; checked 2026-11-05): high resolution on Claude Opus 4.7, 4.8, 5 and 5.5, Claude Sonnet 5 and 5.5,
 * Claude Fable 5 and 5.1 and Claude Mythos 5.1 (Sonnet 5.5 and Opus 5.5 carry over their predecessors' vision);
 * standard on Claude Opus 4.6 and 4.5, Claude Sonnet 4.6 and 4.5 and Claude Haiku 4.5. Any other model (Claude
 * Haiku 5.5 included, whose tier the guides do not state) has no known tier: no picture goes to it.
 */
const IMAGE_TIERS: ReadonlyMap<string, ImageTier> = new Map([
  ...['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5',
    'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5-1'].map((model) => [model, HIGH_RESOLUTION_TIER] as const),
  ...['claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5']
    .map((model) => [model, STANDARD_TIER] as const),
]);

/** The image tier of a model id from the list above, or null where it is not listed. */
export function imageTierOf(model: string): ImageTier | null {
  return IMAGE_TIERS.get(model) ?? null;
}

/** Visual tokens of an image: one per 28x28 pixel patch. */
export function imageTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/** Round half to even, as the API resolves exact .5 ties (Python's round()). */
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The size the API resizes a picture to before it reads it (before padding to a multiple of 28 px, which holds
 * nothing), by the documented reference implementation (platform.claude.com/docs/en/build-with-claude/
 * vision-coordinates, "Resize your image before uploading", read 2026-11-05). The pixel coordinates the model
 * returns are in this size, so boxes are normalised by it, never by the padded size.
 */
export function resizedSize(width: number, height: number, tier: ImageTier): { width: number; height: number } {
  const fits = (w: number, h: number) => Math.ceil(w / 28) * 28 <= tier.maxEdge && Math.ceil(h / 28) * 28 <= tier.maxEdge
    && imageTokens(w, h) <= tier.maxTokens;
  if (fits(width, height)) return { width, height };
  if (height > width) {
    const turned = resizedSize(height, width, tier);
    return { width: turned.height, height: turned.width };
  }
  const aspect = width / height;
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(roundTiesToEven(mid / aspect), 1))) lo = mid;
    else hi = mid;
  }
  return { width: lo, height: Math.max(roundTiesToEven(lo / aspect), 1) };
}
