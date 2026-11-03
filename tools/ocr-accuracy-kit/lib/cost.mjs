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
 * Planning assumptions per page (documented in the README):
 * - first pass: ~2,000 cached prompt tokens, ~900 page tokens, ~4,000 output tokens (thinking + JSON);
 * - re-read: same input, ~5,000 output tokens; expected on about 35% of pages, at most every page.
 */
export const ASSUMPTIONS = {
  cachedPromptTokens: 2_000,
  pageInputTokens: 900,
  firstPassOutputTokens: 4_000,
  rereadOutputTokens: 5_000,
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

function pageCost(model, outputTokens) {
  return usageCost(model, { inputTokens: ASSUMPTIONS.pageInputTokens, outputTokens,
    cacheReadInputTokens: ASSUMPTIONS.cachedPromptTokens, cacheCreationInputTokens: 0 });
}

export function estimate({ pages, features = 'text', firstPassModel = 'claude-sonnet-5-5',
  rereadModel = 'claude-opus-5-5', maxRereadPages = 20 }) {
  const textract = pages * TEXTRACT_PER_1000_PAGES[features] / 1000;
  const firstPass = pages * pageCost(firstPassModel, ASSUMPTIONS.firstPassOutputTokens);
  const rereadOne = pageCost(rereadModel, ASSUMPTIONS.rereadOutputTokens);
  const rereadCap = maxRereadPages > 0 ? 1 : 0;
  const expectedReread = pages * ASSUMPTIONS.expectedRereadShare * rereadOne * rereadCap;
  const worstReread = pages * rereadOne * rereadCap;
  return {
    pages, features, firstPassModel, rereadModel,
    textractUsd: round(textract), firstPassUsd: round(firstPass), expectedRereadUsd: round(expectedReread),
    expectedTotalUsd: round(textract + firstPass + expectedReread),
    upperBoundUsd: round(textract + firstPass + worstReread),
  };
}

export function formatEstimate(e) {
  return [
    `Cost estimate for ${e.pages} pages (planning prices, US$):`,
    `  Textract (${e.features}): $${e.textractUsd.toFixed(2)}`,
    `  AI first pass (${e.firstPassModel}): about $${e.firstPassUsd.toFixed(2)}`,
    `  AI re-reads (${e.rereadModel}, ~${Math.round(ASSUMPTIONS.expectedRereadShare * 100)}% of pages): about $${e.expectedRereadUsd.toFixed(2)}`,
    `  Expected total: about $${e.expectedTotalUsd.toFixed(2)}; at most about $${e.upperBoundUsd.toFixed(2)} if every page is re-read.`,
  ].join('\n');
}

function round(value) { return Math.round(value * 100) / 100; }
