/**
 * The calendar date (YYYY-MM-DD) of a PostgreSQL date column as node-postgres returns it.
 *
 * node-postgres (pg-types) makes a date column a JavaScript Date at local midnight of the
 * process's time zone, so its ISO string is the day before east of UTC (under Africa/Lagos the
 * stored 2026-11-01 becomes 2026-10-31T23:00:00.000Z). Its local year, month and day are the
 * date PostgreSQL stored, whatever TZ the process runs in. A value already read as text passes
 * through unchanged; null and undefined stay absent.
 */
export function calendarDate(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return String(value);
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-`
    + String(value.getDate()).padStart(2, '0');
}
