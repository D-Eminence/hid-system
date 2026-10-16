// docs/SECURITY.md says which public flows that create an account treat the
// hid_access_csrf cookie as a sign-in. That cookie outlives the 15-minute
// access cookie for as long as the refresh session, and the browser sends the
// refresh cookie only under /api/v1/auth, so on the other routes it is the only
// sign of a live sign-in once the access cookie expires. After the merge with
// main the document said "A public flow that creates an account treats the
// hid_access_csrf cookie ... as a sign-in", but only the flows that call the
// shared assertAccountless (public-flow-guards.ts) count it; main's patient
// enrollment and Google onboarding check the access and refresh cookies and
// the Authorization header only.
//
// These checks hold the document to Identity's source: a sentence that says the
// CSRF cookie counts as a sign-in names, by refusal code, exactly the flows
// whose check counts it, and states no general rule.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const source = join(repository, 'services/identity-api/src');
const security = readFileSync(join(repository, 'docs/SECURITY.md'), 'utf8');

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
  });
}
const sources = files(source).map((path) => readFileSync(path, 'utf8'));

/** The refusal codes of the shared check, which counts the CSRF cookie. */
const guard = readFileSync(join(source, 'common/public-flow-guards.ts'), 'utf8');
const counting = new Set(sources.flatMap((text) =>
  [...text.matchAll(/\bassertAccountless\(\s*request\s*,[^{]*\{\s*code:\s*'([A-Z_]+_REQUIRES_SIGN_OUT)'/g)].map((match) => match[1])));
/** Every refusal of a signed-in browser that Identity answers. */
const refusals = new Set(sources.flatMap((text) => [...text.matchAll(/'([A-Z_]+_REQUIRES_SIGN_OUT)'/g)].map((match) => match[1])));

/** SECURITY.md's sentences, outside code fences, as single lines. */
const sentences = security.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/)
  .flatMap((paragraph) => paragraph.replace(/\s+/g, ' ').trim().split(/(?<=\.)\s+(?=[A-Z`(])/));
const claims = sentences.filter((sentence) => sentence.includes('`hid_access_csrf`') && /\bas a sign-in\b/.test(sentence));

test('the shared check counts the CSRF cookie, and some flows do not use it', () => {
  assert.match(guard, /`\$\{authCookieName\}_csrf=`/);
  assert.deepEqual([...counting].sort(), ['CLINICIAN_APPLICATION_REQUIRES_SIGN_OUT', 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT']);
  assert.ok([...refusals].some((code) => !counting.has(code)), 'every refusal now counts the CSRF cookie');
});

test('SECURITY.md says which flows treat the CSRF cookie as a sign-in', () => {
  assert.ok(claims.length > 0, 'SECURITY.md must say which flows treat `hid_access_csrf` as a sign-in');
});

test('each such sentence names exactly the flows whose check counts the CSRF cookie', () => {
  for (const claim of claims) {
    const named = [...claim.matchAll(/\b([A-Z_]+_REQUIRES_SIGN_OUT)\b/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(named)].sort(), [...counting].sort(), `SECURITY.md: "${claim}"`);
    assert.doesNotMatch(claim, /^(?:A|Any|Every|Each) (?:public )?flow\b/, `SECURITY.md states a general rule: "${claim}"`);
  }
});

test('SECURITY.md names the refusals that do not count the CSRF cookie apart from that claim', () => {
  const others = [...refusals].filter((code) => !counting.has(code)).sort();
  const named = new Set(sentences.filter((sentence) => !claims.includes(sentence))
    .flatMap((sentence) => [...sentence.matchAll(/\b([A-Z_]+_REQUIRES_SIGN_OUT)\b/g)].map((match) => match[1])));
  assert.deepEqual(others.filter((code) => !named.has(code)), [],
    'SECURITY.md must say that these flows do not treat the CSRF cookie as a sign-in');
});
