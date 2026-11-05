import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { base64Length, IMAGE_MAX_BASE64_LENGTH, pngDimensions, type PageImageMediaType } from './page-image';

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
/**
 * Beyond the checked frame's own needs (jpegMemoryBudget), what jpeg-js's memory count may grow by: rounding only.
 * Every table jpeg-js counts is counted from the walk exactly, and a second frame (or anything else the walk did not
 * see) needs more than this, so jpeg-js refuses it before allocating it.
 */
export const ZOOM_JPEG_MEMORY_SLACK_BYTES = 64 * 1024;
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

/** An RGB raster, 3 bytes per pixel, rows top to bottom. */
export interface Raster { readonly width: number; readonly height: number; readonly rgb: Uint8Array }

/** The page picture as the worker verified it (page-image.ts PageImageDecision 'image'). */
export interface ZoomSource { mediaType: PageImageMediaType; bytes: Uint8Array; width: number; height: number }

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
  /** The frame's components' sampling factors, in frame order. */
  sampling: ReadonlyArray<{ h: number; v: number }>;
  /** What jpeg-js counts for the tables in the walk: 256 bytes per DQT table, 16 plus its values per DHT table. */
  tableBytes: number;
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
 *   0xFF 0xD0-0xD7 a restart marker, both inside the scan; the bytes must end with EOI;
 * - no byte pattern in the entropy-coded data where jpeg-js's own marker search would part from this walk (below).
 * scanMarkersAnywhere also counts 0xFF 0xDA inside other segments (an EXIF thumbnail's scan, say) and after EOI, so a
 * limit on it holds even were jpeg-js to resynchronise somewhere the walk did not.
 *
 * Where jpeg-js 0.4.4 (lib/decoder.js, parse and decodeScan) can read markers somewhere other than this walk, all
 * inside a scan's entropy-coded data, and what the walk does about each:
 * 1. After the scan's last MCU jpeg-js skips to the next 0xFF not followed by 0x00; if that is a restart marker it
 *    takes it and reads the NEXT TWO BYTES as a marker, whatever they are, where the walk goes on skipping scan data.
 *    Those two bytes then: 0x00 0xE0 or 0x00 0xE1 starts its "malformed APP" recovery, a jump by the two bytes after
 *    them to anywhere later (a COM's contents, say, holding a second SOF: the reviewer's exploit); 0xFF 0x00 is
 *    skipped as nothing and the two after are read as a marker again; another restart marker or any other non-marker
 *    makes it throw (harmless). So after every restart marker the walk refuses 0x00 0xE0, 0x00 0xE1, 0xFF 0x00 and
 *    another restart marker (an empty restart interval, which no encoder writes). The walk cannot tell the last
 *    restart marker from the others without decoding, so it refuses them after any; a real photo has them there by
 *    chance about once in 20,000 restart markers, and only zoom is off for it.
 * 2. With a restart interval (DRI), jpeg-js reads a marker where an interval's MCUs end, and takes 0xFF 0x00 there as
 *    a marker too (skipped as nothing, the two bytes after read as a marker); a stuffed byte where an interval ends
 *    is not a valid JPEG, but the walk cannot see where intervals end. Of what follows, only 0x00 0xE0 or 0x00 0xE1
 *    whose recovery jump lands on 0xFF parts from the walk (anything else throws or is a marker the walk sees too, a
 *    0xFF 0x00 chain repeating the same choice), so the walk refuses exactly that after any 0xFF 0x00: the jump
 *    target is the 0xFF jpeg-js checks for. Without DRI jpeg-js never reads a marker inside a scan.
 * 3. Fill bytes (0xFF 0xFF) before 0x00: jpeg-js reads 0xFF 0x00 (case 2); the walk refuses marker 0x00 itself.
 * 4. Its "eaten 0xFF" recovery (back three bytes when the byte before a bad marker is 0xFF) and every other unknown
 *    marker are reached only at a place the walk has refused or where jpeg-js throws.
 * Each segment the walk accepts is read by jpeg-js from the same place (lengths checked above), so outside scans
 * the two agree. None of this is relied on alone: decodeRaster also gives jpeg-js its pixel and memory limits from
 * this frame, and the decode runs in a worker thread with a wall-clock and heap limit (zoom-worker.ts).
 */
export function jpegStructure(bytes: Uint8Array): JpegStructure | null {
  const length = bytes.length;
  if (length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  let frame: Omit<JpegStructure, 'scans' | 'scanMarkersAnywhere' | 'tableBytes'> | null = null;
  const ids = new Set<number>();
  let scans = 0;
  let tableBytes = 0;
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
        tableBytes += 64 * 4;
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
        tableBytes += 16 + values;
      }
      if (p !== end) return null;
    } else if (marker === 0xdd) {
      if (size !== 4) return null;
    } else if (marker >= 0xc0 && marker <= 0xc2) {
      if (frame !== null || size < 8) return null;
      const components = bytes[start + 5]!;
      if (components < 1 || components > 4 || size !== 8 + 3 * components) return null;
      const sampling: Array<{ h: number; v: number }> = [];
      for (let index = 0; index < components; index += 1) {
        const id = bytes[start + 6 + 3 * index]!;
        const h = bytes[start + 7 + 3 * index]! >> 4;
        const v = bytes[start + 7 + 3 * index]! & 15;
        if (ids.has(id) || h < 1 || h > 4 || v < 1 || v > 4 || bytes[start + 8 + 3 * index]! > 3) return null;
        ids.add(id);
        sampling.push({ h, v });
      }
      frame = { frameMarker: marker, precision: bytes[start]!, height: u16(start + 1), width: u16(start + 3),
        components, sampling };
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
      // The entropy-coded data, to the next marker, refusing where jpeg-js would read it another way (above).
      let p = end;
      for (;;) {
        if (p + 1 >= length) return null;
        if (bytes[p] !== 0xff) { p += 1; continue; }
        const next = bytes[p + 1]!;
        if (next === 0x00) {
          if (jpegJsWouldJump(bytes, p + 2)) return null;
          p += 2;
          continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
          const a = bytes[p + 2];
          const b = bytes[p + 3];
          if (a === 0x00 && (b === 0xe0 || b === 0xe1)) return null;
          if (a === 0xff && (b === 0x00 || (b !== undefined && b >= 0xd0 && b <= 0xd7))) return null;
          p += 2;
          continue;
        }
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
  return { ...frame, scans, scanMarkersAnywhere, tableBytes };
}

/**
 * Whether jpeg-js, reading the two bytes at `at` as a marker, would take its "malformed APP" recovery jump: 0x00 0xE0
 * or 0x00 0xE1, then a 16-bit distance whose target byte is 0xFF (jpeg-js decoder.js, parse, default case).
 */
function jpegJsWouldJump(bytes: Uint8Array, at: number): boolean {
  if (bytes[at] !== 0x00 || (bytes[at + 1] !== 0xe0 && bytes[at + 1] !== 0xe1) || at + 3 >= bytes.length) return false;
  const distance = (bytes[at + 2]! << 8) | bytes[at + 3]!;
  return bytes[at + 2 + distance] === 0xff;
}

/**
 * What jpeg-js 0.4.4 counts against maxMemoryUsageInMB (its requestMemoryAllocation calls in lib/decoder.js) for
 * this frame and nothing else, in bytes:
 * - prepareComponents: for each component, (mcusPerColumn x v) x (mcusPerLine x h) blocks, each an Int32Array(64)
 *   counted as 256 bytes, where mcusPerLine = ceil(width / 8 / maxH) and mcusPerColumn = ceil(height / 8 / maxV);
 * - buildComponentData: for each component, its lines, (blocksPerLine x 8) x (blocksPerColumn x 8) bytes, where
 *   blocksPerLine = ceil(ceil(width / 8) x h / maxH) and blocksPerColumn = ceil(ceil(height / 8) x v / maxV);
 * - getData: width x height x components; decode: the output, width x height x 3 (RGB);
 * - the tables in the walk (tableBytes), and ZOOM_JPEG_MEMORY_SLACK_BYTES.
 * A second frame anywhere jpeg-js might find one counts its blocks again and is refused before they are allocated.
 */
export function jpegMemoryBudget(structure: JpegStructure): number {
  const { width, height, sampling } = structure;
  const maxH = Math.max(1, ...sampling.map((component) => component.h));
  const maxV = Math.max(1, ...sampling.map((component) => component.v));
  const mcusPerLine = Math.ceil(width / 8 / maxH);
  const mcusPerColumn = Math.ceil(height / 8 / maxV);
  let bytes = 0;
  for (const { h, v } of sampling) {
    bytes += mcusPerColumn * v * mcusPerLine * h * 256;
    const blocksPerLine = Math.ceil(Math.ceil(width / 8) * h / maxH);
    const blocksPerColumn = Math.ceil(Math.ceil(height / 8) * v / maxV);
    bytes += blocksPerLine * 8 * blocksPerColumn * 8;
  }
  return bytes + width * height * sampling.length + width * height * 3 + structure.tableBytes
    + ZOOM_JPEG_MEMORY_SLACK_BYTES;
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
 * jpeg-js over these bytes with its own limits taken from the checked frame (`structure`), not from zoom's ceilings:
 * no more pixels than that frame (plus half a pixel, for the float round trip) and no more memory, by its own count,
 * than that frame's blocks, lines, output and tables (jpegMemoryBudget). Whatever else jpeg-js might find in the
 * bytes is refused by its own count before it is allocated.
 */
export function decodeJpegWithin(bytes: Uint8Array, structure: JpegStructure): Raster {
  const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, tolerantDecoding: false,
    maxResolutionInMP: (structure.width * structure.height + 0.5) / 1_000_000,
    maxMemoryUsageInMB: jpegMemoryBudget(structure) / (1024 * 1024) });
  if (image.data.length !== image.width * image.height * 3) throw new Error('ZOOM_DECODE_SHAPE');
  return { width: image.width, height: image.height, rgb: image.data };
}

/**
 * Decodes the exact stored bytes to RGB, within zoom's limits (zoomDecodable, checked first) and the decoders'.
 * Throws on any problem (never with pixels).
 */
export function decodeRaster(source: ZoomSource): Raster {
  if (!zoomDecodable(source)) throw new Error('ZOOM_DECODE_LIMIT');
  if (source.mediaType === 'image/jpeg') {
    return decodeJpegWithin(source.bytes, jpegStructure(source.bytes)!);
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

/** A crop job's answer: the PNG, or null when even the smallest try is over `maxBase64`, at its final size. */
export interface CropPng { png: Uint8Array | null; width: number; height: number }

/**
 * Resamples the rectangle to width x height and encodes it as PNG, made smaller (three quarters a side, up to five
 * times) until its base64 fits `maxBase64`.
 */
export function cropPng(raster: Raster, rect: { x: number; y: number; w: number; h: number }, width: number,
  height: number, maxBase64: number): CropPng {
  let size = { width, height };
  for (let tries = 0; tries < 6; tries += 1) {
    const png = encodePng(resample(raster, rect, size.width, size.height), size.width, size.height);
    if (base64Length(png.byteLength) <= Math.min(maxBase64, IMAGE_MAX_BASE64_LENGTH)) {
      return { png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength), ...size };
    }
    size = { width: Math.max(1, Math.floor(size.width * 0.75)), height: Math.max(1, Math.floor(size.height * 0.75)) };
  }
  return { png: null, ...size };
}
