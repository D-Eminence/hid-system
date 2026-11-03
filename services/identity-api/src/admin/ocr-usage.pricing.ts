/**
 * A rough cost estimate for one facility's OCR month, shown to platform administrators next to the counts
 * (GET /admin/facilities/:facilityId/ocr-usage). It is an estimate from list prices in US dollars, not an
 * invoice: provider discounts, taxes, regional pricing and currency are not taken into account.
 *
 * Price table (coordinator decision, 2026-11-03):
 *
 * | Item                               | Price                                 |
 * |------------------------------------|---------------------------------------|
 * | Amazon Textract DetectDocumentText | $1.50 per 1,000 pages                 |
 * | claude-sonnet-5-5                  | $2 / M input, $10 / M output tokens   |
 * | claude-opus-5-5                    | $4 / M input, $20 / M output tokens   |
 * | Prompt cache read (both)           | $0.20 / M tokens                      |
 * | Prompt cache write (both)          | 1.25 x the model's input price        |
 *
 * The cache-write price is not in the agreed table; it is the standard five-minute prompt-cache write rate
 * (the worker's system prompt uses the default ephemeral cache). A model not in the table (a new first-pass or
 * re-read model) makes the whole estimate null rather than a number that leaves it out.
 */
export const TEXTRACT_USD_PER_PAGE = 1.5 / 1_000;

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export const MODEL_PRICES_USD: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-sonnet-5-5': { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 },
  'claude-opus-5-5': { inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.2, cacheWritePerMillion: 5 },
});

export interface ModelUsageForCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** US dollars rounded to 4 decimal places, or null when a model's price is not known. */
export function estimateOcrCostUsd(textractPages: number, models: readonly ModelUsageForCost[]): number | null {
  let total = textractPages * TEXTRACT_USD_PER_PAGE;
  for (const usage of models) {
    const price = Object.hasOwn(MODEL_PRICES_USD, usage.model) ? MODEL_PRICES_USD[usage.model] : undefined;
    if (!price) return null;
    total += (usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion
      + usage.cacheReadTokens * price.cacheReadPerMillion + usage.cacheWriteTokens * price.cacheWritePerMillion)
      / 1_000_000;
  }
  return Math.round(total * 10_000) / 10_000;
}
