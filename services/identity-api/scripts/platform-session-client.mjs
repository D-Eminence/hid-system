// Shared HTTP helpers for the platform runtime verifiers (Stage 2A): a cookie
// jar, platform sign-in (password, then TOTP or enrollment), step-up, and a
// virtual TOTP clock. Each code is generated for a later 30-second step than
// the last one, so the server's single-use step rule is exercised without
// waiting in real time. Nothing here bypasses a server check.
import assert from 'node:assert/strict';

export function createTotpClock() {
  let offsetMs = 0;
  return {
    now: () => Date.now() + offsetMs,
    /** Moves the virtual clock to the next TOTP step and returns its time. */
    next() { offsetMs += 30_000; return Date.now() + offsetMs; },
  };
}

export function mergeCookies(jar, response) {
  const next = { ...jar };
  for (const header of response.headers['set-cookie'] ?? []) {
    const [pair, ...attributes] = header.split(';');
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const expires = attributes.map((part) => part.trim()).find((part) => /^expires=/i.test(part));
    if (!value || (expires && new Date(expires.slice(8)).getTime() <= Date.now())) delete next[name];
    else next[name] = value;
  }
  return next;
}

export const cookieHeader = (jar) => Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');

export function expectStatus(response, status, code) {
  assert.equal(response.status, status, `${code ?? status}: ${JSON.stringify(response.body)}`);
  if (code) assert.equal(response.body.code, code, JSON.stringify(response.body));
}

/**
 * @param http supertest agent for the Nest app
 * @param origin allowed CORS origin
 * @param totp { base32Decode, totp } from src/auth/mfa/totp.ts
 * @param clock createTotpClock()
 */
export function platformClient({ http, origin, totp, clock, password }) {
  const code = (secret) => totp.totp(totp.base32Decode(secret), clock.next());
  const post = (path, jar = {}, body = {}, headers = {}) => {
    let call = http.post(`/api/v1${path}`).set('Origin', origin).set('Cookie', cookieHeader(jar));
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call.send(body);
  };

  async function login(email, { expect = 200 } = {}) {
    const response = await post('/auth/admin/login', {}, { email, password, turnstileAction: 'admin-login' });
    expectStatus(response, expect);
    return { response, jar: mergeCookies({}, response) };
  }

  /** First platform sign-in: enrolls a TOTP factor and returns the session and secret. */
  async function enroll(email) {
    const started = await login(email);
    assert.equal(started.response.body.status, 'mfa_enrollment_required');
    const enrollment = await post('/auth/admin/mfa/enroll/start', started.jar);
    expectStatus(enrollment, 200);
    const secret = enrollment.body.secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    const activated = await post('/auth/admin/mfa/enroll/activate', started.jar, { code: code(secret) });
    expectStatus(activated, 200);
    return { ...session(activated), secret, recoveryCodes: activated.body.recoveryCodes, email };
  }

  /** Later platform sign-in with a TOTP code (or a recovery code). */
  async function signIn(admin, { recoveryCode } = {}) {
    const started = await login(admin.email);
    assert.equal(started.response.body.status, 'mfa_required');
    const verified = await post('/auth/admin/mfa/verify', started.jar,
      recoveryCode ? { recoveryCode } : { code: code(admin.secret) });
    expectStatus(verified, 200);
    return { ...admin, ...session(verified) };
  }

  function session(response) {
    const jar = mergeCookies({}, response);
    assert(jar.hid_access_admin && jar.hid_access_admin_refresh && jar.hid_access_admin_csrf,
      'a platform session sets the platform access, refresh and CSRF cookies');
    assert(!jar.hid_access && !jar.hid_access_refresh, 'a platform session never sets staff session cookies');
    return { jar, csrf: response.headers['x-csrf-token'], accountId: response.body.actor.accountId,
      sessionId: response.body.actor.sessionId };
  }

  const get = (admin, path, headers = {}) => {
    let call = http.get(`/api/v1${path}`);
    if (admin) call = call.set('Cookie', cookieHeader(admin.jar));
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call;
  };
  const command = (admin, path, body = {}, headers = {}) =>
    post(path, admin.jar, body, { 'x-csrf-token': admin.csrf, ...headers });

  async function stepUp(admin) {
    const response = await command(admin, '/admin/mfa/step-up', { code: code(admin.secret) });
    expectStatus(response, 200);
    return response;
  }

  return { code, post, login, enroll, signIn, get, command, stepUp };
}
