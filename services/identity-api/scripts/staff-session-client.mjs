// Shared HTTP helpers for staff sign-in with an authenticator (launch blocker
// MFA-1, migration 0088): the password step, the email code of a first
// enrolment, the enrolment, and the TOTP or recovery-code step. They use the
// seams the platform verifiers use (platform-session-client.mjs): in process,
// a virtual TOTP clock shared with the server (MFA_TOTP_CLOCK); and a
// stand-in for the notification client that keeps the codes it is asked to
// deliver. A verifier whose Identity runs in a child process uses the real
// clock, and a recovery code when a sign-in would reuse a TOTP step. Nothing
// here bypasses a server check. All values are synthetic.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

/** The synthetic MFA key of the runtime verifiers (never a deployed key). */
export const SYNTHETIC_STAFF_MFA_KEY_B64 = Buffer.alloc(32, 0x5a).toString('base64');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, as src/auth/mfa/totp.ts decodes it. */
export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const output = [];
  for (const character of text.replace(/[\s=]/g, '').toUpperCase()) {
    const index = BASE32.indexOf(character);
    assert(index >= 0, 'Invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** RFC 6238 TOTP (SHA-1, six digits, 30-second steps), as src/auth/mfa/totp.ts computes it. */
export function totpAt(secretBase32, nowMs) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return (binary % 1_000_000).toString().padStart(6, '0');
}

/**
 * A NotificationOtpClient stand-in: it keeps the staff enrolment codes
 * (purpose LOGIN_STEP_UP) by recipient and hands every other delivery to
 * `other`, or refuses it.
 */
export function enrollmentCodeOutbox(other) {
  const codes = new Map();
  return {
    client: {
      deliver: async (input) => {
        if (input.purpose === 'LOGIN_STEP_UP') {
          assert.equal(input.channel, 'email', 'A staff enrolment code goes to the account email');
          assert.match(input.code, /^[0-9]{6}$/);
          codes.set(input.recipient.toLowerCase(), input.code);
          return { outcome: 'accepted', provider: 'synthetic' };
        }
        if (other) return other(input);
        throw new Error(`Unexpected ${input.purpose} delivery in a staff sign-in verifier`);
      },
    },
    /** The latest code sent to `recipient`, taken once. */
    take(recipient) {
      const code = codes.get(recipient.toLowerCase());
      codes.delete(recipient.toLowerCase());
      return code;
    },
    /** Records a code delivered by an Identity child process (see childOutboxLine). */
    record(recipient, code) { codes.set(recipient.toLowerCase(), code); },
  };
}

/** The stdout line an Identity child process writes for each enrolment code, read by readChildOutbox. */
export function childOutboxLine(input) {
  return `${JSON.stringify({ staffEnrollmentCode: { recipient: input.recipient, code: input.code } })}\n`;
}

/** Records the enrolment codes an Identity child process reports on its stdout lines. */
export function readChildOutbox(lines, outbox) {
  lines.on('line', (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.staffEnrollmentCode) outbox.record(parsed.staffEnrollmentCode.recipient, parsed.staffEnrollmentCode.code);
    } catch {
      // Not an outbox line.
    }
  });
}

/** An in-process transport: a supertest agent for the Nest app. */
export function supertestTransport(http) {
  return async (path, { origin, cookie, body, headers = {} }) => {
    let call = http.post(`/api/v1${path}`);
    if (origin) call = call.set('Origin', origin);
    if (cookie) call = call.set('Cookie', cookie);
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    const response = await call.send(body ?? {});
    return { status: response.status, body: response.body, setCookie: response.headers['set-cookie'] ?? [],
      header: (name) => response.headers[name.toLowerCase()], raw: response };
  };
}

/** A transport to an Identity child process over HTTP; `base` ends in /api/v1. */
export function fetchTransport(base) {
  return async (path, { origin, cookie, body, headers = {} }) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => null),
      setCookie: response.headers.getSetCookie(), header: (name) => response.headers.get(name), raw: response };
  };
}

const expired = (value) => /expires=thu, 01 jan 1970/i.test(value);

