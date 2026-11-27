jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptableStaffPersonName, hasReservedWord } from '../identity/staff-names';
import {
  CHANGE_OWN_DISPLAY_NAME_SQL, CHANGE_OWN_PASSWORD_SQL, CLEAR_LOGIN_ATTEMPTS_SQL, OWN_PASSWORD_ACCOUNT_SQL,
  OWN_PASSWORD_REPLAY_SQL, OWN_PROFILE_STARTUP_SQL, OWN_PROFILE_VERSION_SQL,
} from './staff-profile-changes';

// SX-6 (0205). The database suite (services/ehr-api/test/database/own-password-and-name.integration.sql, section 6)
// runs Identity's own statements against a real 0205 schema as the Identity API runtime; this holds it to their
// exact text, in order, so a change here that the suite has not run fails. And 0205's name rule
// (auth.staff_person_name_acceptable) is held to identity-api's acceptableStaffPersonName: the same combining marks
// (\p{M}), the same reserved words, the same answers for the suite's names. Fictional names only.

const SUITE = readFileSync(join(__dirname, '../../../ehr-api/test/database/own-password-and-name.integration.sql'), 'utf8');
const MIGRATION = readFileSync(join(__dirname, '../../../ehr-api/database/migrations/0205_own_password_and_name.sql'),
  'utf8');
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('the 0205 database suite runs Identity\'s SX-6 statements verbatim', () => {
  it('section 6 executes each statement, in this order, with the same text', () => {
    const executed = [...SUITE.matchAll(/execute \$sql\$([\s\S]*?)\$sql\$/g)].map(([, body]) => normalized(body!));
    expect(executed).toEqual([
      OWN_PROFILE_STARTUP_SQL, OWN_PASSWORD_ACCOUNT_SQL, CHANGE_OWN_PASSWORD_SQL, OWN_PASSWORD_REPLAY_SQL,
      CLEAR_LOGIN_ATTEMPTS_SQL, CHANGE_OWN_DISPLAY_NAME_SQL, OWN_PROFILE_VERSION_SQL,
    ].map(normalized));
  });

  it('as the Identity API runtime, with the account-only context', () => {
    const start = SUITE.indexOf("-- 6. Identity's own statements, verbatim");
    expect(start).toBeGreaterThan(0);
    const section = SUITE.slice(start, SUITE.indexOf('-- 7. The row locks', start));
    expect(section).toContain('set local role hid_identity_api_runtime;');
    expect(section).toMatch(/pg_temp\.as_account\('synthetic:own-0205:v'/);
  });
});

/** The B3 body of 0205, from its CREATE to its closing $fn$. */
const NAME_RULE = (() => {
  const start = MIGRATION.indexOf('create function auth.staff_person_name_acceptable(candidate text)');
  return MIGRATION.slice(start, MIGRATION.indexOf('$fn$;', start));
})();

/** The code points of the combining-mark ranges B3 writes out (its E'...' pieces after the \p{M} comment). */
function nameRuleMarks(): Set<number> {
  const pieces = NAME_RULE.slice(NAME_RULE.indexOf('Every combining mark'));
  const text = [...pieces.matchAll(/E'([^']*)'/g)].map(([, piece]) => piece).join('');
  const marks = new Set<number>();
  for (const [, from, to] of text.matchAll(/(\\u[0-9A-F]{4}|\\U[0-9A-F]{8})(?:-(\\u[0-9A-F]{4}|\\U[0-9A-F]{8}))?/g)) {
    const first = Number.parseInt(from!.slice(2), 16);
    const last = to ? Number.parseInt(to.slice(2), 16) : first;
    for (let code = first; code <= last; code += 1) marks.add(code);
  }
  return marks;
}

describe('0205\'s name rule accepts the names identity-api accepts', () => {
  it('its combining marks are exactly JavaScript\'s \\p{M} (Unicode 17.0)', () => {
    const marks = nameRuleMarks();
    expect(marks.size).toBeGreaterThan(2_000);
    const javascript = new Set<number>();
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (/\p{M}/u.test(String.fromCodePoint(code))) javascript.add(code);
    }
    // Every range in the file is a mark in JavaScript.
    expect([...marks].filter((code) => !javascript.has(code))).toEqual([]);
    // With the Unicode version the ranges were written from, they are all of them (a newer Node may know more).
    if (process.versions.unicode === '17.0') expect([...javascript].filter((code) => !marks.has(code))).toEqual([]);
  });

  it('its reserved words are staff-names.ts\'s', () => {
    const listed = /words\.list\[position\] in \(([^)]*)\)/.exec(NAME_RULE)?.[1];
    const words = [...(listed ?? '').matchAll(/'([a-z]+)'/g)].map(([, word]) => word!);
    expect(words).toEqual(['healthid', 'hid', 'support', 'admin', 'administrator', 'ministry']);
    for (const word of words) expect(hasReservedWord(`Ada ${word}`)).toBe(true);
    expect(NAME_RULE).toContain("words.list[position] = 'health' and words.list[position + 1] = 'id'");
    expect(hasReservedWord('Ada Health Id')).toBe(true);
  });

  it('it counts length as JavaScript does (UTF-16 code units)', () => {
    expect(NAME_RULE).toContain("length(candidate) + length(regexp_replace(candidate, E'[^\\U00010000-\\U0010FFFF]', '', 'g')) between 2 and 80");
  });

  // The names section 3 of the suite adds for marks outside the Latin blocks and for the length bound, with the
  // answers the suite expects of the database.
  it.each([
    ['مُحَمَّد علي', true], ['मोहन कुमार', true], ['สมชาย ใจดี', true], ['שָׁלוֹם כֹּהֵן', true], ['தமிழ் செல்வன்', true],
    ['Ada⃝ Bello', true], ['Adaࢗ Bello', true], ['Ada ٣ Bello', false], ['Ada‍ Bello', false],
    [`${'\u{10428}'.repeat(20)} ${'\u{10428}'.repeat(19)}`, true], [`${'\u{10428}'.repeat(20)} ${'\u{10428}'.repeat(20)}`, false],
    ['Ada Fictional-Bello', true], ['Dr. Ada Bello', false], ['Ada Health ID', false],
  ])('%p: %p in JavaScript, as the suite expects of the database', (name, expected) => {
    expect(acceptableStaffPersonName(name)).toBe(expected);
  });
});

describe('.env.example lists SX-6\'s two settings, off', () => {
  it('STAFF_PASSWORD_CHANGE_ENABLED and STAFF_NAME_CHANGE_ENABLED are false, after a note that 0205 comes first', () => {
    const example = readFileSync(join(__dirname, '..', '..', '.env.example'), 'utf8');
    for (const name of ['STAFF_PASSWORD_CHANGE_ENABLED', 'STAFF_NAME_CHANGE_ENABLED']) {
      expect(example).toMatch(new RegExp(`^${name}=false$`, 'm'));
      const note = example.slice(0, example.indexOf(`${name}=false`)).split('\n\n').at(-1)!;
      expect(note).toContain('only once migration 0205 is applied');
      expect(note).toContain(`HID_${name}`);
    }
  });
});
