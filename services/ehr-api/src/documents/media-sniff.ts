/**
 * The media type a stored document really has, from its first bytes (owner
 * decision D3 of 2026-10-31: a document is accepted under its real type when
 * that type is one of the four the platform takes). Only these signatures, each
 * at byte 0, are recognised; anything else is not one of the four, including a
 * PDF with bytes before its "%PDF-" header (the safer reading: such a file is
 * refused as media.unsupported rather than served as a PDF).
 */
export const SNIFF_PREFIX_BYTES = 1024;

export const SUPPORTED_DOCUMENT_MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'] as const;
export type SupportedDocumentMediaType = (typeof SUPPORTED_DOCUMENT_MEDIA_TYPES)[number];

const SIGNATURES: readonly { mediaType: SupportedDocumentMediaType; bytes: readonly number[] }[] = [
  { mediaType: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mediaType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mediaType: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
];

export function sniffMediaType(prefix: Uint8Array): SupportedDocumentMediaType | null {
  for (const signature of SIGNATURES) {
    if (prefix.length >= signature.bytes.length && signature.bytes.every((byte, index) => prefix[index] === byte)) {
      return signature.mediaType;
    }
  }
  return null;
}

export function isSupportedDocumentMediaType(value: string | null | undefined): value is SupportedDocumentMediaType {
  return (SUPPORTED_DOCUMENT_MEDIA_TYPES as readonly string[]).includes(value ?? '');
}

const EXTENSIONS: Readonly<Record<SupportedDocumentMediaType, { canonical: string; accepted: readonly string[] }>> = {
  'application/pdf': { canonical: '.pdf', accepted: ['.pdf'] },
  'image/jpeg': { canonical: '.jpg', accepted: ['.jpg', '.jpeg'] },
  'image/png': { canonical: '.png', accepted: ['.png'] },
  'image/tiff': { canonical: '.tif', accepted: ['.tif', '.tiff'] },
};
const KNOWN_EXTENSION = /\.(pdf|jpe?g|png|tiff?)$/i;

/**
 * The file name a download is served under: the uploaded name made header-safe
 * (letters, digits, dot, dash and underscore; at most 120 characters), with an
 * extension that matches the detected type. A known document extension that
 * names another type is replaced, so a JPEG uploaded as "scan.png" downloads as
 * "scan.jpg".
 */
export function downloadFileName(originalFileName: string, mediaType: SupportedDocumentMediaType): string {
  const extension = EXTENSIONS[mediaType];
  const safe = originalFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const current = KNOWN_EXTENSION.exec(safe)?.[0].toLowerCase();
  if (current && extension.accepted.includes(current) && safe.length <= 120 && safe.length > current.length) {
    return safe;
  }
  const stem = (current ? safe.slice(0, -current.length) : safe).replace(/^[._-]+/, '') || 'document';
  return `${stem.slice(0, 120 - extension.canonical.length)}${extension.canonical}`;
}
