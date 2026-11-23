import { WORK_LIST_DAYS, workListSince } from './work-list-window';

/*
 * Q123 A: done work is listed if received on or after the Lagos day 90 days
 * before today. "Today" is the Lagos calendar day (UTC+1), whatever the
 * server's own time zone.
 */
describe('workListSince (Q123 A)', () => {
  it('reaches back 90 days', () => {
    expect(WORK_LIST_DAYS).toBe(90);
  });

  it('counts from the Lagos day, which starts at 23:00 UTC the evening before', () => {
    expect(workListSince(new Date('2026-11-19T22:59:59.999Z'))).toBe('2026-08-21');
    expect(workListSince(new Date('2026-11-19T23:00:00.000Z'))).toBe('2026-08-22');
    expect(workListSince(new Date('2026-11-20T12:00:00.000Z'))).toBe('2026-08-22');
  });

  it('crosses months, years and a leap day', () => {
    expect(workListSince(new Date('2026-01-15T12:00:00Z'))).toBe('2025-10-17');
    expect(workListSince(new Date('2026-12-31T23:00:00Z'))).toBe('2026-10-03');
    expect(workListSince(new Date('2028-05-28T22:00:00Z'))).toBe('2028-02-28');
    expect(workListSince(new Date('2028-05-28T23:00:00Z'))).toBe('2028-02-29');
    expect(workListSince(new Date('2028-05-30T12:00:00Z'))).toBe('2028-03-01');
    expect(workListSince(new Date('2027-05-29T12:00:00Z'))).toBe('2027-02-28');
  });

  it('defaults to now', () => {
    expect(workListSince()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
