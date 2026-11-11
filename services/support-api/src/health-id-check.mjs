import { readFile, stat } from 'node:fs/promises';

// The support chat's server Health ID check (owner decision of 2026-10-31). Every message is read for anything that
// could be a Health ID, those strings alone are checked against the Health IDs actually issued (identity-api,
// POST /api/v1/identity/service/support/health-id-matches, migration 0109), and each issued one is replaced with
// HEALTH_ID_PLACEHOLDER before the text reaches Lex. Anything that stops the check stops the message: support-api
// then answers 503 and sends nothing to Lex. Nothing here logs.

/** Health ID characters (identity-api's HID_ALPHABET): no I, O, 0 or 1. */
const HEALTH_ID_CHARACTERS = /^[A-HJ-NP-Z2-9]+$/;
const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;
/** What stands between parts of one typed Health ID: "AB2 CD3", "AB2-CD3", "HID: AB2CD3", "HID - AB2.CD3". */
const SEPARATOR = /^[\s\-‐-―_.:#/]$/u;
const MAX_SEPARATORS = 3;
/** Parts of one Health ID typed apart, at most ("AB2 CD3 EF4"). */
const MAX_PARTS = 3;
export const MAX_CANDIDATES = 200;
export const HEALTH_ID_PLACEHOLDER = '[Health ID]';
const MAX_WORKLOAD_TOKEN_LENGTH = 16_384;
const MAX_RESPONSE_BYTES = 65_536;

/**
 * The strings in text that could be a Health ID, as HID- and 6 to 32 Health ID characters, each with the stretch of
 * text it was read from. Read letter by letter after NFKC folding and upper-casing, so "hid-ab2cd3", full-width
 * letters and dashes of any kind read alike. A candidate is:
 * - after a HID label ("HID-AB2CD3", "HID AB2 CD3", "hid: ab2-cd3", "HIDAB2CD3"): the one to three parts after it;
 * - a word of 6 to 32 Health ID characters on its own ("AB2CD3", a letters-only Health ID issued before 2026-10-31);
 * - two or three short parts typed apart, one of them with a digit ("AB2 CD3", "AB-2CD-3").
 * Ordinary words are candidates too ("PLEASE"); identity-api says which are issued, so only those are replaced.
 */
export function healthIdCandidates(text) {
  const parts = [];
  let current = null;
  let gap = 0;
  let index = 0;
  for (const character of String(text)) {
    const folded = character.normalize('NFKC').toUpperCase();
    const start = index;
    index += character.length;
    if (folded.length === 1 && /^[A-Z0-9]$/.test(folded)) {
      if (!current) {
        current = { value: '', start, end: start, gapBefore: parts.length ? gap : Infinity };
        parts.push(current);
      }
      current.value += folded;
      current.end = index;
      gap = 0;
      continue;
    }
    current = null;
    gap = SEPARATOR.test(folded) ? gap + 1 : Infinity;
  }
  const found = new Map();
  const add = (healthId, start, end) => {
    if (!HEALTH_ID.test(healthId)) return;
    const spans = found.get(healthId) ?? [];
    spans.push({ start, end });
    found.set(healthId, spans);
  };
  for (let first = 0; first < parts.length; first += 1) {
    const part = parts[first];
    // A HID label, with the code joined to it or after it.
    if (part.value.startsWith('HID')) {
      const joined = part.value.slice(3);
      let code = joined;
      let end = part.end;
      if (joined) add(`HID-${code}`, part.start, end);
      for (let next = first + 1; next < parts.length && next <= first + MAX_PARTS; next += 1) {
        if (parts[next].gapBefore > MAX_SEPARATORS) break;
        code += parts[next].value;
        end = parts[next].end;
        add(`HID-${code}`, part.start, end);
      }
    }
    // A word on its own.
    if (HEALTH_ID_CHARACTERS.test(part.value)) add(`HID-${part.value}`, part.start, part.end);
    // Short parts typed apart, one of them with a digit.
    let code = part.value;
    let digit = /[2-9]/.test(part.value);
    for (let next = first + 1; next < parts.length && next < first + MAX_PARTS; next += 1) {
      if (parts[next].gapBefore > MAX_SEPARATORS || parts[next - 1].value.length > 5 || parts[next].value.length > 5) break;
      code += parts[next].value;
      digit ||= /[2-9]/.test(parts[next].value);
      if (digit && HEALTH_ID_CHARACTERS.test(code)) add(`HID-${code}`, part.start, parts[next].end);
    }
  }
  return [...found].map(([healthId, spans]) => ({ healthId, spans }));
}

/** text with every stretch read as one of the matched Health IDs replaced by HEALTH_ID_PLACEHOLDER. */
export function replaceHealthIds(text, candidates, matches) {
  const spans = candidates.filter((candidate) => matches.has(candidate.healthId)).flatMap((candidate) => candidate.spans)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let result = '';
  let position = 0;
  for (const span of spans) {
    if (span.end <= position) continue;
    result += text.slice(position, Math.max(position, span.start));
    if (span.start >= position) result += HEALTH_ID_PLACEHOLDER;
    position = span.end;
  }
  return result + text.slice(position);
}

/**
 * The check as support-api runs it: (text) => the text to send to Lex. It throws, and nothing is sent, when it is
 * not configured, the workload token cannot be read, identity-api does not answer 200 in time with a valid answer, or
 * the message holds more than MAX_CANDIDATES candidates.
 */
export function healthIdCheck({ identityApiUrl, mode = 'jwt', tokenFile, localToken, production = false,
  timeoutMs = 2000, fetch = globalThis.fetch } = {}) {
  const configured = configuration(identityApiUrl, mode, tokenFile, localToken, production);
  return async (text) => {
    if (!configured) throw new Error('Support Health ID check is not configured');
    // Every message needs the credential, so a support-api without one answers nothing at all.
    const credential = await workloadCredential(configured);
    const candidates = healthIdCandidates(text);
    if (!candidates.length) return text;
    if (candidates.length > MAX_CANDIDATES) throw new Error('Too many Health ID candidates');
    const asked = candidates.map((candidate) => candidate.healthId);
    const response = await fetch(configured.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'x-hid-internal-caller': 'support-api', ...credential },
      body: JSON.stringify({ candidates: asked }),
    });
    if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Support Health ID check failed');
    }
    const body = await boundedText(response);
    let answer;
    try { answer = JSON.parse(body); } catch { throw new Error('Invalid Health ID check answer'); }
    const known = new Set(asked);
    if (!answer || !Array.isArray(answer.matches) || answer.matches.length > asked.length
        || answer.matches.some((match) => typeof match !== 'string' || !known.has(match))) {
      throw new Error('Invalid Health ID check answer');
    }
    return replaceHealthIds(text, candidates, new Set(answer.matches));
  };
}

