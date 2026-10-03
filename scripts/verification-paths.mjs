// Static checks run on both Windows workstations and Linux release runners.
export const normalizeVerificationPath = path => path.replaceAll('\\', '/')

export function isTestFixturePath(path) {
  const normalized = normalizeVerificationPath(path)
  return /(?:\.spec\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$|(?:^|\/)tests?\/)/.test(normalized)
    || /(?:^|\/)scripts\/run-container-database-acceptance\.sh$/.test(normalized)
}

export function isFrontendSourcePath(path) {
  return /(?:\/src\/|vite\.config\.|index\.html$)/.test(normalizeVerificationPath(path))
}
