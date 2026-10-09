/**
 * Maps legacy user-facing Migrate/OCR paths to the single public Migrate
 * application. The application remains the OCR application internally; these
 * are edge-only compatibility rules for public URLs.
 */

const RETIRED_WEB_MIGRATE_SEGMENTS = new Set([
  'dashboard',
  'projects',
  'project',
  'scanning',
  'uploads',
  'processing',
  'intelligence',
  'validation',
  'low-confidence',
  'unclassified',
  'qa',
  'rejected',
  'matching',
  'imports',
  'folders',
  'completed',
  'team',
  'audits',
  'reports',
  'settings',
]);

export function isLegacyMigratePath(pathname) {
  return (
    pathname === '/migrate' ||
    pathname.startsWith('/migrate/') ||
    pathname === '/ocr' ||
    pathname.startsWith('/ocr/')
  );
}

export function canonicalMigratePath(pathname) {
  let path = pathname || '/';

  for (const prefix of ['/migrate', '/ocr']) {
    if (path === prefix) {
      path = '/';
      break;
    }

    if (path.startsWith(`${prefix}/`)) {
      path = path.slice(prefix.length) || '/';
      break;
    }
  }

  const firstSegment = path.slice(1).split('/', 1)[0];
  if (RETIRED_WEB_MIGRATE_SEGMENTS.has(firstSegment)) return '/';
  return path;
}

/**
 * Construct from a configured origin rather than concatenating a URL string,
 * so a legacy path beginning with `//` cannot control the redirect origin.
 */
export function migrateRedirectUrl(destinationOrigin, pathname, search = '') {
  const target = new URL(destinationOrigin);
  target.pathname = canonicalMigratePath(pathname);
  target.search = search;
  return target;
}
