import { PNG } from 'pngjs';
import { HIGH_RESOLUTION_TIER, imageTokens, resizedSize, STANDARD_TIER } from './page-image';
import { fixtureJpeg, fixturePng, syntheticJpeg, syntheticPng } from './test-fixtures';
import { clampBox, createPageZoom, createZoomSession, decodeRaster, resample, toOriginalRect, ZOOM_LIMIT_MESSAGE,
  ZOOM_MIN_BOX_PX, ZOOM_REQUEST_BASE64_BUDGET, ZOOM_TOOL, ZOOM_UNAVAILABLE_MESSAGE, zoomOutputSize, type PageZoom,
  type Raster, type ZoomSource } from './zoom';

const source = (mediaType: 'image/png' | 'image/jpeg', width: number, height: number): ZoomSource => ({ mediaType,
  width, height, bytes: mediaType === 'image/png' ? syntheticPng(width, height) : syntheticJpeg(width, height) });

function decodePng(base64: string) {
  return PNG.sync.read(Buffer.from(base64, 'base64'));
}

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
      let decodes = 0;
      const zoom = createPageZoom(page, { width: 640, height: 480 }, HIGH_RESOLUTION_TIER,
        { decode: (input) => { decodes += 1; return decodeRaster(input); } });
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
      expect(decodes).toBe(1);
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
    let decodes = 0;
    const broken = createPageZoom({ mediaType: 'image/png', bytes: fixturePng(640, 480), width: 640, height: 480 },
      { width: 640, height: 480 }, HIGH_RESOLUTION_TIER, { decode: (input) => { decodes += 1; return decodeRaster(input); } });
    await expect(broken.crop({ x: 0, y: 0, w: 2, h: 2 }, 2)).resolves.toEqual({ kind: 'invalid' });
    await expect(broken.crop({ x: 0, y: 0, w: 20, h: 20 }, 5)).resolves.toEqual({ kind: 'invalid' });
    await expect(broken.crop({ x: 0, y: 0, w: 20, h: 20 }, 0.5)).resolves.toEqual({ kind: 'invalid' });
    expect(decodes).toBe(0);
    await expect(broken.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    await expect(broken.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    expect(decodes).toBe(1);
    // A decoded size other than the header's.
    const page = source('image/png', 64, 48);
    const mismatch = createPageZoom({ ...page, width: 65 }, { width: 65, height: 48 }, HIGH_RESOLUTION_TIER);
    await expect(mismatch.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('holds JPEG decoding to its resolution and memory limits', () => {
    // A header that claims more pixels than the picture limits allow is refused before any pixel is decoded.
    expect(() => decodeRaster({ mediaType: 'image/jpeg', bytes: fixtureJpeg(9_000, 9_000), width: 9_000, height: 9_000 }))
      .toThrow(/maxResolutionInMP/);
    // An undecodable JPEG throws too (and its error carries no picture data).
    const bytes = fixtureJpeg(640, 480);
    let message = '';
    try { decodeRaster({ mediaType: 'image/jpeg', bytes, width: 640, height: 480 }); } catch (error) {
      message = String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(Buffer.from(bytes).toString('base64').slice(40, 80));
  });

  it('turns zoom off for the page when decoding takes longer than the time limit, not the reading', async () => {
    let clock = 0;
    let decodes = 0;
    const zoom = createPageZoom(source('image/png', 64, 48), { width: 64, height: 48 }, HIGH_RESOLUTION_TIER, {
      now: () => clock, decodeTimeLimitMs: 5_000,
      decode: (input) => { decodes += 1; clock += 6_000; return decodeRaster(input); } });
    await expect(zoom.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    await expect(zoom.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    expect(decodes).toBe(1);
    // A crop slower than its limit does the same.
    let tick = 0;
    const slow = createPageZoom(source('image/png', 64, 48), { width: 64, height: 48 }, HIGH_RESOLUTION_TIER, {
      now: () => (tick += 4_000), cropTimeLimitMs: 3_000, decodeTimeLimitMs: 60_000 });
    await expect(slow.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
    await expect(slow.crop({ x: 0, y: 0, w: 20, h: 20 }, 2)).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('zoom tool session', () => {
  const crop = { mediaType: 'image/png' as const, base64: 'Q1JPUA==', width: 64, height: 64,
    region: { x: 1, y: 2, w: 16, h: 16 }, scale: 4 };
  const fixed = (outcome: Awaited<ReturnType<PageZoom['crop']>>): PageZoom & { crop: jest.Mock } =>
    ({ crop: jest.fn(async () => outcome) });
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
    expect(zoom.crop).toHaveBeenCalledWith(good.box, 2);
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(result).not.toHaveProperty('is_error');
    const content = result.content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(String(content[0]!.text)).toContain('x 1, y 2, width 16, height 16');
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Q1JPUA==' } });
    expect(session.stats).toEqual({ calls: 1, limited: 0, failed: 0 });
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
    const throwing = createZoomSession({ crop: async () => { throw new Error('boom'); } }, 1, 8, 1_000);
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
