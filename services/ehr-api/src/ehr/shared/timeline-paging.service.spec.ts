import type { DataAccessContext } from '../../common/request-context';
import { ClinicalNotesService } from '../clinical-notes/clinical-notes.service';
import { DiagnosesService } from '../diagnoses/diagnoses.service';
import { EncountersService } from '../encounters/encounters.service';
import { LabRequestsService } from '../lab-requests/lab-requests.service';
import { PrescriptionsService } from '../prescriptions/prescriptions.service';
import { VitalsService } from '../vitals/vitals.service';
import { decodeTimelineCursor } from './clinical-context';
import type { TimelineQueryDto } from './clinical.dto';

// Each of the six newest-first clinical lists reads its sort key as text at
// microsecond precision and pages on it. node-postgres returns a timestamptz
// as a JavaScript Date, which keeps only milliseconds, so a cursor built from
// the Date made the next page skip rows within the last row's millisecond.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const context = { correlationId: 'correlation-123456', facilityId } as DataAccessContext;
const microseconds = '2026-10-11T08:00:00.123456Z';
const ids = ['a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001'];

interface ListCase {
  label: string;
  list: string;
  column: string;
  field: string;
  /** The 1-based parameter that binds the cursor's timestamp; the id follows it. */
  cursorParameter: number;
  page: (repository: unknown, query: TimelineQueryDto) => Promise<{ items: readonly object[]; nextCursor: string | null }>;
}
const cases: ListCase[] = [
  { label: 'encounters', list: 'ehr.encounters', column: 'started_at', field: 'startedAt', cursorParameter: 3,
    page: (r, q) => new EncountersService(r as never).list(context, patientId, q) },
  { label: 'clinical notes', list: 'ehr.clinical-notes', column: 'created_at', field: 'createdAt', cursorParameter: 4,
    page: (r, q) => new ClinicalNotesService(r as never).list(context, patientId, encounterId, q) },
  { label: 'diagnoses', list: 'ehr.diagnoses', column: 'created_at', field: 'createdAt', cursorParameter: 4,
    page: (r, q) => new DiagnosesService(r as never).list(context, patientId, encounterId, q) },
  { label: 'lab requests', list: 'ehr.lab-requests', column: 'created_at', field: 'createdAt', cursorParameter: 4,
    page: (r, q) => new LabRequestsService(r as never, {} as never).list(context, patientId, encounterId, q) },
  { label: 'prescriptions', list: 'ehr.prescriptions', column: 'created_at', field: 'createdAt', cursorParameter: 4,
    page: (r, q) => new PrescriptionsService(r as never, {} as never).list(context, patientId, encounterId, q) },
  { label: 'vitals', list: 'ehr.vitals', column: 'recorded_at', field: 'recordedAt', cursorParameter: 4,
    page: (r, q) => new VitalsService(r as never).list(context, patientId, encounterId, q) },
];

describe.each(cases)('$label list paging', ({ list, column, field, cursorParameter, page }) => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const repository = { run: jest.fn(async (_c, _p, _a, _e, operation) => (await operation({
    query: jest.fn(async (sql: string, values: unknown[]) => {
      statements.push({ sql, values });
      // The Date field has milliseconds only, as node-postgres returns it; the text column keeps microseconds.
      return { rows: ids.map((id) => ({ id, [field]: new Date('2026-10-11T08:00:00.123Z'), cursorAt: microseconds })) };
    }),
  })).value) };
  const scope = { list, patientId, ...(list === 'ehr.encounters' ? {} : { encounterId }) };

  beforeEach(() => { statements.length = 0; });

  it('selects the sort key as microsecond text and pages on it', async () => {
    const first = await page(repository, { limit: 2 } as TimelineQueryDto);
    expect(statements[0]?.sql).toContain(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"`);
    expect(first.items).toHaveLength(2);
    expect(first.items.every((item) => !('cursorAt' in item))).toBe(true);
    expect(decodeTimelineCursor(first.nextCursor ?? undefined, scope)).toEqual({ sortAt: microseconds, id: ids[1] });

    await page(repository, { limit: 2, cursor: first.nextCursor ?? undefined } as TimelineQueryDto);
    expect(statements[1]?.values.slice(cursorParameter - 1, cursorParameter + 1)).toEqual([microseconds, ids[1]]);
  });
});
