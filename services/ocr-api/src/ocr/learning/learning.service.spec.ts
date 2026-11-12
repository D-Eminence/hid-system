import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { readDigest } from './learning';
import { OcrLearningService } from './learning.service';

// Fictional fixtures only.
const id = (n: number) => `it-${n.toString(16).padStart(16, '0')}`;
const reading = (name: string) => ({ contract: 'hid-paper-reading-v2', items: [{ id: id(1), kind: 'medicine',
  asWritten: name, plain: 'x', fields: { name, strength: '500 mg', frequency: 'tds' } }] });
const review = (payload: unknown, overrides: Record<string, unknown> = {}) => ({ jobId: 'job-1',
  validationId: '11111111-1111-4111-8111-111111111111', disposition: 'validated', targetDomain: 'PHARMACY',
  acceptedFields: { medications: [{ itemId: id(1), medicationText: 'Amoxicillin', strengthText: '500mg',
    frequencyText: 'tds' }] }, payload, ...overrides });

function client(answer: (sql: string) => unknown = () => ({ rows: [] })) {
  const query = jest.fn(async (sql: string) => answer(sql));
  return { client: { query } as unknown as PoolClient, query, sqls: () => query.mock.calls.map(([sql]) => sql) };
}

describe('OCR learning service', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('records the observations in one savepoint after an accepted review with no suggestion', async () => {
    const db = client();
    await new OcrLearningService().learnFromReview(db.client, review(reading('Amoxicilin')));
    const [, observations] = db.query.mock.calls[1] as unknown as [string, [string, string]];
    expect(JSON.parse(observations[1])).toEqual([{ field: 'name', readDigest: readDigest('name', 'amoxicilin'),
      suggestValue: 'Amoxicillin' }]);
  });

  const displayed = (value: string) => [{ itemId: id(1), ruleId: '22222222-2222-4222-8222-222222222222',
    field: 'name' as const, value }];

  it('records a displayed suggestion taken as a showing, not as new evidence', async () => {
    const db = client();
    await new OcrLearningService().learnFromReview(db.client,
      { ...review(reading('Amoxicilin')), shownSuggestions: displayed('Amoxicillin') });
    expect(db.sqls()).toEqual(['savepoint ocr_learning_review',
      'select ocr.record_correction_observations($1, $2::jsonb)', 'select ocr.learning_after_validation($1, $2::jsonb)',
      'release savepoint ocr_learning_review']);
    const [, observations] = db.query.mock.calls[1] as unknown as [string, [string, string]];
    expect(JSON.parse(observations[1])).toEqual([]);
    const [, showings] = db.query.mock.calls[2] as unknown as [string, [string, string]];
    expect(JSON.parse(showings[1])).toEqual([{ ruleId: '22222222-2222-4222-8222-222222222222', outcome: 'accepted' }]);
  });

  it('records a displayed suggestion not taken as rejected', async () => {
    const db = client();
    await new OcrLearningService().learnFromReview(db.client,
      { ...review(reading('Amoxicilin')), shownSuggestions: displayed('Ampicillin') });
    const [, showings] = db.query.mock.calls[2] as unknown as [string, [string, string]];
    expect(JSON.parse(showings[1])).toEqual([{ ruleId: '22222222-2222-4222-8222-222222222222', outcome: 'rejected' }]);
  });

  it('judges only what was displayed: a rule active at save time but not shown is no showing, its field is evidence',
    async () => {
      const rule = { field_class: 'name', read_digest: readDigest('name', 'amoxicilin'), rule_id: 'r1',
        scope: 'facility', suggest_value: 'Amoxicillin' };
      const db = client((sql) => ({ rows: sql.includes('reading_suggestions') ? [rule] : [] }));
      await new OcrLearningService().learnFromReview(db.client, review(reading('Amoxicilin')));
      expect(db.sqls().some((sql) => sql.includes('reading_suggestions'))).toBe(false);
      const [, observations] = db.query.mock.calls[1] as unknown as [string, [string, string]];
      expect(JSON.parse(observations[1])).toHaveLength(1);
      const [, showings] = db.query.mock.calls[2] as unknown as [string, [string, string]];
      expect(JSON.parse(showings[1])).toEqual([]);
    });

  it('never counts a sensitive value as displayed', async () => {
    const db = client();
    await new OcrLearningService().learnFromReview(db.client,
      { ...review(reading('Amoxicilin')), shownSuggestions: displayed('Truvada') });
    const [, showings] = db.query.mock.calls[2] as unknown as [string, [string, string]];
    expect(JSON.parse(showings[1])).toEqual([]);
  });

  it('does nothing for a rejection, a sensitive reading, a sensitive value saved, or an unlinked review', async () => {
    for (const args of [review(reading('Amoxicilin'), { disposition: 'rejected' }), review(reading('Tenofovir')),
      review(reading('Lamivir'), { acceptedFields: { medications: [{ itemId: id(1), medicationText: 'Lamivudine' }] } }),
      review(reading('Amoxicilin'), { acceptedFields: { medications: [{ itemId: id(1), medicationText: 'Amoxicillin' },
        { medicationText: 'Tenofovir' }] } }),
      review(reading('Amoxicilin'), { acceptedFields: { medicationText: 'Amoxicillin' } })]) {
      const db = client();
      await new OcrLearningService().learnFromReview(db.client, args);
      expect(db.query).not.toHaveBeenCalled();
    }
  });

  it('rolls back to its savepoint and never throws when the database refuses (e.g. no 0118 yet)', async () => {
    const db = client((sql) => {
      if (sql.startsWith('select ocr.record')) throw Object.assign(new Error('function does not exist Amoxicilin'), { code: '42883' });
      return { rows: [] };
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(new OcrLearningService().learnFromReview(db.client, review(reading('Amoxicilin')))).resolves.toBeUndefined();
    expect(db.sqls().at(-1)).toBe('rollback to savepoint ocr_learning_review');
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'ocr.learning.review_failed', code: '42883', jobId: 'job-1' }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Amoxicilin');
  });

  it('looks suggestions up for a reading, and none for a sensitive one or on failure', async () => {
    const rule = { field_class: 'name', read_digest: readDigest('name', 'amoxicilin'), rule_id: 'r1', scope: 'platform',
      suggest_value: 'Amoxicillin' };
    const db = client(() => ({ rows: [rule] }));
    const shown = await new OcrLearningService().suggestionsFor(db.client, 'job-1', reading('Amoxicilin'));
    expect(shown.get(id(1))).toMatchObject({ text: 'Possibly Amoxicillin? Check the paper', scope: 'platform' });
    const sensitive = client(() => ({ rows: [rule] }));
    expect((await new OcrLearningService().suggestionsFor(sensitive.client, 'job-1', reading('Tenofovir'))).size).toBe(0);
    expect(sensitive.query).not.toHaveBeenCalled();
    const failing = client((sql) => { if (sql.includes('reading_suggestions')) throw new Error('boom'); return { rows: [] }; });
    expect((await new OcrLearningService().suggestionsFor(failing.client, 'job-1', reading('Amoxicilin'))).size).toBe(0);
    expect(failing.sqls().at(-1)).toBe('rollback to savepoint ocr_learning_suggestions');
  });
});