function configuration(identityApiUrl, mode, tokenFile, localToken, production) {
  if (mode !== 'jwt' && mode !== 'local-secret') throw new Error('IDENTITY_SERVICE_IDENTITY_MODE must be jwt or local-secret');
  if (mode === 'local-secret' && production) throw new Error('A local service token is not allowed in production');
  if (!identityApiUrl) return null;
  const url = new URL(identityApiUrl);
  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) {
    throw new Error('IDENTITY_API_URL must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('IDENTITY_API_URL must be an origin');
  }
  return { endpoint: new URL('/api/v1/identity/service/support/health-id-matches', url), mode, tokenFile, localToken };
}

async function workloadCredential({ mode, tokenFile, localToken }) {
  if (mode === 'local-secret') {
    if (typeof localToken !== 'string' || localToken.length < 32) throw new Error('Support workload identity is unavailable');
    return { 'x-hid-service-token': localToken };
  }
  if (!tokenFile) throw new Error('Support workload identity is unavailable');
  const metadata = await stat(tokenFile).catch(() => { throw new Error('Support workload identity is unavailable'); });
  if (!metadata.isFile() || metadata.size > MAX_WORKLOAD_TOKEN_LENGTH) throw new Error('Support workload identity is unavailable');
  const raw = await readFile(tokenFile, 'utf8').catch(() => { throw new Error('Support workload identity is unavailable'); });
  const token = raw.trim().replace(/^Bearer\s+/, '');
  if (token.length < 20 || token.length > MAX_WORKLOAD_TOKEN_LENGTH || /\s/.test(token)) {
    throw new Error('Support workload identity is unavailable');
  }
  return { 'x-hid-service-authorization': `Bearer ${token}` };
}

async function boundedText(response) {
  if (!response.body) throw new Error('Invalid Health ID check answer');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Invalid Health ID check answer');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  return Buffer.concat(chunks).toString('utf8');
}
