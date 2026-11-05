import type { ImageRereadSkipReason } from './contract';

/**
 * The picture of a page, for the re-read of a hard page (owner decision "Yes, send image for hard pages",
 * 2026-11-05). v1 sends only a single-page PNG or JPEG, as stored (the exact bytes the worker verified, with
 * their detected media type): nothing is resized or re-encoded, and nothing here is ever logged or stored.
 *
 * Claude API image limits (platform.claude.com/docs/en/build-with-claude/vision, read 2026-11-05): at most
 * 10 MB per image, base64-encoded, and at most 8000x8000 px. The size limit is taken as 10,000,000 base64
 * characters (decimal megabytes, the stricter reading). A picture over either limit is never sent.
 */
export const IMAGE_MAX_BASE64_LENGTH = 10_000_000;
export const IMAGE_MAX_DIMENSION_PX = 8_000;

export type PageImageMediaType = 'image/png' | 'image/jpeg';
export interface PageImage { readonly mediaType: PageImageMediaType; readonly base64: string }

export interface SourceDocument { readonly mediaType: string; readonly bytes: Uint8Array }

export type PageImageDecision =
  | { kind: 'image'; mediaType: PageImageMediaType; bytes: Uint8Array }
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
 * Whether this page's re-read may carry the picture, by the document alone (the page's own reasons are the
 * reader's): a one-page PNG or JPEG by its detected type, page 1, whose header gives a size within the limits.
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
  return { kind: 'image', mediaType: document.mediaType, bytes: document.bytes };
}
