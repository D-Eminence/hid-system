import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import { OcrQualityController } from './quality-summary.controller';
import {
  aggregateReviewOutcomes, MIN_CELL_SIZE, MIN_GROUP_SIZE, MIN_REVIEWERS_FOR_MANAGER, OcrQualityService,
} from './quality-summary.service';
import { computeReviewOutcome } from './review-outcome';

const facilityId = '10000000-0000-4000-8000-000000000001';
const assignment = { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
  organizationId: '30000000-0000-4000-8000-000000000001', name: 'Fictional Clinic', roles: ['records'],
  permissions: ['ocr.job.read', 'ocr.validation.write'], isPrimary: true };
const actor = (platformPermissions: string[], kind: 'staff' | 'patient' = 'staff') => ({ kind, id: 'a',
  subject: 'staff:fictional', accountId: '20000000-0000-4000-8000-000000000001', roles: ['records'],
  permissions: assignment.permissions, facilityIds: [facilityId], facilities: [assignment], facility: assignment,
  authenticationMethod: 'local' as const, platformRoles: [], platformPermissions });
const request = (platformPermissions: string[], kind: 'staff' | 'patient' = 'staff') => ({
  actor: actor(platformPermissions, kind), facilityId, correlationId: 'ocr-quality-correlation',
  header: () => undefined, method: 'GET' }) as unknown as HidRequest;

// A fictional manager of facility A (workforce.manage there), optionally also a records clerk at facility B.
const otherFacilityId = '10000000-0000-4000-8000-000000000002';
const managerAt = (id: string, permissions: string[]) => ({ ...assignment, id, permissions,
  membershipId: id === facilityId ? assignment.membershipId : '40000000-0000-4000-8000-000000000002' });
const managerRequest = (bound: string,
  memberships: (ReturnType<typeof managerAt> & { selfService?: { review: 'pending' | 'reviewed' } })[]) => ({
  actor: { ...actor([]), facilities: memberships, facilityIds: memberships.map((m) => m.id),
    facility: memberships.find((m) => m.id === bound), permissions: memberships.find((m) => m.id === bound)?.permissions ?? [] },
  facilityId: bound, correlationId: 'ocr-quality-correlation', header: () => undefined, method: 'GET' }) as unknown as HidRequest;
const managerOfA = managerAt(facilityId, ['workforce.manage', 'ocr.job.read']);

// A fictional reading and review, computed into a stored outcome.
const box = { left: 0.1, top: 0.1, width: 0.5, height: 0.02 };
const items = [1, 2].map((n) => ({ id: `it-000000000000000${n}`, kind: 'medicine', asWritten: 'Zentoprilax 5mg',
  plain: 'x', dateAsWritten: null, page: 1, lineIds: ['p1-l1'], box, confidence: n === 1 ? 'clear' : 'check_carefully',
  checkReasons: n === 1 ? [] : ['handwritten'], checkReason: null, readBy: 'first_pass', prescription: null,
  fields: { name: 'Zentoprilax', strength: '5mg', form: null, route: null, frequency: 'od', duration: null,
    status: 'current' } }));
const outcome = computeReviewOutcome({ disposition: 'validated', targetDomain: 'PHARMACY', corrections: [],
  acceptedFields: { medications: [{ itemId: 'it-0000000000000001', page: 1, medicationText: 'Zentoprilax',
    strengthText: '5mg', frequencyText: 'od', historicalContext: 'Fictional' }] },
  structuredPayload: { items, reading: { promptVersion: 'hid-paper-reading-prompt-13', status: 'read' } },
  extractionProvenance: {} });
const row = (week = '2026-W45') => ({ week, facility_id: facilityId, outcome });

