const VERSIONED_METADATA = /^\/metadata\/([1-9][0-9]*)\.(root|snapshot|targets)\.json$/
const SAFE_TARGET_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const HASHED_TARGET = /^([a-f0-9]{64})\.([A-Za-z0-9][A-Za-z0-9._-]*)$/

export function classifyTufPath(pathname) {
  if (pathname === '/metadata/timestamp.json') {
    return Object.freeze({ kind: 'metadata', role: 'timestamp', cachePolicy: 'no-store' })
  }

  const metadata = VERSIONED_METADATA.exec(pathname)
  if (metadata) {
    return Object.freeze({
      kind: 'metadata',
      role: metadata[2],
      version: Number(metadata[1]),
      cachePolicy: 'immutable',
    })
  }

  if (!pathname.startsWith('/targets/')) return null
  const segments = pathname.slice('/targets/'.length).split('/')
  if (segments.length < 2 || segments.some(segment => segment.length === 0)) return null
  if (!segments.slice(0, -1).every(segment => SAFE_TARGET_DIRECTORY.test(segment))) return null

  const target = HASHED_TARGET.exec(segments.at(-1))
  if (!target) return null
  return Object.freeze({
    kind: 'target',
    sha256: target[1],
    logicalName: [...segments.slice(0, -1), target[2]].join('/'),
    cachePolicy: 'immutable',
  })
}
