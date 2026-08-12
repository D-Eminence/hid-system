import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const deployableRoots = ['apps', 'services', 'packages', 'infra', 'gateway']
const sourceExtension = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|sh)$/i
const ignoredSegments = new Set(['node_modules', 'dist', 'coverage', 'cdk.out', '.wrangler'])

async function filesBelow(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredSegments.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(path))
    else if (entry.isFile() && sourceExtension.test(entry.name)) output.push(path)
  }
  return output
}

const files = (await Promise.all(deployableRoots.map((name) => filesBelow(resolve(root, name))))).flat()
files.push(resolve(root, 'package.json'))
const canonical = (await Promise.all(files.map(async (path) => ({
  path: relative(root, path),
  source: await readFile(path, 'utf8'),
})))).filter(({ path }) => !/^services\/ehr-api\/database\/migrations\/00(?:0[1-9]|1\d|2[0-7])_/.test(path))

function assertNoRuntime(label, pattern) {
  const matches = canonical.filter(({ source }) => pattern.test(source)).map(({ path }) => path)
  assert.deepEqual(matches, [], `${label} remains in canonical deployable files: ${matches.join(', ')}`)
}

assertNoRuntime('Brevo runtime', /\b(?:brevo|sendinblue)\b|api\.brevo\.com|sendinblue\.com/i)
assertNoRuntime('Supabase runtime', /@supabase\/supabase-js|\bsupabase\.(?:auth|from|storage|channel|functions)\b|\.supabase\.co|\bcreateClient\s*\([^)]*supabase/i)
assertNoRuntime('legacy HTTP identity runtime', /legacy-http|LEGACY_IDENTITY_(?:URL|ANON_KEY|SERVICE_ROLE_KEY)|IDENTITY_LEGACY_(?:BASE_URL|SERVICE_TOKEN)|IDENTITY_PROVIDER_MODE/i)
assertNoRuntime('authentication magic-link runtime', /emailRedirectTo|PASSWORD_RECOVERY|\.(?:signInWithOtp|verifyOtp)\s*\(|\bmagic[-_ ]?link\b/i)
assertNoRuntime(
  'Vercel target runtime',
  /@vercel\/|\b(?:npx\s+)?vercel(?:@[^\s]+)?\s+(?:build|deploy|dev|pull)\b|\bVERCEL_(?:TOKEN|ORG_ID|PROJECT_ID)\b/i,
)

for (const path of files.map((value) => relative(root, value))) {
  assert.ok(!/(?:^|\/)vercel\.json$|(?:^|\/)\.vercel\//i.test(path), `Retired Vercel target file remains: ${path}`)
}

const appByWorker = {
  'hid-web': ['apps/web/dist', 'web'],
  'hid-ehr': ['apps/ehr/dist', 'ehr'],
  'hid-lab': ['apps/lab/dist', 'lab'],
  'hid-pharmacy': ['apps/pharmacy/dist', 'pharmacy'],
  'hid-ocr': ['apps/ocr/dist', 'ocr'],
  'hid-outreach': ['apps/outreach/dist', 'outreach'],
  'hid-admin': ['apps/admin/dist', 'admin'],
}
const cloudflareDeployments = {
  production: {
    apiOrigin: 'https://api.healthidentitydirectory.com',
    hostFor: (app) => app === 'web'
      ? 'www.healthidentitydirectory.com'
      : `${app}.healthidentitydirectory.com`,
  },
  staging: {
    apiOrigin: 'https://api.staging.healthidentitydirectory.com',
    hostFor: (app) => app === 'web'
      ? 'staging.healthidentitydirectory.com'
      : `${app}.staging.healthidentitydirectory.com`,
  },
}
for (const [worker, [assets, app]] of Object.entries(appByWorker)) {
  const configPath = resolve(root, `infra/cloudflare/workers/${worker}/wrangler.json`)
  assert.ok((await stat(configPath)).isFile(), `${worker} Wrangler configuration is missing`)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(config.name, worker)
  assert.ok(String(config.assets?.directory).endsWith(assets), `${worker} does not own ${assets}`)
  assert.equal(config.routes, undefined, `${worker} must use named deployment environments`)
  assert.equal(config.vars, undefined, `${worker} must not expose shared deployment variables`)
  for (const [deployment, expected] of Object.entries(cloudflareDeployments)) {
    const environment = config.env?.[deployment]
    const hostname = expected.hostFor(app)
    assert.equal(environment?.name, `${worker}-${deployment}`)
    assert.ok(environment.routes?.some((route) => route.pattern === hostname && route.custom_domain === true),
      `${worker} does not map ${hostname} for ${deployment}`)
    assert.deepEqual(environment.vars, {
      DEPLOYMENT_ENV: deployment,
      API_ORIGIN: expected.apiOrigin,
      EXPECTED_HOST: hostname,
      APP_NAME: app,
    })
    assert.equal(JSON.stringify(environment).includes('ORIGIN_AUTH_TOKEN'), false,
      `${worker} must bind its origin token as a Cloudflare secret, not config`)
  }
}

const apex = JSON.parse(await readFile(resolve(root, 'infra/cloudflare/workers/hid-apex-redirect/wrangler.json'), 'utf8'))
assert.equal(apex.routes, undefined)
assert.ok(apex.env?.production?.routes?.some((route) => route.pattern === 'healthidentitydirectory.com' && route.custom_domain === true))
assert.equal(apex.env?.staging, undefined)
const cloudflareWorker = await readFile(resolve(root, 'infra/cloudflare/src/frontend-worker.mjs'), 'utf8')
for (const { apiOrigin } of Object.values(cloudflareDeployments)) {
  assert.match(cloudflareWorker, new RegExp(apiOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
}
assert.match(cloudflareWorker, /API_PATH = \/\^\\\/api\\\/v1/)
assert.match(cloudflareWorker, /cache-control[^\n]+no-store/i)
assert.match(cloudflareWorker, /ORIGIN_AUTH_TOKEN/)

const regionalStack = await readFile(resolve(root, 'infra/aws/src/hid-regional-stack.ts'), 'utf8')
assert.doesNotMatch(regionalStack, /cloudfront/i, 'CloudFront must not be part of the target IaC')
for (const service of ['notification-api', 'notification-worker']) {
  assert.match(regionalStack, new RegExp(service), `${service} is missing from AWS IaC`)
  assert.ok((await stat(resolve(root, `services/${service}/Dockerfile`)).catch(() => null))?.isFile(),
    `${service} container definition is missing`)
}

const otp = await readFile(resolve(root, 'services/identity-api/src/auth/otp.service.ts'), 'utf8')
assert.match(otp, /randomInt/)
assert.match(otp, /draw\(0, 1_000_000\)\.toString\(\)\.padStart\(6, '0'\)/)
assert.match(otp, /OTP_MAX_ATTEMPTS/)
assert.match(otp, /OTP_RESEND_COOLDOWN_SECONDS/)
for (const script of ['stage-legacy-identity.mjs', 'promote-legacy-identity.mjs', 'reconcile-legacy-identity.mjs']) {
  assert.ok((await stat(resolve(root, 'services/ehr-api/scripts', script))).isFile(), `${script} is missing`)
}

console.log('NO ACTIVE BREVO RUNTIME DEPENDENCY')
console.log('NO ACTIVE SUPABASE RUNTIME DEPENDENCY')
console.log('NO ACTIVE VERCEL TARGET OR AUTHENTICATION MAGIC-LINK RUNTIME')
console.log('Verified seven Cloudflare static-asset workers, fixed API proxy, notification IaC, OTP policy, and migration tooling.')
