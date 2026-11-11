import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import { OcrQualityController } from './quality-summary.controller';
import { aggregateReviewOutcomes, MIN_CELL_SIZE, MIN_GROUP_SIZE, OcrQualityService } from './quality-summary.service';
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

  describe('route', () => {
    const harness = (outcomeRows: unknown[] = Array.from({ length: 20 }, () => row())) => {
      const query = jest.fn(async () => ({ rows: outcomeRows, rowCount: outcomeRows.length }));
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
