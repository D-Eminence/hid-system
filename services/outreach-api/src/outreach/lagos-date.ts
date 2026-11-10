/** Today's calendar date in Africa/Lagos (UTC+1, no daylight saving), YYYY-MM-DD. */
export function lagosToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(now);
}

/** A real calendar date written YYYY-MM-DD, from 2020-01-01 (the database's floor). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2020-01-01') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
