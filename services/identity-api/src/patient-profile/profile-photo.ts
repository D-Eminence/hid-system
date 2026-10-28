import { createHash } from 'node:crypto';
import { DomainProblem } from '../common/problem';

/** The largest decoded photo (owner's rule: at most 300 KB). */
export const PROFILE_PHOTO_MAX_BYTES = 300 * 1024;
/** The largest side, in pixels (the browser re-encodes to 512 x 512). */
export const PROFILE_PHOTO_MAX_SIDE = 1024;
/** Base64 of PROFILE_PHOTO_MAX_BYTES. */
export const PROFILE_PHOTO_MAX_BASE64_LENGTH = Math.ceil(PROFILE_PHOTO_MAX_BYTES / 3) * 4;
/** The request body limit of PUT identity/me/photo: the base64 and a little JSON. */
export const PROFILE_PHOTO_BODY_LIMIT_BYTES = PROFILE_PHOTO_MAX_BASE64_LENGTH + 1024;

export type ProfilePhotoMediaType = 'image/jpeg' | 'image/png';

export interface InspectedPhoto {
  mediaType: ProfilePhotoMediaType;
  bytes: Buffer;
  width: number;
  height: number;
  sha256: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
/** Start-of-frame markers that carry the frame size (not DHT C4, JPG C8, DAC CC). */
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Markers without a length: TEM and RST0-RST7. */
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
/** Segments that carry camera, location or author metadata (APP1 Exif/XMP, APP13 IPTC). */
const JPEG_METADATA_MARKERS = new Set([0xe1, 0xed]);
/** PNG chunks that carry metadata: Exif and text. */
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);

function invalid(): DomainProblem {
  return new DomainProblem(400, 'PHOTO_INVALID',
    'Upload a JPEG or PNG photo of at most 300 KB and 1024 x 1024 pixels, without location or camera data.');
}

/**
 * The server's check of a profile photo (0094; owner's rules): strict
 * base64, at most 300 KB decoded, the media type proved by the magic bytes
 * (FF D8 FF and a final FF D9 for JPEG; the PNG signature, IHDR first and a
 * final IEND for PNG), so nothing may follow the image; the frame size read
 * from the JPEG start-of-frame segment or the PNG IHDR chunk, 1 to 1024
 * pixels a side; and no Exif, XMP, IPTC or text metadata (the browser
 * re-encodes and drops them; a client that did not is refused). The bytes
 * are stored as sent, encrypted; they are only ever served back with their
 * own type to the patient.
 */
export function inspectProfilePhoto(mediaType: unknown, data: unknown): InspectedPhoto {
  if ((mediaType !== 'image/jpeg' && mediaType !== 'image/png') || typeof data !== 'string'
    || data.length === 0 || data.length > PROFILE_PHOTO_MAX_BASE64_LENGTH || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw invalid();
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > PROFILE_PHOTO_MAX_BYTES || bytes.toString('base64') !== data) throw invalid();
  const size = mediaType === 'image/jpeg' ? jpegSize(bytes) : pngSize(bytes);
  if (!size || size.width < 1 || size.height < 1 || size.width > PROFILE_PHOTO_MAX_SIDE
    || size.height > PROFILE_PHOTO_MAX_SIDE) {
    throw invalid();
  }
  return { mediaType, bytes, width: size.width, height: size.height,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The frame size of a baseline or progressive JPEG, or undefined for anything else. */
export function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    return undefined;
  }
  let size: { width: number; height: number } | undefined;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    // Fill bytes before a marker.
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined) return undefined;
    if (JPEG_STANDALONE_MARKERS.has(marker)) continue;
    // The image data starts at the start-of-scan; the frame size comes first.
    if (marker === 0xda || marker === 0xd9) return size;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (JPEG_METADATA_MARKERS.has(marker)) return undefined;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (length < 7 || size) return undefined;
      size = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

/** The IHDR size of a PNG that ends with IEND and carries no metadata chunk, or undefined. */
export function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < PNG_SIGNATURE.length + 25 + PNG_IEND.length
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || !bytes.subarray(bytes.length - PNG_IEND.length).equals(PNG_IEND)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    return undefined;
  }
  // Walk the chunks to the IEND that ends the file: nothing may follow it,
  // and no metadata chunk may come before it.
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || next > bytes.length) return undefined;
    if (PNG_METADATA_CHUNKS.has(type)) return undefined;
    if (type === 'IEND') {
      return next === bytes.length ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : undefined;
    }
    offset = next;
  }
  return undefined;
}
