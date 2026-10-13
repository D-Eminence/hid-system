import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

export const SOURCE_COMMIT = '82b474ef93e279dde361ace0776f2ed2ec2b0880'
export const SITE_KEY = '0x4AAAAAAAFixtureSiteKeyPublic'

const HOSTS = Object.freeze({
  'hid-web': Object.freeze({
    staging: 'staging.healthidentitydirectory.com',
    production: 'www.healthidentitydirectory.com',
  }),
  'hid-admin': Object.freeze({
    staging: 'admin.staging.healthidentitydirectory.com',
    production: 'admin.healthidentitydirectory.com',
  }),
})

export function hostFor(worker, environment) {
  return HOSTS[worker][environment]
}

export async function temporaryDirectory(prefix = 'hid-health-id-') {
  return mkdtemp(resolve(tmpdir(), prefix))
}

function literal(value) {
  return value === undefined ? 'void 0' : `\`${value}\``
}

/**
 * The public environment record a Health-id patient-web build inlines (its
 * src/publicEnvironment.ts), as Vite 8 / Rolldown emits it: template literals
 * for set values and `void 0` for unset ones.
 */
export function environmentRecord(values) {
  const keys = [
    'VITE_HID_ENVIRONMENT', 'VITE_HID_API_BASE_URL', 'VITE_HID_APP_ORIGIN',
    'VITE_HID_TURNSTILE_SITE_KEY', 'VITE_HID_SENTRY_DSN',
  ]
  return `{${keys.map((key) => `${key}:${literal(values[key])}`).join(',')}}`
}

export function buildValues({ worker = 'hid-web', environment = 'staging', ...overrides } = {}) {
  const origin = `https://${hostFor(worker, environment)}`
  return {
    VITE_HID_ENVIRONMENT: environment,
    VITE_HID_API_BASE_URL: origin,
    VITE_HID_APP_ORIGIN: origin,
    VITE_HID_TURNSTILE_SITE_KEY: SITE_KEY,
    VITE_HID_SENTRY_DSN: undefined,
    ...overrides,
  }
}

export function indexHtml({ extraHead = '' } = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Health ID: Patient</title>
    <script type="module" crossorigin src="/assets/index-AbCdEf12.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-react-Gh34IjKl.js">
    <link rel="stylesheet" crossorigin href="/assets/index-Mn56OpQr.css">${extraHead}
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`
}

/**
 * Writes a minimal build shaped like Health-id's `npm run build:patient-web`
 * output: index.html plus hashed files under assets/. `values` overrides the
 * inlined public environment; `files` adds or replaces files (null removes).
 */
export async function writeHealthIdBuild(directory, {
  worker = 'hid-web', environment = 'staging', values = {}, files = {}, html,
} = {}) {
  const record = environmentRecord({ ...buildValues({ worker, environment }), ...values })
  const contents = {
    'index.html': html ?? indexHtml(),
    'assets/index-AbCdEf12.js': `const e=${record};const t='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';export{e,t};\n`,
    'assets/vendor-react-Gh34IjKl.js': 'export const react={version:`19.2.0`};\n',
    'assets/index-Mn56OpQr.css': 'body{margin:0}\n',
    'assets/logo-Bvs4aJ19.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...files,
  }
  for (const [path, content] of Object.entries(contents)) {
    if (content === null) continue
    const target = resolve(directory, path)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return directory
}
