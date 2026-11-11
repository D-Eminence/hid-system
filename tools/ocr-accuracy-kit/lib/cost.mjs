// Cost estimate for a run, from page counts, and the cost of a finished run from its recorded token usage.
// Prices are US dollars and are the ones the owner gave for planning; check the AWS and Anthropic price
// pages before a large run.

export const TEXTRACT_PER_1000_PAGES = { text: 1.5, layout: 4.0 };
/** Per million tokens. Cache reads are charged at 0.1x and cache writes at 1.25x the input price. */
export const MODEL_PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};
const FALLBACK_PRICE = MODEL_PRICES['claude-opus-5-5'];

/**
 * Planning assumptions per page (documented in the README), for the worker's defaults since the owner decision of
 * 2026-11-05 (Opus 5.5 at high effort for every call) and the hard-page reads (two reads of the picture per hard page):
 * - first pass: ~2,000 cached prompt tokens, ~900 page tokens, ~4,000 output tokens (thinking + JSON);
 * - hard page: two reads, each ~2,000 cached prompt tokens, ~4,000 page and picture tokens, ~8,000 output tokens;
 *   expected on about 35% of pages, at most every page. The first live hard page (job 656c9cf3, 2026-11-10) cost
 *   about $0.45 for its two reads; this estimate gives about $0.35.
 */
export const ASSUMPTIONS = {
  cachedPromptTokens: 2_000,
  pageInputTokens: 900,
  firstPassOutputTokens: 4_000,
  rereadInputTokens: 4_000,
  rereadOutputTokens: 8_000,
  readsPerHardPage: 2,
  expectedRereadShare: 0.35,
};

export function priceOf(model) {
  return MODEL_PRICES[model] ?? FALLBACK_PRICE;
}

export function usageCost(model, usage) {
  const price = priceOf(model);
  return (usage.inputTokens * price.input + usage.outputTokens * price.output
    + usage.cacheReadInputTokens * price.input * 0.1 + usage.cacheCreationInputTokens * price.input * 1.25) / 1e6;
}

function pageCost(model, outputTokens, inputTokens = ASSUMPTIONS.pageInputTokens) {
  return usageCost(model, { inputTokens, outputTokens,
    cacheReadInputTokens: ASSUMPTIONS.cachedPromptTokens, cacheCreationInputTokens: 0 });
}

/** The worker's default output cap per hard-page read (OCR_AI_HARD_PAGE_MAX_TOKENS). */
export const HARD_READ_MAX_OUTPUT = 32_000;

/** The worker's default model (services/ocr-worker/src/config.ts): Opus 5.5 for the first pass and the re-reads. */
export const DEFAULT_MODEL = 'claude-opus-5-5';

export function estimate({ pages, features = 'text', firstPassModel = DEFAULT_MODEL,
  rereadModel = DEFAULT_MODEL, maxRereadPages = 20 }) {
  const textract = pages * TEXTRACT_PER_1000_PAGES[features] / 1000;
  const firstPass = pages * pageCost(firstPassModel, ASSUMPTIONS.firstPassOutputTokens);
  const rereadOne = ASSUMPTIONS.readsPerHardPage
    * pageCost(rereadModel, ASSUMPTIONS.rereadOutputTokens, ASSUMPTIONS.rereadInputTokens);
  const rereadCap = maxRereadPages > 0 ? 1 : 0;
  const expectedReread = pages * ASSUMPTIONS.expectedRereadShare * rereadOne * rereadCap;
  const worstReread = pages * rereadOne * rereadCap;
  return {
    pages, features, firstPassModel, rereadModel,
    textractUsd: round(textract), firstPassUsd: round(firstPass), expectedRereadUsd: round(expectedReread),
    expectedTotalUsd: round(textract + firstPass + expectedReread),
    upperBoundUsd: round(textract + firstPass + worstReread),
    ceilingUsd: round(textract + firstPass + pages * ASSUMPTIONS.readsPerHardPage
      * pageCost(rereadModel, HARD_READ_MAX_OUTPUT, ASSUMPTIONS.rereadInputTokens)),
  };
}

export function formatEstimate(e) {
  return [
    `Cost estimate for ${e.pages} pages (planning prices, US$):`,
    `  Textract (${e.features}): $${e.textractUsd.toFixed(2)}`,
    `  AI first pass (${e.firstPassModel}): about $${e.firstPassUsd.toFixed(2)}`,
    `  AI re-reads (${e.rereadModel}, ${ASSUMPTIONS.readsPerHardPage} reads per hard page, ~${Math.round(ASSUMPTIONS.expectedRereadShare * 100)}% of pages): about $${e.expectedRereadUsd.toFixed(2)}`,
    `  Expected total: about $${e.expectedTotalUsd.toFixed(2)}; about $${e.upperBoundUsd.toFixed(2)} if every page is a hard page.`,
    `  Hard ceiling: each hard-page read may use up to ${HARD_READ_MAX_OUTPUT.toLocaleString('en-US')} output tokens (OCR_AI_HARD_PAGE_MAX_TOKENS), about $${e.ceilingUsd.toFixed(2)} if every page used all of it.`,
  ].join('\n');
}

function round(value) { return Math.round(value * 100) / 100; }
