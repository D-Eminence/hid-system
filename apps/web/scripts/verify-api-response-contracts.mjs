import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const sourceRoot = join(root, 'src')
const failures = []

async function filesBelow(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return filesBelow(path, extensions)
    return entry.isFile() && extensions.some(extension => path.endsWith(extension)) ? [path] : []
  }))
  return nested.flat()
}

const client = await readFile(join(sourceRoot, 'lib', 'identityClient.ts'), 'utf8')
const functionApi = await readFile(join(sourceRoot, 'lib', 'functionApi.ts'), 'utf8')
const hidApi = await readFile(join(sourceRoot, 'lib', 'hidApi.ts'), 'utf8')
const adminDashboard = await readFile(join(sourceRoot, 'services', 'adminDashboard.ts'), 'utf8')
const migrationCapture = await readFile(
  join(sourceRoot, 'features', 'migrate', 'api', 'migrationCapture.ts'),
  'utf8',
)
for (const required of [
  "credentials: 'include'",
  "'/api/v1/auth/session'",
  "'/api/v1/auth/login'",
  "'/api/v1/auth/logout'",
  "headers.set('X-CSRF-Token', csrfToken)",
]) {
  if (!client.includes(required)) failures.push(`identity REST client is missing: ${required}`)
}
if (!client.includes('fetchWithTimeout as sharedFetchWithTimeout')) {
  failures.push('identity REST client must use the shared transport timeout primitive')
}
if (/new AbortController\s*\(/.test(client)) {
  failures.push('identity REST client duplicates shared timeout and abort handling')
}
for (const [name, source] of [
  ['HID domain API', hidApi],
  ['admin dashboard API', adminDashboard],
  ['migration capture API', migrationCapture],
]) {
  if (/new AbortController\s*\(/.test(source)) {
    failures.push(`${name} duplicates shared timeout and abort handling`)
  }
}
if (!migrationCapture.includes("from '../../../../../../packages/api-client/src/index'")) {
  failures.push('migration capture uploads must use the shared transport primitive')
}
for (const required of ['code', 'message', 'requestId', 'retryable', 'status']) {
  if (!functionApi.includes(required)) failures.push(`function API error contract is missing ${required}`)
}

const sourceFiles = await filesBelow(sourceRoot, ['.ts', '.tsx'])
for (const file of sourceFiles) {
  const source = await readFile(file, 'utf8')
  const name = relative(root, file)
  if (/VITE_[A-Z_]*ANON_KEY/.test(source)) failures.push(`${name} contains a browser-exposed backend key`)
  if (/Authorization[^\n]*http-only-cookie/i.test(source)) failures.push(`${name} sends a cookie placeholder as a bearer token`)
  if (/\bfetch\s*\(/.test(source) && name !== join('src', 'components', 'FacilityPicker.tsx')) {
    failures.push(`${name} bypasses the shared transport primitive`)
  }
}

if (failures.length) {
  console.error(`API response contract verification failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}

console.log(`Verified the first-party REST session client and ${sourceFiles.length} client source files.`)
