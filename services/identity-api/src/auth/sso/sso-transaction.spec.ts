// openid-client (an ES module, loaded through Node's own require) makes the
// state, nonce and PKCE verifier.
jest.mock('openid-client', () => {
  const { createRequire } = process.getBuiltinModule('node:module');
  return createRequire(`${process.cwd()}/package.json`)('openid-client') as typeof import('openid-client');
});

import { safeReturnPath } from './sso-return-path';
import {
  newTransaction,
  openTransaction,
  pkceChallenge,
  RANDOM_VALUE,
  sealTransaction,
  SSO_TRANSACTION_COOKIE_PREFIX,
  SSO_TRANSACTION_SECONDS,
  transactionCookieName,
} from './sso-transaction';

// ADR-070: what a product keeps on its own host while the browser visits the
// provider, and the page it may come back to.
const SECRET = 'test-signing-secret-with-at-least-32-characters';

describe('the return path (no open redirect, nothing identifying)', () => {
  it.each([
    '/', '/provider/workspace', '/ehr/encounters/7f0c2c1e-0f6b-4c8a-9a51-1f0f8d1a2b3c', '/lab/queue?status=pending&page=2',
    '/a-b_c.d~e/f%20g',
  ])('accepts the page path %s', (path) => {
    expect(safeReturnPath(path)).toBe(path);
  });

  it.each([
    ['another host', '//evil.invalid/'], ['a scheme', 'https://evil.invalid/'], ['no leading slash', 'provider'],
    ['a backslash', '/\\evil.invalid'], ['an encoded slash', '/%2F%2Fevil.invalid'], ['an encoded backslash', '/%5cevil'],
    ['a dot segment', '/provider/../admin'], ['an encoded dot segment', '/provider/%2e%2e/admin'],
    ['an empty segment', '/provider//x'], ['a fragment', '/page#top'], ['a space', '/page one'],
    ['a control character', '/page\u0000'], ['an encoded control character', '/page%0d%0aSet-Cookie:x'],
    ['a malformed escape', '/page%zz'], ['javascript', 'javascript:alert(1)'], ['an API route', '/api/v1/auth/logout'],
    ['an API route in another case', '/API/v1/auth'], ['a Health ID', '/patients/HID-ABCDEFGH'],
    ['a Health ID in the query', '/search?q=hid-abcdefgh'], ['a Health ID without its hyphen', '/patients/HIDZDEMAAA2'],
    ['an older Health ID', '/patients/hid_ab12'],
    ['an API route spelled with an escape', '/%61pi/v1/auth/sso/start?return_to=/x'],
    ['an API route spelled with an escape in capitals', '/%41PI/v1/patients'],
    ['a Health ID spelled with an escape', '/patients/h%69d-ABCD1234'],
    ['a Health ID spelled with another escape', '/patients/%68id-ABCD1234'],
    ['a Health ID spelled with an escape in the query', '/x?id=%48ID-ABCD1234'],
    ['an escaped hyphen', '/a%2Db'], ['an escaped tilde', '/a%7eb'], ['an escaped underscore', '/a%5Fb'],
    ['an escaped digit', '/a%31'], ['an escaped dot', '/a%2Eb'],
    ['an over-long value', `/${'a'.repeat(512)}`],
    ['an empty value', ''], ['a list', ['/a', '/b']], ['no value', undefined],
  ])('refuses %s', (_label, value) => {
    expect(safeReturnPath(value)).toBeUndefined();
  });
});

describe('the transaction cookie', () => {
  const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

  it('keeps state, nonce, verifier, return page and client, signed, for ten minutes', () => {
    const transaction = newTransaction('lab', '/lab/queue', true, NOW);
    for (const value of [transaction.state, transaction.nonce, transaction.verifier]) expect(value).toMatch(RANDOM_VALUE);
    expect(new Set([transaction.state, transaction.nonce, transaction.verifier]).size).toBe(3);
    expect(transaction.expiresAt).toBe(NOW / 1_000 + SSO_TRANSACTION_SECONDS);
    const sealed = sealTransaction(SECRET, transaction);
    expect(openTransaction(SECRET, sealed, NOW)).toEqual(transaction);
    // The verifier and nonce are not readable from the cookie's name, which is derived from the state only.
    const name = transactionCookieName(transaction.state);
    expect(name).toMatch(new RegExp(`^${SSO_TRANSACTION_COOKIE_PREFIX}[0-9a-f]{16}$`));
    expect(name).not.toContain(transaction.state);
  });

  it('refuses a cookie that was changed, signed with another secret, expired or malformed', () => {
    const transaction = newTransaction('lab', '/lab/queue', false, NOW);
    const sealed = sealTransaction(SECRET, transaction);
    const [payload, mac] = sealed.split('.') as [string, string];
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      r: '/elsewhere' }), 'utf8').toString('base64url');
    expect(openTransaction(SECRET, `${altered}.${mac}`, NOW)).toBeUndefined();
    expect(openTransaction('another-signing-secret-of-at-least-32-chars', sealed, NOW)).toBeUndefined();
    expect(openTransaction(SECRET, sealed, NOW + SSO_TRANSACTION_SECONDS * 1_000)).toBeUndefined();
    for (const value of [undefined, '', 'x', `${payload}.${mac}.extra`, `${payload}.`, 42]) {
      expect(openTransaction(SECRET, value, NOW)).toBeUndefined();
    }
  });

  it('keeps the sign-in a fresh sign-in replaces, and refuses one that is not an account and session id', () => {
    const accountId = '6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a';
    const sessionId = '0f1e2d3c-4b5a-4968-8776-655443322110';
    for (const replaces of [{ accountId, sessionId }, { accountId }]) {
      const transaction = newTransaction('web', '/settings', false, NOW, replaces);
      expect(openTransaction(SECRET, sealTransaction(SECRET, transaction), NOW)).toEqual(transaction);
    }
    for (const replaces of [{ accountId: 'HID-ABCDEFGH' }, { accountId, sessionId: 'not-a-session' },
      { accountId: accountId.toUpperCase() }]) {
      expect(openTransaction(SECRET, sealTransaction(SECRET, newTransaction('web', '/', false, NOW, replaces)), NOW))
        .toBeUndefined();
    }
  });

  it('refuses a correctly signed transaction whose content this server never writes', () => {
    // A return page off the host, and administration as the client.
    expect(openTransaction(SECRET, sealTransaction(SECRET, newTransaction('lab', '//evil.invalid/', false, NOW)), NOW))
      .toBeUndefined();
    expect(openTransaction(SECRET, sealTransaction(SECRET, newTransaction('admin', '/', false, NOW)), NOW))
      .toBeUndefined();
  });

  it('derives the S256 challenge of RFC 7636 appendix B (openid-client)', async () => {
    await expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