/** The cookies a response sets (name to value), without the ones it expires. */
export function setCookies(response) {
  return Object.fromEntries(response.setCookie.filter((value) => !expired(value))
    .map((value) => value.split(';')[0]).map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
}

/**
 * Staff sign-in over HTTP. `send` is a transport; `now()` the time a TOTP code
 * is computed for (in process, `clock.next` of createTotpClock, shared with the
 * server's MFA_TOTP_CLOCK; otherwise Date.now); `outbox` an
 * enrollmentCodeOutbox. The client remembers each account's secret and
 * recovery codes.
 */
export function staffClient({ send, origin, password, outbox, now = Date.now, turnstileToken, cookieName = 'hid_access' }) {
  const accounts = new Map();
  const post = (path, options = {}) => send(path, { origin, ...options });
  const expect = (response, status, label) => assert.equal(response.status, status,
    `${label}: ${response.status} ${JSON.stringify(response.body)}`);

  /** The password step: a challenge cookie only, never a session cookie. */
  async function passwordStep(email, { password: given = password, action = 'staff-login' } = {}) {
    const response = await post('/auth/login', { body: { email, password: given, turnstileAction: action,
      ...(turnstileToken ? { turnstileToken: turnstileToken(action) } : {}) } });
    expect(response, 200, `staff password step for ${email}`);
    assert(['mfa_required', 'mfa_enrollment_required'].includes(response.body.status), JSON.stringify(response.body));
    assert.equal(response.body.actor, undefined, 'The password step answers no actor');
    const cookies = setCookies(response);
    for (const name of [cookieName, `${cookieName}_refresh`, `${cookieName}_csrf`]) {
      assert.equal(cookies[name], undefined, `The password step set the session cookie ${name}`);
    }
    const challenge = response.setCookie.find((value) => value.startsWith(`${cookieName}_mfa=`));
    assert(challenge && /; HttpOnly/i.test(challenge) && /; Path=\/api\/v1\/auth\/mfa(;|$)/i.test(challenge)
      && /; SameSite=Strict/i.test(challenge), `staff challenge cookie: ${challenge}`);
    assert.equal(response.header('x-csrf-token') ?? undefined, undefined, 'The password step sends no CSRF token');
    return { response, status: response.body.status, challengeCookie: `${cookieName}_mfa=${cookies[`${cookieName}_mfa`]}` };
  }

  /**
   * First enrolment on a challenge: the emailed code (unless the challenge
   * already carries its proof, as a provider activation's does), the secret,
   * and the first TOTP code, which opens the session.
   */
  async function enroll(email, challengeCookie, { emailedProof = true } = {}) {
    let emailCode;
    if (emailedProof) {
      const sent = await post('/auth/mfa/enroll/email-code', { cookie: challengeCookie });
      expect(sent, 200, `enrolment code for ${email}`);
      emailCode = outbox.take(email);
      assert.match(emailCode ?? '', /^[0-9]{6}$/, `no enrolment code was delivered to ${email}`);
    }
    const started = await post('/auth/mfa/enroll/start', { cookie: challengeCookie, body: emailCode ? { emailCode } : {} });
    expect(started, 200, `enrolment start for ${email}`);
    assert.match(started.body.secret, /^[A-Z2-7]{32}$/);
    const at = now();
    const activated = await post('/auth/mfa/enroll/activate', { cookie: challengeCookie,
      body: { code: totpAt(started.body.secret, at) } });
    expect(activated, 200, `enrolment activation for ${email}`);
    assert.equal(activated.body.recoveryCodes?.length, 10);
    accounts.set(email.toLowerCase(), { secret: started.body.secret, recoveryCodes: [...activated.body.recoveryCodes],
      lastStep: Math.floor(at / 30_000) });
    return session(activated);
  }

  /** The second factor of an enrolled account: TOTP, or a recovery code when asked or when a step would repeat. */
  async function verify(email, challengeCookie, { recoveryCode = false } = {}) {
    const state = accounts.get(email.toLowerCase());
    assert(state, `no authenticator is known for ${email}`);
    const at = now();
    const step = Math.floor(at / 30_000);
    const useRecovery = recoveryCode || step <= state.lastStep;
    const body = useRecovery ? { recoveryCode: state.recoveryCodes.shift() } : { code: totpAt(state.secret, at) };
    if (!useRecovery) state.lastStep = step;
    const verified = await post('/auth/mfa/verify', { cookie: challengeCookie, body });
    expect(verified, 200, `second factor for ${email}`);
    return session(verified);
  }

  function session(response) {
    const cookies = setCookies(response);
    for (const name of [cookieName, `${cookieName}_refresh`, `${cookieName}_csrf`]) {
      assert(cookies[name], `the second factor set no ${name} cookie`);
    }
    const csrf = response.header('x-csrf-token');
    assert.equal(csrf, cookies[`${cookieName}_csrf`]);
    const jar = { [cookieName]: cookies[cookieName], [`${cookieName}_refresh`]: cookies[`${cookieName}_refresh`],
      [`${cookieName}_csrf`]: cookies[`${cookieName}_csrf`] };
    return { response, cookies: jar, cookie: Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; '),
      csrf, actor: response.body.actor, sessionId: response.body.actor?.sessionId, accountId: response.body.actor?.accountId,
      recoveryCodes: response.body.recoveryCodes };
  }

  /** A complete staff sign-in: password, then enrolment (first time) or the second factor. */
  async function signIn(email, options = {}) {
    const { status, challengeCookie } = await passwordStep(email, options);
    if (status === 'mfa_enrollment_required') return enroll(email, challengeCookie, options);
    return verify(email, challengeCookie, options);
  }

  return { passwordStep, enroll, verify, signIn, secretOf: (email) => accounts.get(email.toLowerCase())?.secret,
    forget: (email) => accounts.delete(email.toLowerCase()) };
}
