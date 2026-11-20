/**
 * How far back the work list reaches (owner decision Q123 A): open work of
 * any age, plus done work received on or after `since`, the Lagos calendar
 * day (Africa/Lagos, UTC+1, no daylight saving) WORK_LIST_DAYS days before
 * today. The day is worked out here from the server's clock, as ehr-api's
 * visit desk does (lagos-day.ts), and handed to PostgreSQL as a date; the
 * database turns it into that day's Lagos midnight
 * (`$n::date::timestamp at time zone 'Africa/Lagos'`). The answer carries
 * `since` so the screen can say how far back it shows.
 */
export const WORK_LIST_DAYS = 90;

const LAGOS_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Lagos',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The first Lagos day (YYYY-MM-DD) whose done work the list shows, at `now`. */
export function workListSince(now: Date = new Date()): string {
  const parts = Object.fromEntries(LAGOS_DATE.formatToParts(now).map((part) => [part.type, part.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - WORK_LIST_DAYS));
  return day.toISOString().slice(0, 10);
}
