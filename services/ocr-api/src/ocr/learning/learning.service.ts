import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  acceptedFieldsAreSensitive, itemSuggestions, linkedFieldPairs, observationsFor, pairsAreSensitive, readingMayLearn,
  showingsFor,
  suggestionKeys,
  type ItemSuggestion, type LearningField, type RuleSuggestion,
} from './learning';

/** The SQLSTATE of a database error, or a fixed code: the only thing ever logged (no text, no values). */
const failureCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
};

interface SuggestionRow { field_class: string; read_digest: string; rule_id: string; scope: string;
  suggest_value: string }

/**
 * The database side of OCR learning (0118, 0119). Every call runs inside its own savepoint and never fails the
 * request: a review is saved and a reading is shown whether or not learning worked (on a database without 0118/0119
 * the functions are missing and nothing is learned or suggested). Logs carry a code and the job id only.
 */
@Injectable()
export class OcrLearningService {
  private readonly logger = new Logger(OcrLearningService.name);

  /** The active suggestion of each item of a reading (by item id); empty when none, sensitive or on failure. */
  async suggestionsFor(client: PoolClient, jobId: string, payload: unknown): Promise<Map<string, ItemSuggestion>> {
    const keys = suggestionKeys(payload);
    if (keys.length === 0 || !readingMayLearn(payload)) return new Map();
    try {
      const rules = await this.inSavepoint(client, 'ocr_learning_suggestions', () => this.lookUp(client, keys));
      return itemSuggestions(keys, rules);
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'ocr.learning.suggestions_failed', code: failureCode(error), jobId }));
      return new Map();
    }
  }

  /**
   * After an accepted review committed, in its own READ COMMITTED transaction (OcrService.validate): records its
   * corrected fields (0118), whether each suggestion shown was taken, and lets the database retire and switch rules on
   * (0119). Nothing for a rejection, a sensitive reading or a review saving a sensitive value. Learning never shares
   * the validation's SERIALIZABLE transaction, so it can neither abort nor delay the save.
   */
  async learnFromReview(client: PoolClient, review: { jobId: string; validationId: string; disposition: string;
    targetDomain: string; acceptedFields: unknown; payload: unknown }): Promise<void> {
    if (review.disposition !== 'validated' || !readingMayLearn(review.payload)) return;
    const pairs = linkedFieldPairs(review.targetDomain, review.acceptedFields, review.payload);
    if (pairs.length === 0 || pairsAreSensitive(pairs) || acceptedFieldsAreSensitive(review.acceptedFields)) return;
    try {
      await this.inSavepoint(client, 'ocr_learning_review', async () => {
        const keys = suggestionKeys(review.payload);
        const shown = itemSuggestions(keys, keys.length ? await this.lookUp(client, keys) : []);
        await client.query('select ocr.record_correction_observations($1, $2::jsonb)',
          [review.validationId, JSON.stringify(observationsFor(pairs, shown))]);
        await client.query('select ocr.learning_after_validation($1, $2::jsonb)',
          [review.validationId, JSON.stringify(showingsFor(pairs, shown))]);
      });
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'ocr.learning.review_failed', code: failureCode(error),
        jobId: review.jobId }));
    }
  }

  private async lookUp(client: PoolClient, keys: readonly { field: LearningField; readDigest: string }[]):
    Promise<RuleSuggestion[]> {
    const unique = [...new Map(keys.map((key) => [`${key.field}|${key.readDigest}`,
      { field: key.field, readDigest: key.readDigest }])).values()];
    const result = await client.query<SuggestionRow>(
      'select field_class, read_digest, rule_id::text, scope, suggest_value from ocr.reading_suggestions($1::jsonb)',
      [JSON.stringify(unique)]);
    return (result?.rows ?? []).map((row) => ({ field: row.field_class as LearningField, readDigest: row.read_digest,
      ruleId: row.rule_id, scope: row.scope === 'platform' ? 'platform' : 'facility', value: row.suggest_value }));
  }

  private async inSavepoint<T>(client: PoolClient, name: string, work: () => Promise<T>): Promise<T> {
    await client.query(`savepoint ${name}`);
    try {
      const value = await work();
      await client.query(`release savepoint ${name}`);
      return value;
    } catch (error) {
      await client.query(`rollback to savepoint ${name}`);
      throw error;
    }
  }
}
