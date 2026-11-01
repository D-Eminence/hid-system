/**
 * The page a product asks to come back to after single sign-on (ADR-070): a
 * page path on the same product host, written relative to it. It is kept in
 * the product's own transaction cookie and never travels to `auth.`. Each
 * product's frontend also checks it against its own page rules (the clinical
 * return paths included); this is the server's check of its shape, so that a
 * value that could leave the host, reach an API route, or carry a Health ID is
 * never redirected to.
 *
 * Accepted: exactly one leading `/`, then RFC 3986 path and query characters,
 * at most 512 characters. Refused: a scheme or another host (`//`, `\`), a
 * fragment, spaces and control characters, dot segments, an empty segment, a
 * percent-encoded `/`, `\`, `.` or control character, a malformed escape, any
 * `/api/` route, and anything that looks like a Health ID. A refused value is
 * replaced by `/` by the caller, never repaired.
 */
export const SSO_RETURN_PATH_MAX_LENGTH = 512;

/** RFC 3986 pchar, `/` and `?`, without `#` (no fragment), `\`, spaces or controls. */
const ALLOWED = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]+$/;
/**
 * A Health ID anywhere, in any case, with or without its hyphen, as the
 * health frontend refuses it (ehr-blue/clinical/returnPaths.ts
 * HEALTH_ID_SHAPE): today's format (local-auth.provider.ts) and older ones of
 * four or more characters. Record ids are UUIDs, whose hex never spells "hid".
 */
const HEALTH_ID = /hid[-_]?[a-z0-9]{4,}/i;

export function safeReturnPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > SSO_RETURN_PATH_MAX_LENGTH) return undefined;
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  if (!ALLOWED.test(raw)) return undefined;
  const queryAt = raw.indexOf('?');
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  if (path.includes('//')) return undefined;
  for (let index = raw.indexOf('%'); index !== -1; index = raw.indexOf('%', index + 1)) {
    const escape = raw.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(escape)) return undefined;
    const code = Number.parseInt(escape, 16);
    // `/`, `\` and `.` spell a separator or a dot segment; controls are never a page.
    if (code === 0x2f || code === 0x5c || code === 0x2e || code < 0x20 || code >= 0x7f) return undefined;
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  if (/^\/api(?:\/|$)/i.test(path)) return undefined;
  if (HEALTH_ID.test(raw)) return undefined;
  return raw;
}
