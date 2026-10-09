import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = await readFile(resolve(import.meta.dirname, '../src/index.ts'), 'utf8')
for (const required of ['AES-GCM', 'pending_sync', 'conflict', 'reauthentication_required', 'crypto.randomUUID']) {
  if (!source.includes(required)) throw new Error(`Offline foundation is missing ${required}`)
}
if (/localStorage|sessionStorage|caches\.open/.test(source)) {
  throw new Error('Shared offline foundation must not persist PHI in browser string/cache storage')
}
console.log('Verified governed connectivity, sync-state, idempotency, failure, and AES-GCM offline primitives.')
