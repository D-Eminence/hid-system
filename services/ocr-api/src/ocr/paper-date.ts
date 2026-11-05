/**
 * Dates written on paper records are kept as written. A real date is derived
 * from the text only when the text is unambiguous, and never guessed.
 *
 * The rule (the website states it to reviewers in these words):
 * - Spaces are trimmed and squeezed; month names match in any letter case.
 * - The whole text must be one of:
 *   (a) day/month/year with "/", "-" or "." between them, day first as used in
 *       Nigeria (05/06/2024 is 5 June 2024);
 *   (b) day, month name, year ("1st April 2024", "12 Mar, 2025");
 *   (c) month name, day, year ("Mar 5, 2024", "March 5 2024");
 *   (d) an ISO date "2025-03-12", optionally with an ISO time ("T10:00",
 *       "T10:00:00", optionally with a fraction) and optionally a zone ("Z",
 *       "+01:00", "+0100"), the forms Lab's ISO 8601 check accepts. The time
 *       must be a real time (hours 00-23, minutes and seconds 00-59).
 * - The year has 4 digits and is 1900 or later.
 * - The date exists on the calendar (29/02/2023 does not).
 * - The date is not later than today in Lagos (Africa/Lagos, UTC+1, no
 *   daylight saving).
 * Anything else (a 2-digit year, a month and year only, a year only, a range,
 * extra words such as "approx" or "last week") is kept as written only.
 *
 * Forms (a)-(c) give midnight UTC of that day (YYYY-MM-DDT00:00:00.000Z), which
 * is the same calendar day in UTC and in Lagos. Form (d) is returned unchanged.
 */
export type PaperDateRefusal = 'ambiguous' | 'partial' | 'two_digit_year' | 'invalid_date' | 'future' | 'too_old';
export type PaperDateResult = { iso: string } | { iso: null; reason: PaperDateRefusal };

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-](\d{2}):?(\d{2}))?)?$/;
const NUMERIC = /^(\d{1,2})([/.-])(\d{1,2})\2(\d+)$/;
const DAY_MONTH_YEAR = /^(\d{1,2})(st|nd|rd|th)? ([a-z]+)\.?,? (\d+)$/;
const MONTH_DAY_YEAR = /^([a-z]+)\.? (\d{1,2})(st|nd|rd|th)?,? (\d+)$/;
const PARTIAL = [
  /^\d{4}$/,
  /^\d{4}-\d{1,2}$/,
  /^\d{1,2}[/.-]\d{4}$/,
  /^[a-z]+\.?,? \d{4}$/,
];

/** Today's calendar date in Lagos (UTC+1 all year), as YYYY-MM-DD. */
export function lagosToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** True for the ISO forms Lab accepts unchanged: YYYY-MM-DD, optionally with a time and optionally a zone. */
export function isStrictIsoDate(text: string): boolean {
  return ISO_DATE.test(text);
}

/**
 * The instant and calendar day of an ISO value Lab receives. A value without a
 * zone is read as UTC, as the HID database (TimeZone UTC) reads it into
 * timestamptz. The day of a value with a zone is its day in Lagos; the day of a
 * value without one is the day written in it.
 */
export function isoDateFacts(iso: string): { instant: number; day: string } {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new Error('isoDateFacts needs an ISO date');
  const [, year = '', month = '', day = '', hour, minute, second, fraction, zone] = match;
  const written = `${year}-${month}-${day}`;
  const time = hour === undefined ? '00:00:00.000'
    : `${hour}:${minute}:${second ?? '00'}${(fraction ?? '.000').slice(0, 4).padEnd(4, '0')}`;
  const offset = zone === undefined || zone === 'Z' ? 'Z'
    : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const instant = Date.parse(`${written}T${time}${offset}`);
  return { instant, day: zone === undefined ? written : lagosToday(new Date(instant)) };
}

export function paperDateToIso(text: string, today: string): PaperDateResult {
  const squeezed = text.trim().replace(/\s+/g, ' ');
  const iso = ISO_DATE.exec(squeezed);
  if (iso) {
    const [, year = '', month = '', day = '', hour, minute, second, , , zoneHour, zoneMinute] = iso;
    if (Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59 || Number(second ?? 0) > 59
      || Number(zoneHour ?? 0) > 23 || Number(zoneMinute ?? 0) > 59) {
      return { iso: null, reason: 'invalid_date' };
    }
    return check(Number(year), Number(month), Number(day), year.length, today, squeezed);
  }
  const lower = squeezed.toLowerCase();
  const numeric = NUMERIC.exec(lower);
  if (numeric) {
    const [, day = '', , month = '', year = ''] = numeric;
    return check(Number(year), Number(month), Number(day), year.length, today);
  }
  const dayFirst = DAY_MONTH_YEAR.exec(lower);
  if (dayFirst) {
    const [, day = '', , name = '', year = ''] = dayFirst;
    const month = MONTHS[name];
    if (!month) return { iso: null, reason: 'ambiguous' };
    return check(Number(year), month, Number(day), year.length, today);
  }
  const monthFirst = MONTH_DAY_YEAR.exec(lower);
  if (monthFirst) {
    const [, name = '', day = '', , year = ''] = monthFirst;
    const month = MONTHS[name];
    if (!month) return { iso: null, reason: 'ambiguous' };
    return check(Number(year), month, Number(day), year.length, today);
  }
  if (PARTIAL.some((pattern) => pattern.test(lower))) {
    const words = lower.match(/[a-z]+/);
    if (!words || MONTHS[words[0] ?? '']) return { iso: null, reason: 'partial' };
  }
  return { iso: null, reason: 'ambiguous' };
}

function check(year: number, month: number, day: number, yearDigits: number, today: string,
  passThrough?: string): PaperDateResult {
  if (yearDigits === 2) return { iso: null, reason: 'two_digit_year' };
  if (yearDigits !== 4) return { iso: null, reason: 'ambiguous' };
  if (year < 1900) return { iso: null, reason: 'too_old' };
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { iso: null, reason: 'invalid_date' };
  }
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (date > today) return { iso: null, reason: 'future' };
  return { iso: passThrough ?? `${date}T00:00:00.000Z` };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
