// Static checks run on both Windows workstations and Linux release runners.
// They match paths in POSIX form. Only the platform separator is rewritten, so
// on Linux and macOS every path is returned unchanged and no rule is widened.
import { sep } from 'node:path'

export function toPosixPath(path, separator) {
  return separator === '/' ? path : path.split(separator).join('/')
}

export function normalizeVerificationPath(path) {
  return toPosixPath(path, sep)
}

// Test sources and fixtures, which may hold placeholder credentials.
export function isTestFixturePath(path) {
  const normalized = normalizeVerificationPath(path)
  return /(?:\.spec\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$|(?:^|\/)tests?\/)/.test(normalized)
    || normalized.endsWith('/scripts/run-container-database-acceptance.sh')
}

// Files that are built into a browser bundle.
export function isFrontendSourcePath(path) {
  return /(?:\/src\/|vite\.config\.|index\.html$)/.test(normalizeVerificationPath(path))
}
