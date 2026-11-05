import { isStrictIsoDate, lagosToday, paperDateToIso } from './paper-date';

const today = '2026-11-05';

describe('paper dates: converted only when the text is unambiguous', () => {
  it.each([
    ['12/03/2025', '2025-03-12T00:00:00.000Z'],
    ['5/6/2024', '2024-06-05T00:00:00.000Z'],
    ['05-06-2024', '2024-06-05T00:00:00.000Z'],
    ['05.06.2024', '2024-06-05T00:00:00.000Z'],
    ['1st April 2024', '2024-04-01T00:00:00.000Z'],
    ['22nd Feb, 2024', '2024-02-22T00:00:00.000Z'],
    ['3 SEPT 2023', '2023-09-03T00:00:00.000Z'],
    ['  12   March   2025 ', '2025-03-12T00:00:00.000Z'],
    ['Mar 5, 2024', '2024-03-05T00:00:00.000Z'],
    ['March 5 2024', '2024-03-05T00:00:00.000Z'],
    ['Dec. 31st, 1999', '1999-12-31T00:00:00.000Z'],
    ['29/02/2024', '2024-02-29T00:00:00.000Z'],
    ['2025-03-12', '2025-03-12'],
    ['2025-03-12T09:30:00+01:00', '2025-03-12T09:30:00+01:00'],
    ['05/11/2026', '2026-11-05T00:00:00.000Z'],
  ])('%s gives %s', (text, iso) => {
    expect(paperDateToIso(text, today).iso).toBe(iso);
  });

  it.each([
    ['29/02/2023', 'invalid_date'],
    ['31/04/2024', 'invalid_date'],
    ['12/25/2024', 'invalid_date'],
    ['00/01/2024', 'invalid_date'],
    ['2024-13-01', 'invalid_date'],
    ['12/03/25', 'two_digit_year'],
    ['12 March 25', 'two_digit_year'],
    ['March 2025', 'partial'],
    ['Mar 2025', 'partial'],
    ['03/2025', 'partial'],
    ['2025', 'partial'],
    ['2025-03', 'partial'],
    ['06/11/2026', 'future'],
    ['2027-01-01', 'future'],
    ['12/03/1899', 'too_old'],
    ['approx 12/03/2025', 'ambiguous'],
    ['12/03/2025 approx', 'ambiguous'],
    ['last week', 'ambiguous'],
    ['12-14/03/2025', 'ambiguous'],
    ['12 Foo 2025', 'ambiguous'],
    ['12/03-2025', 'ambiguous'],
    ['12/03/02025', 'ambiguous'],
    ['12 / 03 / 2025', 'ambiguous'],
    ['', 'ambiguous'],
  ])('%s is kept as written only (%s)', (text, reason) => {
    expect(paperDateToIso(text, today)).toEqual({ iso: null, reason });
  });

  it('reads today in Lagos (UTC+1)', () => {
    expect(lagosToday(new Date('2026-11-05T22:59:59Z'))).toBe('2026-11-05');
    expect(lagosToday(new Date('2026-11-05T23:00:00Z'))).toBe('2026-11-06');
  });

  it('recognises the ISO forms Lab accepts unchanged', () => {
    expect(isStrictIsoDate('2025-03-12')).toBe(true);
    expect(isStrictIsoDate('2025-03-12T09:30:00.000Z')).toBe(true);
    expect(isStrictIsoDate('12/03/2025')).toBe(false);
    expect(isStrictIsoDate('2025-03')).toBe(false);
  });
});
