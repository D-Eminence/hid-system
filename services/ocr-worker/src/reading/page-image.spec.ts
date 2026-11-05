import { base64Length, HIGH_RESOLUTION_TIER, IMAGE_MAX_BASE64_LENGTH, imageTierOf, imageTokens, jpegDimensions,
  jpegOrientation, pageImageFor, pngDimensions, resizedSize, STANDARD_TIER } from './page-image';
import { fixtureExifSegment, fixtureJpeg, fixturePng } from './test-fixtures';

describe('page picture for the image re-read', () => {
  it('reads the size from a PNG IHDR and a JPEG frame header, and nothing from other bytes', () => {
    expect(pngDimensions(fixturePng(1240, 1754))).toEqual({ width: 1240, height: 1754 });
    expect(jpegDimensions(fixtureJpeg(2480, 3508))).toEqual({ width: 2480, height: 3508 });
    expect(pngDimensions(fixtureJpeg(10, 10))).toBeNull();
    expect(jpegDimensions(fixturePng(10, 10))).toBeNull();
    expect(pngDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
    // A segment length that runs off the end never reads past the bytes.
    expect(jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]))).toBeNull();
  });

  it('reads the EXIF orientation of a JPEG in both byte orders, and none where there is no EXIF', () => {
    for (const order of ['II', 'MM'] as const) {
      expect(jpegOrientation(fixtureJpeg(1240, 1754, 100, fixtureExifSegment(6, order)))).toBe(6);
      expect(jpegOrientation(fixtureJpeg(1240, 1754, 100, fixtureExifSegment(1, order)))).toBe(1);
    }
    expect(jpegOrientation(fixtureJpeg(1240, 1754))).toBeNull();
    // The frame size is still read past the EXIF segment.
    expect(jpegDimensions(fixtureJpeg(1240, 1754, 100, fixtureExifSegment(6)))).toEqual({ width: 1240, height: 1754 });
    // An EXIF segment cut short, or an orientation out of range, is unreadable, never read past the bytes.
    const cut = fixtureExifSegment(6).slice(0, 14);
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, ...cut]))).toBe('unreadable');
    expect(jpegOrientation(fixtureJpeg(10, 10, 10, fixtureExifSegment(9)))).toBe('unreadable');
    expect(jpegOrientation(fixturePng(10, 10))).toBeNull();
  });

  it('sends a JPEG only when it is upright: EXIF orientation 1 or none', () => {
    const jpeg = (exif: number[]) => ({ mediaType: 'image/jpeg', bytes: fixtureJpeg(1240, 1754, 100, exif) });
    expect(pageImageFor(jpeg(fixtureExifSegment(6)), 1, 1)).toEqual({ kind: 'skip',
      reason: 'image_orientation_unsupported' });
    expect(pageImageFor(jpeg(fixtureExifSegment(3, 'II')), 1, 1)).toEqual({ kind: 'skip',
      reason: 'image_orientation_unsupported' });
    expect(pageImageFor(jpeg(fixtureExifSegment(9)), 1, 1)).toEqual({ kind: 'skip',
      reason: 'image_orientation_unsupported' });
    expect(pageImageFor(jpeg(fixtureExifSegment(1)), 1, 1)).toMatchObject({ kind: 'image', width: 1240, height: 1754 });
    expect(pageImageFor(jpeg([]), 1, 1)).toMatchObject({ kind: 'image' });
  });

  it('allows only a one-page PNG or JPEG by its detected type, within the Claude API image limits', () => {
    const png = { mediaType: 'image/png', bytes: fixturePng(1240, 1754) };
    expect(pageImageFor(png, 1, 1)).toMatchObject({ kind: 'image', mediaType: 'image/png', width: 1240, height: 1754 });
    expect(pageImageFor({ mediaType: 'image/jpeg', bytes: fixtureJpeg(1240, 1754) }, 1, 1))
      .toMatchObject({ kind: 'image', mediaType: 'image/jpeg' });
    expect(pageImageFor(undefined, 1, 1)).toEqual({ kind: 'skip', reason: 'image_not_given' });
    expect(pageImageFor({ mediaType: 'application/pdf', bytes: png.bytes }, 1, 1))
      .toEqual({ kind: 'skip', reason: 'image_not_available_pdf' });
    expect(pageImageFor({ mediaType: 'image/tiff', bytes: png.bytes }, 1, 1))
      .toEqual({ kind: 'skip', reason: 'image_not_available_tiff' });
    expect(pageImageFor({ mediaType: 'image/gif', bytes: png.bytes }, 1, 1))
      .toEqual({ kind: 'skip', reason: 'image_not_available_type' });
    expect(pageImageFor(png, 2, 2)).toEqual({ kind: 'skip', reason: 'not_single_page' });
    expect(pageImageFor(png, 1, 2)).toEqual({ kind: 'skip', reason: 'not_single_page' });
    expect(pageImageFor({ mediaType: 'image/png', bytes: fixturePng(8001, 1000) }, 1, 1))
      .toEqual({ kind: 'skip', reason: 'image_too_large' });
    expect(pageImageFor({ mediaType: 'image/jpeg', bytes: fixtureJpeg(1000, 8001) }, 1, 1))
      .toEqual({ kind: 'skip', reason: 'image_too_large' });
    expect(pageImageFor({ mediaType: 'image/png', bytes: fixturePng(8000, 8000) }, 1, 1)).toMatchObject({ kind: 'image' });
    // A declared PNG whose bytes are not one: its size is unknown, so it is not sent.
    expect(pageImageFor({ mediaType: 'image/png', bytes: fixtureJpeg(100, 100) }, 1, 1))
      .toEqual({ kind: 'skip', reason: 'image_size_unknown' });
  });

  it('holds the base64 size to 10 MB without encoding the picture', () => {
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
    const limitBytes = IMAGE_MAX_BASE64_LENGTH / 4 * 3;
    expect(base64Length(limitBytes)).toBe(IMAGE_MAX_BASE64_LENGTH);
    expect(pageImageFor({ mediaType: 'image/png', bytes: fixturePng(1000, 1000, limitBytes - 33) }, 1, 1))
      .toMatchObject({ kind: 'image' });
    expect(pageImageFor({ mediaType: 'image/png', bytes: fixturePng(1000, 1000, limitBytes - 32) }, 1, 1))
      .toEqual({ kind: 'skip', reason: 'image_too_large' });
  });

  it('computes the size the API reads a picture at, as the vision coordinates guide does, by model tier', () => {
    // The guide's own examples (standard tier): an A4 scan at 130 dpi, and a 1920 x 1080 screenshot.
    expect(resizedSize(1075, 1520, STANDARD_TIER)).toEqual({ width: 924, height: 1307 });
    expect(resizedSize(1920, 1080, STANDARD_TIER)).toEqual({ width: 1456, height: 819 });
    // The high-resolution tier reads the same scan as it is.
    expect(resizedSize(1075, 1520, HIGH_RESOLUTION_TIER)).toEqual({ width: 1075, height: 1520 });
    const a4 = resizedSize(2480, 3508, HIGH_RESOLUTION_TIER);
    expect(imageTokens(a4.width, a4.height)).toBeLessThanOrEqual(4_784);
    expect(Math.abs(a4.width / a4.height - 2480 / 3508)).toBeLessThan(0.002);
    expect(imageTierOf('claude-opus-5-5')).toBe(HIGH_RESOLUTION_TIER);
    expect(imageTierOf('claude-sonnet-5-5')).toBe(HIGH_RESOLUTION_TIER);
    expect(imageTierOf('claude-opus-4-7')).toBe(HIGH_RESOLUTION_TIER);
    expect(imageTierOf('claude-sonnet-4-5')).toBe(STANDARD_TIER);
  });

  it('knows a tier only for listed model ids, never by guessing from the id', () => {
    for (const model of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5-5',
      'claude-sonnet-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5', 'claude-mythos-5-1']) {
      expect(imageTierOf(model)).toBe(HIGH_RESOLUTION_TIER);
    }
    for (const model of ['claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
      expect(imageTierOf(model)).toBe(STANDARD_TIER);
    }
    // Unlisted ids, including ones a version pattern would have placed: no tier.
    for (const model of ['claude-haiku-5-5', 'claude-opus-6', 'claude-sonnet-5-6', 'claude-opus-5-5-20260401',
      'claude-opus-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-custom']) {
      expect(imageTierOf(model)).toBeNull();
    }
  });
});
