import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { types } from 'pg';
import { calendarDate } from './calendar-date';

// node-postgres (pg-types) makes a date column a JavaScript Date at local midnight of the
// process's time zone. The EHR API sends a prescription's start and end dates to Pharmacy, and
// since 0100 the database compares them exactly with the stored dates, so they must be the
// calendar dates PostgreSQL stored whatever TZ the EHR API runs in. Jest cannot change the time
// zone of its own process, so each zone runs in a child node with TZ set, through the real
// node-postgres parser and this module.
const DATES = ['2026-11-01', '2026-12-31', '2027-01-01', '2026-03-29', '2026-10-25', '2028-02-29'];
const serviceRoot = resolve(__dirname, '../../..');
const probe = `
const { types } = require('pg');
const { calendarDate } = require(${JSON.stringify(join(__dirname, 'calendar-date.ts'))});
const parse = types.getTypeParser(1082);
process.stdout.write(JSON.stringify(${JSON.stringify(DATES)}.map((text) => {
  const value = parse(text);
  return { text, iso: value.toISOString(), calendar: calendarDate(value) };
})));`;

describe('calendarDate', () => {
  it.each(['Africa/Lagos', 'UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati',
    'Pacific/Pago_Pago'])('gives the stored date of a node-postgres date under TZ=%s', (zone) => {
    const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', probe],
      { cwd: serviceRoot, env: { ...process.env, TZ: zone }, encoding: 'utf8', timeout: 60_000 });
    expect(child.stderr).toBe('');
    const results = JSON.parse(child.stdout) as Array<{ text: string; iso: string; calendar: string }>;
    expect(results.map((result) => result.calendar)).toEqual(DATES);
    if (zone === 'Africa/Lagos') {
      // The zone took effect: the Date's ISO string (what the EHR API sent before) is the day before.
      expect(results[0]).toMatchObject({ iso: '2026-10-31T23:00:00.000Z', calendar: '2026-11-01' });
    }
  });

  it('passes text through and leaves null and undefined absent', () => {
    expect(calendarDate('2026-08-17')).toBe('2026-08-17');
    expect(calendarDate(null)).toBeUndefined();
    expect(calendarDate(undefined)).toBeUndefined();
    expect(calendarDate((types.getTypeParser(1082) as (text: string) => Date)('2026-11-01'))).toBe('2026-11-01');
  });
});