describe('OCR quality summary', () => {
  it('sums review outcomes by week, facility, kind and prompt version', () => {
    const { itemGroups, reviewGroups } = aggregateReviewOutcomes(Array.from({ length: 10 }, () => row()));
    expect(itemGroups).toEqual([expect.objectContaining({ week: '2026-W45', facilityId, kind: 'medicine',
      promptVersion: 'hid-paper-reading-prompt-13', items: 20,
      decisions: { kept_unchanged: 10, removed: 10 },
      byConfidence: { clear: { kept_unchanged: 10 }, check_carefully: { removed: 10 } },
      checkReasons: { handwritten: { removed: 10 } } })]);
    // 10 reviews: under the minimum, so the review group is suppressed.
    expect(reviewGroups).toEqual([{ week: '2026-W45', facilityId, promptVersion: 'hid-paper-reading-prompt-13',
      suppressed: true }]);
  });

  it(`suppresses any group with fewer than ${MIN_GROUP_SIZE} items, returning no counts`, () => {
    // 9 reviews x 2 items = 18 items.
    const { itemGroups } = aggregateReviewOutcomes(Array.from({ length: 9 }, () => row()));
    expect(itemGroups).toEqual([{ week: '2026-W45', facilityId, kind: 'medicine',
      promptVersion: 'hid-paper-reading-prompt-13', suppressed: true }]);
    const { reviewGroups } = aggregateReviewOutcomes(Array.from({ length: 20 }, () => row()));
    expect(reviewGroups[0]).toMatchObject({ reviews: 20, validated: 20 });
    expect(reviewGroups[0]).not.toHaveProperty('suppressed');
  });

  it('counts failed summaries per review group and ignores rows that are not review outcomes', () => {
    const failed = { week: '2026-W45', facility_id: facilityId,
      outcome: { schema: 'hid.ocr.review-outcome/v1', error: 'summary_failed' } };
    const { reviewGroups } = aggregateReviewOutcomes([...Array.from({ length: 20 }, () => failed),
      { week: '2026-W45', facility_id: facilityId, outcome: { schema: 'other' } }]);
    expect(reviewGroups).toEqual([expect.objectContaining({ reviews: 20, summaryFailed: 20, promptVersion: null })]);
  });

  it(`leaves out reason counts under ${MIN_CELL_SIZE} inside a group that is shown`, () => {
    const rejected = (code: string) => ({ week: '2026-W45', facility_id: facilityId, outcome: { ...outcome,
      disposition: 'rejected', reviewer: { ...outcome.reviewer, rejectionReasonCode: code } } });
    const { reviewGroups } = aggregateReviewOutcomes([...Array.from({ length: 19 }, () => rejected('unreadable')),
      rejected('wrong_patient')]);
    expect(reviewGroups[0]).toMatchObject({ reviews: 20, rejectionReasons: { unreadable: 19 }, smallCellsHidden: 1 });
    expect(JSON.stringify(reviewGroups)).not.toContain('wrong_patient');
  });

  it('counts a stored code named like an Object property as an ordinary code', () => {
    const odd = { ...outcome, buckets: outcome.buckets.map((bucket) => ({ ...bucket, checkReasons: { constructor: 1 } })) };
    const { itemGroups } = aggregateReviewOutcomes(Array.from({ length: 20 }, () => ({ week: '2026-W45',
      facility_id: facilityId, outcome: odd })));
    expect((itemGroups[0] as { checkReasons: Record<string, Record<string, number>> }).checkReasons.constructor)
      .toMatchObject({ kept_unchanged: 20, removed: 20 });
    expect((Object as unknown as Record<string, unknown>).removed).toBeUndefined();
  });

  describe('route', () => {
    // reviewers: how many distinct reviewers saved the rows (round-robin), keyed as the database would for a manager.
    const harness = (outcomeRows: Record<string, unknown>[] = Array.from({ length: 20 }, () => row()), reviewers = 3) => {
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        const rows = sql.includes('reviewer_key')
          ? outcomeRows.map((r, i) => ({ reviewer_key: `key-${i % reviewers}`, ...r })) : outcomeRows;
        return { rows, rowCount: rows.length };
      });
      const database = { withTransaction: jest.fn(async <T>(_c: DataAccessContext,
        operation: (client: PoolClient) => Promise<T>) => operation({ query } as unknown as PoolClient)) } as unknown as DatabaseService;
      const audit = { recordWithClient: jest.fn(async () => undefined) } as unknown as AuditService;
      const service = new OcrQualityService(database, audit);
      return { controller: new OcrQualityController(service), query, audit, database };
    };

    it.each([
      ['a facility user with OCR permissions only', request([])],
      ['an administrator without platform.operations.read', request(['platform.admin.access'])],
      ['an operations reader without platform.admin.access', request(['platform.operations.read'])],
      ['a patient', request(['platform.admin.access', 'platform.operations.read'], 'patient')],
      ['a manager of facility A reading facility B, where they are not a member', managerRequest(otherFacilityId, [managerOfA])],
      ['a manager of facility A reading facility B, where they hold no workforce.manage',
        managerRequest(otherFacilityId, [managerOfA, managerAt(otherFacilityId, ['ocr.job.read', 'ocr.validation.write'])])],
      ['the manager of a facility still awaiting support review',
        managerRequest(facilityId, [{ ...managerOfA, selfService: { review: 'pending' as const } }])],
    ])('refuses %s with 403 and reads nothing', async (_name, req) => {
      const { controller, database } = harness();
      expect(() => controller.summary({}, req)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
      expect(database.withTransaction).not.toHaveBeenCalled();
    });

    it('answers a platform administrator and audits the read with ids and counts only', async () => {
      const { controller, query, audit } = harness();
      const answer = await controller.summary({ from: '2026-11-02', to: '2026-11-08' },
        request(['platform.admin.access', 'platform.operations.read']));
      expect(answer).toMatchObject({ schema: 'hid.ocr.quality-summary/v1', scope: 'bound_facility',
        from: '2026-11-02', to: '2026-11-08', truncated: false, minGroupSize: 20 });
      expect((query.mock.calls[0] as unknown[])[1]).toEqual(['2026-11-02', '2026-11-08', 'hid.ocr.review-outcome/v1', 50_001]);
      const event = ((audit.recordWithClient as jest.Mock).mock.calls as [PoolClient, Record<string, unknown>][])[0]?.[1];
      expect(event).toMatchObject({ action: 'ocr.quality.summary.read', facilityId, resourceType: 'ocr-quality-summary',
        details: { from: '2026-11-02', to: '2026-11-08', reviews: 20, truncated: false, itemGroups: 1,
          reviewGroups: 1, suppressedGroups: 0 } });
      expect(event).not.toHaveProperty('patientId');
      for (const text of ['Zentoprilax', 'Fictional', 'it-000', 'staff:fictional']) {
        expect(JSON.stringify(answer)).not.toContain(text);
        if (text !== 'staff:fictional') expect(JSON.stringify(event?.details)).not.toContain(text);
      }
    });

    it('answers the manager of the bound facility with that facility only, when 3 or more reviewers contributed', async () => {
      for (const membership of [managerOfA, { ...managerOfA, selfService: { review: 'reviewed' as const } }]) {
        const { controller, database, audit, query } = harness(undefined, MIN_REVIEWERS_FOR_MANAGER);
        const answer = await controller.summary({ from: '2026-11-02', to: '2026-11-08' }, managerRequest(facilityId, [membership]));
        expect(answer).toMatchObject({ scope: 'bound_facility', available: true, truncated: false,
          itemGroups: [expect.objectContaining({ items: 40 })], reviewGroups: [expect.objectContaining({ reviews: 20 })] });
        expect((database.withTransaction as jest.Mock).mock.calls[0]?.[0]).toMatchObject({ facilityId });
        const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
        expect(sql).toContain('sha256(convert_to($5::text || validation.validated_by::text');
        expect(params.slice(0, 4)).toEqual(['2026-11-02', '2026-11-08', 'hid.ocr.review-outcome/v1', 50_001]);
        expect(params[4]).toMatch(/^[0-9a-f]{64}$/);
        const event = ((audit.recordWithClient as jest.Mock).mock.calls as [PoolClient, Record<string, unknown>][])[0]?.[1];
        expect(event).toMatchObject({ action: 'ocr.quality.summary.read', facilityId,
          details: { reader: 'facility_manager', available: true } });
        expect(JSON.stringify([answer, event])).not.toContain('key-');
      }
    });

    it('keys reviewers afresh on every request', async () => {
      const { controller, query } = harness();
      await controller.summary({}, managerRequest(facilityId, [managerOfA]));
      await controller.summary({}, managerRequest(facilityId, [managerOfA]));
      const keys = query.mock.calls.map((call) => (call as unknown as [string, unknown[]])[1][4]);
      expect(keys[0]).not.toEqual(keys[1]);
    });

    it.each([1, 2])('answers a manager "too few reviewers" with no figures when %i reviewer(s) contributed', async (n) => {
      const { controller, audit } = harness(undefined, n);
      const answer = await controller.summary({ from: '2026-11-02', to: '2026-11-08' }, managerRequest(facilityId, [managerOfA]));
      expect(answer).toEqual({ schema: 'hid.ocr.quality-summary/v1', from: '2026-11-02', to: '2026-11-08',
        scope: 'bound_facility', available: false, reason: 'too_few_reviewers' });
      const event = ((audit.recordWithClient as jest.Mock).mock.calls as [PoolClient, Record<string, unknown>][])[0]?.[1];
      expect(event?.details).toEqual({ from: '2026-11-02', to: '2026-11-08', reader: 'facility_manager', available: false });
    });

    it('suppresses, for a manager, a week that fewer than 3 reviewers did, even when the range has 3', async () => {
      // W44: 20 reviews by one reviewer; W45: 20 reviews by three.
      const rows = [...Array.from({ length: 20 }, () => ({ ...row('2026-W44'), reviewer_key: 'key-solo' })),
        ...Array.from({ length: 20 }, () => row('2026-W45'))];
      const { controller } = harness(rows, 3);
      const answer = await controller.summary({ from: '2026-10-26', to: '2026-11-08' },
        managerRequest(facilityId, [managerOfA])) as { itemGroups: unknown[]; reviewGroups: unknown[] };
      expect(answer.reviewGroups).toEqual([
        { week: '2026-W44', facilityId, promptVersion: 'hid-paper-reading-prompt-13', suppressed: true },
        expect.objectContaining({ week: '2026-W45', reviews: 20 })]);
      expect(answer.itemGroups).toEqual([
        { week: '2026-W44', facilityId, kind: 'medicine', promptVersion: 'hid-paper-reading-prompt-13', suppressed: true },
        expect.objectContaining({ week: '2026-W45', items: 40 })]);
      // A platform administrator sees both weeks.
      const admin = harness(rows, 3);
      const all = await admin.controller.summary({ from: '2026-10-26', to: '2026-11-08' },
        request(['platform.admin.access', 'platform.operations.read'])) as { reviewGroups: unknown[] };
      expect(all.reviewGroups).toEqual([expect.objectContaining({ week: '2026-W44', reviews: 20 }),
        expect.objectContaining({ week: '2026-W45', reviews: 20 })]);
    });

    it('never applies the reviewer minimum to a platform administrator', async () => {
      const { controller, query } = harness(undefined, 1);
      const answer = await controller.summary({ from: '2026-11-02', to: '2026-11-08' },
        request(['platform.admin.access', 'platform.operations.read']));
      expect(answer).toMatchObject({ available: true, itemGroups: [expect.objectContaining({ items: 40 })] });
      const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
      expect(sql).not.toContain('reviewer_key');
      expect(params).toHaveLength(4);
    });

    it('widens the range to whole ISO weeks so a one-day difference cannot be subtracted', async () => {
      const { controller, query } = harness();
      const answer = await controller.summary({ from: '2026-11-04', to: '2026-11-10' },
        request(['platform.admin.access', 'platform.operations.read']));
      expect(answer).toMatchObject({ from: '2026-11-02', to: '2026-11-15' });
      expect((query.mock.calls[0] as unknown[])[1]).toEqual(expect.arrayContaining(['2026-11-02', '2026-11-15']));
    });

    it.each([
      [{ from: '2026-11-09', to: '2026-11-01' }],
      [{ from: '2026-01-01', to: '2026-12-31' }],
      [{ from: '2026-02-30', to: '2026-03-01' }],
    ])('refuses an invalid range %o with 400', async (range) => {
      const { controller } = harness();
      await expect(controller.summary(range, request(['platform.admin.access', 'platform.operations.read'])))
        .rejects.toMatchObject({ code: 'OCR_QUALITY_RANGE_INVALID' });
    });
  });
});
