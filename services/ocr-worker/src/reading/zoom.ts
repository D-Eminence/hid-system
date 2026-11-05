import type { PageImage } from './page-image';
import type { ModelFractionBox } from './prompt';

/**
 * ZOOM: DEFERRED. Owner decision of 2026-11-05 (about 18:40 UTC), point 3: zoom is deferred; leave a documented
 * seam and implement nothing. Nothing in the worker implements, constructs or calls this interface yet.
 *
 * Where it would go: a hard page is read twice from its whole picture (reader.ts, readHardPage). A later step could,
 * between those reads and the merge, ask for a closer crop of an item's box where the two readings disagree, and
 * send that crop (with the same prompt rules: cite lines, give the box in the full picture's pixels) for one more
 * reading of that item alone. The crop must be cut from the same verified bytes the page picture came from, keep
 * the picture's limits (page-image.ts), never be logged or stored, and its answer must pass the same placement rules
 * (items.ts imagePlace) as any picture item. Until then, hard pages are read from the whole picture only.
 */
export interface PageZoom {
  /**
   * A crop of the page picture around `box` (page fractions), padded by `paddingFraction` of the page on each side,
   * or null when no crop can be made (then the item stays as the whole-picture readings left it).
   */
  crop(page: PageImage, box: ModelFractionBox, paddingFraction: number): Promise<PageImage | null>;
}
