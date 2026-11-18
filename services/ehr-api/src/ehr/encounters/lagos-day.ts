/**
 * "Today" for the visit desk is the calendar day in Lagos (Africa/Lagos,
 * UTC+1, no daylight saving) until international settings (P2-4) arrive.
 * The day is worked out here from the server's clock and handed to
 * PostgreSQL as a date; the database turns it into the Lagos midnights that
 * bound the day (`$n::date::timestamp at time zone 'Africa/Lagos'`).
 */
export const VISIT_DAY_TIME_ZONE = 'Africa/Lagos';

const LAGOS_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: VISIT_DAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Lagos calendar date (YYYY-MM-DD) of an instant. */
export function lagosCalendarDate(instant: Date): string {
  const parts = Object.fromEntries(LAGOS_DATE.formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** SQL bounds of a Lagos day held in parameter `$n` (a YYYY-MM-DD date). */
export function lagosDaySql(column: string, parameter: number): string {
  return `${column} >= ($${parameter}::date::timestamp at time zone '${VISIT_DAY_TIME_ZONE}')
     and ${column} < (($${parameter}::date + 1)::timestamp at time zone '${VISIT_DAY_TIME_ZONE}')`;
}
