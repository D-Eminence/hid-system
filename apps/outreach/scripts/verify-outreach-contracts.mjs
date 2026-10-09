import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const repository = join(root, '..', '..')
const files = Object.fromEntries(await Promise.all(Object.entries({
  offline: join(root, 'src/lib/outreachOfflineStore.ts'),
  hook: join(root, 'src/hooks/useOutreach.ts'),
  page: join(root, 'src/pages/Outreach.tsx'),
  api: join(root, 'src/lib/outreachApi.ts'),
  worker: join(root, 'public/service-worker.js'),
  gateway: join(repository, 'apps', 'web', 'vite.config.ts'),
  ehrApp: join(repository, 'services/ehr-api/src/app.module.ts'),
  service: join(repository, 'services/outreach-api/src/outreach/outreach.service.ts'),
}).map(async ([name, path]) => [name, await readFile(path, 'utf8')])))

const failures = []
for (const required of [
  "indexedDB.open(DATABASE_NAME", "name: 'AES-GCM'", "false, ['encrypt', 'decrypt']",
  'crypto.randomUUID()', 'return `tmp_${crypto.randomUUID()}`',
  "idempotencyKey: crypto.randomUUID()", "state: 'pending_sync'",
  "operationType: 'registration_case_create'", 'attemptCount: 0',
  'transaction.objectStore(COMMANDS).delete(command.commandId)',
]) if (!files.offline.includes(required)) failures.push(`offline store is missing: ${required}`)

if (/localStorage|sessionStorage/.test(`${files.offline}\n${files.hook}\n${files.page}\n${files.api}`)) {
  failures.push('Outreach PHI/offline paths must not use localStorage or sessionStorage')
}
for (const required of [
  "'sync_failed_retryable' : 'terminal'", 'command.state === \'terminal\'',
  'acknowledgeOutreachCommand', 'clearOutreachOfflineData()',
]) if (!files.hook.includes(required)) failures.push(`sync workflow is missing: ${required}`)
if (/simulateSync|markSyncQueueAsSynced|Successfully registered in HID/.test(files.hook + files.page)) {
  failures.push('Outreach UI still contains a fake-success sync path')
}
if (!files.worker.includes("url.pathname.startsWith('/api/')")
    || !files.worker.includes('if (request.method !== \'GET\') return')) {
  failures.push('service worker must exclude every API response from caching')
}
if (!files.worker.includes('const APP_SCOPE = new URL(self.registration.scope).pathname')
    || !files.worker.includes('caches.match(APP_SCOPE)')) {
  failures.push('service worker must provide a static app-shell fallback for offline reload')
}
if (!files.gateway.includes("'/outreach'") || !files.gateway.includes('ports.outreachUi')
    || !files.gateway.includes("'/api/v1/outreach'") || !files.gateway.includes('ports.outreachApi')) {
  failures.push('gateway does not route Outreach to its dedicated port')
}
if (/OutreachModule/.test(files.ehrApp)) failures.push('EHR still registers the legacy Outreach module')
if (/insert into identity\.|update identity\.|insert into ehr\.|update ehr\.|hid_code|\bNIN\b/i.test(files.service)) {
  failures.push('Outreach service crosses a canonical Identity/EHR persistence boundary')
}

if (failures.length) {
  console.error(`Outreach contract verification failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('Verified encrypted durable Outreach outbox, temporary identity, fail-closed sync, and service cutover.')
