import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, appendFile, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  HEALTH_ID_ARTIFACT_SOURCE,
  HealthIdArtifactError,
  stageHealthIdBuild,
  verifyStagedHealthIdArtifact,
} from '../scripts/health-id-artifact.mjs'
import {
  SITE_KEY,
  SOURCE_COMMIT,
  buildValues,
  environmentRecord,
  hostFor,
  indexHtml,
  temporaryDirectory,
  writeHealthIdBuild,
} from './helpers/health-id-build-fixture.mjs'

const execute = promisify(execFile)
const stageScript = resolve(import.meta.dirname, '../scripts/stage-health-id-build.mjs')
const LAUNCH_TARGETS = [
  ['hid-web', 'staging'], ['hid-web', 'production'],
  ['hid-admin', 'staging'], ['hid-admin', 'production'],
]

async function filesBelow(directory) {
  const output = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else output.push(relative(directory, path).split(sep).join('/'))
    }
  }
  await visit(directory)
  return output.sort()
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function stageFixture(t, { worker = 'hid-web', environment = 'staging', ...build } = {}) {
  const root = await temporaryDirectory()
  t.after(() => rm(root, { recursive: true, force: true }))
  const buildDirectory = await writeHealthIdBuild(resolve(root, 'build'), { worker, environment, ...build })
  const stagedDirectory = resolve(root, 'staged', environment)
  return { root, buildDirectory, stagedDirectory, stage: (overrides = {}) => stageHealthIdBuild({
    build: buildDirectory, sourceCommit: SOURCE_COMMIT, worker, environment, stagedDirectory,
    now: new Date('2026-10-13T08:00:00Z'), ...overrides,
  }) }
}

async function assertRefused(t, build, pattern, overrides = {}) {
  const fixture = await stageFixture(t, build)
  await assert.rejects(fixture.stage(overrides), (error) => {
    assert.ok(error instanceof HealthIdArtifactError, `expected a refusal, got ${error}`)
    assert.ok(error.issues.some((issue) => pattern.test(issue)),
      `expected an issue matching ${pattern}, got:\n- ${error.issues.join('\n- ')}`)
    return true
  })
  assert.equal(await exists(fixture.stagedDirectory), false, 'a refused build must stage nothing')
}

test('stages a Health-id build with its provenance for each launch worker and environment', async (t) => {
  for (const [worker, environment] of LAUNCH_TARGETS) {
    const fixture = await stageFixture(t, { worker, environment })
    const { provenance, siteDirectory, provenancePath } = await fixture.stage()
    assert.equal(siteDirectory, resolve(fixture.stagedDirectory, 'site'))
    assert.equal(provenancePath, resolve(fixture.stagedDirectory, 'provenance.json'))
    assert.deepEqual(await filesBelow(siteDirectory), await filesBelow(fixture.buildDirectory))
    assert.deepEqual(await filesBelow(fixture.stagedDirectory), [
      'provenance.json',
      ...(await filesBelow(siteDirectory)).map((path) => `site/${path}`),
    ].sort(), 'the provenance file is kept beside the served assets, never inside them')

    const origin = `https://${hostFor(worker, environment)}`
    assert.deepEqual(JSON.parse(await readFile(provenancePath, 'utf8')), provenance)
    assert.equal(provenance.schema_version, 'hid.cloudflare.health-id-artifact/v1')
    assert.equal(provenance.artifact_source, HEALTH_ID_ARTIFACT_SOURCE)
    assert.equal(provenance.source_repository, 'D-Eminence/Health-id')
    assert.equal(provenance.source_application, 'apps/patient-web')
    assert.equal(provenance.source_commit, SOURCE_COMMIT)
    assert.equal(provenance.worker, worker)
    assert.equal(provenance.environment, environment)
    assert.equal(provenance.host, hostFor(worker, environment))
    assert.equal(provenance.staged_at, '2026-10-13T08:00:00.000Z')
    assert.deepEqual(provenance.build_environment, {
      VITE_HID_ENVIRONMENT: environment,
      VITE_HID_API_BASE_URL: origin,
      VITE_HID_APP_ORIGIN: origin,
      VITE_HID_TURNSTILE_SITE_KEY: SITE_KEY,
      VITE_HID_SENTRY_DSN: null,
    }, 'the provenance records the public environment record Health-id inlines (src/publicEnvironment.ts), nothing more')
    assert.deepEqual(provenance.files.map((file) => file.path), await filesBelow(siteDirectory))
    for (const file of provenance.files) {
      const bytes = await readFile(resolve(siteDirectory, file.path))
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.equal(file.bytes, bytes.length)
    }
    assert.match(provenance.tree_sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(await verifyStagedHealthIdArtifact({
      worker, environment, host: hostFor(worker, environment), stagedDirectory: fixture.stagedDirectory,
    }), provenance)
  }
})

test('refuses a build whose API base URL or app origin is not exactly the host origin', async (t) => {
  const staging = 'https://staging.healthidentitydirectory.com'
  for (const [values, pattern] of [
    [{ VITE_HID_API_BASE_URL: 'https://api.staging.healthidentitydirectory.com' }, /VITE_HID_API_BASE_URL .*https:\/\/staging\.healthidentitydirectory\.com/],
    [{ VITE_HID_APP_ORIGIN: 'https://www.healthidentitydirectory.com' }, /VITE_HID_APP_ORIGIN/],
    [{ VITE_HID_API_BASE_URL: `${staging}/`, VITE_HID_APP_ORIGIN: `${staging}/` }, /VITE_HID_API_BASE_URL/],
    [{ VITE_HID_API_BASE_URL: `${staging}/api/v1` }, /VITE_HID_API_BASE_URL/],
    [{ VITE_HID_API_BASE_URL: 'http://staging.healthidentitydirectory.com' }, /VITE_HID_API_BASE_URL/],
    [{ VITE_HID_API_BASE_URL: undefined }, /VITE_HID_API_BASE_URL/],
  ]) await assertRefused(t, { values }, pattern)

  // An admin build is not a web build: each host gets its own build.
  await assertRefused(t, { worker: 'hid-web', values: buildValues({ worker: 'hid-admin' }) }, /VITE_HID_APP_ORIGIN/)
})

test('refuses a build made for another environment', async (t) => {
  await assertRefused(t, { values: { VITE_HID_ENVIRONMENT: 'production' } }, /VITE_HID_ENVIRONMENT/)
  await assertRefused(t, { values: { VITE_HID_ENVIRONMENT: 'local' } }, /VITE_HID_ENVIRONMENT/)
})

test('refuses a build that carries a Google client id or loads Google sign-in', async (t) => {
  await assertRefused(t, { files: {
    'assets/GoogleButton-Ab12Cd34.js': 'const c=`123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com`;\n',
  } }, /Google/)
  await assertRefused(t, { files: {
    'assets/GoogleButton-Ab12Cd34.js': "s.src='https://accounts.google.com/gsi/client';\n",
  } }, /Google/)
  await assertRefused(t, { files: {
    'assets/env-Ab12Cd34.js': 'const g={VITE_HID_GOOGLE_CLIENT_ID:`configured`};\n',
  } }, /VITE_HID_GOOGLE_CLIENT_ID/)
  // As a Health-id build with VITE_HID_GOOGLE_CLIENT_ID set compiles it: the id
  // inlined as a bare literal where GoogleButton reads it (any value, here not
  // a googleusercontent.com id), and Google Identity Services called by name.
  await assertRefused(t, { files: {
    'assets/App-Ab12Cd34.js': 'function g({onCredential:r}){let i=`placeholder-google-client`;'
      + 'window.google.accounts.id.initialize({client_id:i,callback:r})}export{g};\n',
  } }, /Google/)
})

test('refuses a build without a usable Turnstile site key', async (t) => {
  await assertRefused(t, { values: { VITE_HID_TURNSTILE_SITE_KEY: undefined } }, /VITE_HID_TURNSTILE_SITE_KEY/)
  await assertRefused(t, { values: { VITE_HID_TURNSTILE_SITE_KEY: '' } }, /VITE_HID_TURNSTILE_SITE_KEY/)
  // Cloudflare's documented always-pass test key is not a deployable widget.
  await assertRefused(t, { values: { VITE_HID_TURNSTILE_SITE_KEY: '1x00000000000000000000AA' } }, /VITE_HID_TURNSTILE_SITE_KEY/)
})

test('refuses an error-reporting DSN, which no launch decision approves', async (t) => {
  await assertRefused(t, { values: { VITE_HID_SENTRY_DSN: 'https://public@o1.ingest.example.invalid/1' } }, /VITE_HID_SENTRY_DSN/)
})

test('refuses source maps', async (t) => {
  await assertRefused(t, { files: { 'assets/index-AbCdEf12.js.map': '{"version":3}' } }, /source map/i)
  await assertRefused(t, { files: {
    'assets/vendor-react-Gh34IjKl.js': 'export const react=1;\n//# sourceMappingURL=vendor-react-Gh34IjKl.js.map\n',
  } }, /source map/i)
  await assertRefused(t, { files: {
    'assets/index-Mn56OpQr.css': 'body{margin:0}\n/*# sourceMappingURL=data:application/json;base64,e30= */\n',
  } }, /source map/i)
})

test('refuses service workers and web app manifests', async (t) => {
  await assertRefused(t, { files: { 'service-worker.js': 'self.addEventListener(`fetch`,()=>{})\n' } }, /service worker/i)
  await assertRefused(t, { files: { 'assets/sw-Ab12Cd34.js': 'self.addEventListener(`fetch`,()=>{})\n' } }, /service worker/i)
  await assertRefused(t, { files: { 'manifest.webmanifest': '{"name":"Health ID"}' } }, /manifest/i)
  await assertRefused(t, { files: { 'assets/manifest-Ab12Cd34.json': '{"name":"Health ID"}' } }, /manifest|outside the expected set/i)
  await assertRefused(t, { files: {
    'assets/vendor-react-Gh34IjKl.js': 'navigator.serviceWorker.register(`/sw.js`);\n',
  } }, /service worker/i)
  await assertRefused(t, { html: indexHtml({ extraHead: '\n    <link rel="manifest" href="/manifest.webmanifest">' }) }, /manifest/i)
})

test('refuses files outside the expected set', async (t) => {
  for (const [files, pattern] of [
    [{ 'robots.txt': 'User-agent: *\n' }, /robots\.txt/],
    [{ 'favicon.ico': Buffer.from([0, 0, 1, 0]) }, /favicon\.ico/],
    [{ 'assets/nested/chunk-Ab12Cd34.js': 'export{}\n' }, /assets\/nested\/chunk-Ab12Cd34\.js/],
    [{ '.env': 'VITE_HID_ENVIRONMENT=staging\n' }, /\.env/],
    [{ 'assets/App-Ab12Cd34.tsx': 'export{}\n' }, /App-Ab12Cd34\.tsx/],
    [{ 'other.html': '<!doctype html>' }, /other\.html/],
    [{ 'assets/main.js': 'export{}\n' }, /assets\/main\.js/],
    [{ 'index.html': null }, /index\.html/],
  ]) await assertRefused(t, { files }, pattern)

  const fixture = await stageFixture(t)
  await symlink('/etc/hostname', resolve(fixture.buildDirectory, 'assets', 'linked-Ab12Cd34.js'))
  await assert.rejects(fixture.stage(), (error) => error instanceof HealthIdArtifactError
    && error.issues.some((issue) => /linked-Ab12Cd34\.js.*(regular file|symbolic link)/.test(issue)))
  assert.equal(await exists(fixture.stagedDirectory), false)
})

test('refuses index.html that loads code or styles from anywhere but its own assets', async (t) => {
  await assertRefused(t, { html: indexHtml({ extraHead: '\n    <script src="https://cdn.example.invalid/x.js"></script>' }) }, /index\.html/)
  await assertRefused(t, { html: indexHtml({ extraHead: '\n    <script>window.x=1</script>' }) }, /inline script/i)
  await assertRefused(t, { html: indexHtml({ extraHead: '\n    <link rel="stylesheet" href="//cdn.example.invalid/x.css">' }) }, /index\.html/)
})

test('index.html must be the Vite shell only: every other tag, attribute or markup trick is refused', async (t) => {
  // With no edge CSP (ADR-052), this check is what keeps index.html to the
  // build's own /assets/ files, so it allow-lists what Vite writes rather than
  // looking for known-bad markup.
  const evil = 'https://evil.example.invalid'
  const head = [
    `<base href="${evil}/">`,
    `<script type="module" data-src="/assets/index-AbCdEf12.js" src="${evil}/x.js"></script>`,
    `<script type="module" src="/assets/index-AbCdEf12.js" src="${evil}/x.js"></script>`,
    `<style>@import url(${evil}/x.css)</style>`,
    `<img src="/assets/logo-Bvs4aJ19.png" onerror="alert(1)">`,
    `<meta http-equiv="refresh" content="0;url=${evil}/">`,
    `<meta name="viewport" content="width=device-width" http-equiv="refresh">`,
    `<iframe src="${evil}/"></iframe>`,
    `<object data="${evil}/x"></object>`,
    `<embed src="${evil}/x">`,
    `<link rel="preload" as="script" href="${evil}/x.js">`,
    `<link rel="icon" href="${evil}/favicon.ico">`,
    '<link rel="stylesheet modulepreload" href="/assets/index-Mn56OpQr.css">',
    '<link rel="stylesheet" href="/assets/index-Mn56OpQr.css" onload="alert(1)">',
    '<link rel="stylesheet" href="/assets/vendor-react-Gh34IjKl.js">',
    '<link rel="modulepreload" href="/assets/index-Mn56OpQr.css">',
    '<link rel="modulepreload" href="/assets/index-AbCdEf12.js?v=1">',
    `<SCRIPT SRC="${evil}/x.js"></SCRIPT>`,
    `<script/src="${evil}/x.js"></script>`,
    `<script type="module" src='${evil}/x.js'></script>`,
    '<script type="module" crossorigin src="/assets/vendor-react-Gh34IjKl.js"></script>',
    '<script type="text/javascript" src="/assets/index-AbCdEf12.js"></script>',
    '<script type="module" src="/assets/index-AbCdEf12.js" crossorigin="use-credentials"></script>',
    `<!--><script src="${evil}/x.js"></script>-->`,
    `<!-- a --!><script src="${evil}/x.js"></script><!-- b -->`,
    `<!---><script src="${evil}/x.js"></script>-->`,
    `<noscript><img src="${evil}/p.gif"></noscript>`,
    `<template><script src="${evil}/x.js"></script></template>`,
    `<svg><script href="${evil}/x.js"></script></svg>`,
    `<title>x</title><script src="${evil}/x.js"></script>`,
    '<meta charset="iso-8859-1">',
  ]
  for (const extraHead of head) {
    await assertRefused(t, { html: indexHtml({ extraHead: `\n    ${extraHead}` }) }, /index\.html/)
  }
  for (const extraBody of [
    `<a href="${evil}/">x</a>`,
    '<div id="root" onclick="alert(1)"></div>',
    '<div id="other"></div>',
    'loose text',
    `<form action="${evil}/"></form>`,
  ]) await assertRefused(t, { html: indexHtml({ extraBody: `\n    ${extraBody}` }) }, /index\.html/)

  // The entry script itself is required, exactly once.
  await assertRefused(t, {
    html: indexHtml().replace('<script type="module" crossorigin src="/assets/index-AbCdEf12.js"></script>', ''),
  }, /index\.html.*entry script/)
  await assertRefused(t, {
    html: indexHtml().replace('src="/assets/index-AbCdEf12.js"></script>', 'src="/assets/index-AbCdEf12.js">alert(1)</script>'),
  }, /index\.html/)
  await assertRefused(t, { html: `${indexHtml()}<script src="${evil}/x.js"></script>` }, /index\.html/)
  // A repeated attribute is refused even when both values are allowed.
  await assertRefused(t, {
    html: indexHtml().replace('<script type="module" crossorigin', '<script type="module" type="module" crossorigin'),
  }, /index\.html has a <script> with a duplicate type attribute/)
  await assertRefused(t, { html: indexHtml().replace('<!doctype html>', '') }, /index\.html/)
})

test('refuses a build without exactly one Health-id public environment record', async (t) => {
  await assertRefused(t, { files: { 'assets/index-AbCdEf12.js': 'export const e={};\n' } }, /public environment record/)
  await assertRefused(t, { files: {
    'assets/extra-Ab12Cd34.js': `const x=${environmentRecord(buildValues({ worker: 'hid-admin' }))};\n`,
  } }, /VITE_HID_API_BASE_URL|public environment record/)
  await assertRefused(t, { files: {
    'assets/index-AbCdEf12.js': 'const e={VITE_HID_ENVIRONMENT:`staging`,VITE_HID_API_BASE_URL:o,VITE_HID_APP_ORIGIN:o,VITE_HID_TURNSTILE_SITE_KEY:k,VITE_HID_SENTRY_DSN:void 0};\n',
  } }, /VITE_HID_API_BASE_URL/)
})

test('refuses credential-shaped values in the build', async (t) => {
  // Both values are assembled at run time so that this fixture is not itself a
  // finding of the repository's secret scans (scripts/verify-secret-readiness.mjs
  // and the build-context scan of scripts/verify-container-platform.mjs). The
  // key id is AWS's documented example; the staging step refuses it anyway.
  const awsKeyId = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
  await assertRefused(t, { files: { 'assets/leak-Ab12Cd34.js': `const k=\`${awsKeyId}\`;\n` } }, /AWS access key/)
  const pemHeader = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')
  await assertRefused(t, { files: {
    'assets/leak-Ab12Cd34.js': `const k=\`${pemHeader}\\nMIIE\`;\n`,
  } }, /private key/)
})

test('refuses targets outside the launch frontend set and malformed source commits', async (t) => {
  await assertRefused(t, {}, /hid-lab/, { worker: 'hid-lab' })
  await assertRefused(t, {}, /hid-ehr/, { worker: 'hid-ehr' })
  await assertRefused(t, {}, /environment/, { environment: 'development' })
  for (const sourceCommit of ['main', '82b474e', SOURCE_COMMIT.toUpperCase(), `${SOURCE_COMMIT}0`]) {
    await assertRefused(t, {}, /source commit/, { sourceCommit })
  }
})

test('verification detects a changed, added or removed staged file and a mismatched provenance', async (t) => {
  const target = { worker: 'hid-admin', environment: 'production' }
  const host = hostFor(target.worker, target.environment)
  const tamperings = [
    async (staged) => appendFile(resolve(staged, 'site', 'index.html'), '<!-- changed -->'),
    async (staged) => writeFile(resolve(staged, 'site', 'assets', 'added-Ab12Cd34.js'), 'export{}\n'),
    async (staged) => rm(resolve(staged, 'site', 'assets', 'index-Mn56OpQr.css')),
    async (staged) => rm(resolve(staged, 'provenance.json')),
    async (staged) => {
      const path = resolve(staged, 'provenance.json')
      const provenance = JSON.parse(await readFile(path, 'utf8'))
      provenance.host = 'admin.staging.healthidentitydirectory.com'
      await writeFile(path, JSON.stringify(provenance))
    },
    async (staged) => {
      const path = resolve(staged, 'provenance.json')
      const provenance = JSON.parse(await readFile(path, 'utf8'))
      provenance.source_commit = 'main'
      await writeFile(path, JSON.stringify(provenance))
    },
  ]
  for (const tamper of tamperings) {
    const fixture = await stageFixture(t, target)
    await fixture.stage()
    await tamper(fixture.stagedDirectory)
    await assert.rejects(verifyStagedHealthIdArtifact({ ...target, host, stagedDirectory: fixture.stagedDirectory }),
      HealthIdArtifactError)
  }

  const fixture = await stageFixture(t, target)
  await fixture.stage()
  await assert.rejects(verifyStagedHealthIdArtifact({
    worker: 'hid-admin', environment: 'staging', host: hostFor('hid-admin', 'staging'), stagedDirectory: fixture.stagedDirectory,
  }), HealthIdArtifactError)
})

test('restaging replaces the previous artefact completely', async (t) => {
  const fixture = await stageFixture(t, { files: { 'assets/old-Ab12Cd34.js': 'export{}\n' } })
  await fixture.stage()
  await rm(resolve(fixture.buildDirectory, 'assets', 'old-Ab12Cd34.js'))
  const { siteDirectory } = await fixture.stage()
  assert.equal(await exists(resolve(siteDirectory, 'assets', 'old-Ab12Cd34.js')), false)
  assert.deepEqual(await filesBelow(siteDirectory), await filesBelow(fixture.buildDirectory))
})

/** Every entry below `directory`, with file contents and link targets, to show nothing changed. */
async function snapshot(directory) {
  const entries = {}
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      const key = relative(directory, path).split(sep).join('/')
      if (entry.isSymbolicLink()) entries[key] = `symlink -> ${await readlink(path)}`
      else if (entry.isDirectory()) {
        entries[`${key}/`] = 'directory'
        await visit(path)
      } else entries[key] = (await readFile(path)).toString('base64')
    }
  }
  await visit(directory)
  return entries
}

test('refuses to stage over anything but an earlier artefact of the same Worker and environment, and changes nothing', async (t) => {
  const fixture = await stageFixture(t)
  const adminBuild = await writeHealthIdBuild(resolve(fixture.root, 'admin-build'), { worker: 'hid-admin' })
  const productionBuild = await writeHealthIdBuild(resolve(fixture.root, 'production-build'), { environment: 'production' })
  const stageOther = (build, worker, environment) => (destination) => stageHealthIdBuild({
    build, sourceCommit: SOURCE_COMMIT, worker, environment, stagedDirectory: destination,
  })
  const outside = resolve(fixture.root, 'outside')
  await mkdir(outside)
  await writeFile(resolve(outside, 'important.txt'), 'keep me\n')
  const cases = [
    ['an unrelated directory', async (destination) => {
      await mkdir(resolve(destination, 'nested'), { recursive: true })
      await writeFile(resolve(destination, 'important.txt'), 'keep me\n')
      await writeFile(resolve(destination, 'nested', 'also-important.txt'), 'keep me too\n')
    }],
    ['a regular file', (destination) => writeFile(destination, 'keep me\n')],
    ['a symbolic link to a directory', (destination) => symlink(outside, destination)],
    ['site/ and provenance.json of another schema', async (destination) => {
      await mkdir(resolve(destination, 'site'), { recursive: true })
      await writeFile(resolve(destination, 'site', 'index.html'), '<!doctype html>\n')
      await writeFile(resolve(destination, 'provenance.json'),
        JSON.stringify({ schema_version: 'something-else/v1', worker: 'hid-web', environment: 'staging' }))
    }],
    ['site/ and a provenance.json that is not JSON', async (destination) => {
      await mkdir(resolve(destination, 'site'), { recursive: true })
      await writeFile(resolve(destination, 'provenance.json'), 'not json\n')
    }],
    ['an earlier artefact with an extra file beside it', async (destination) => {
      await fixture.stage({ stagedDirectory: destination })
      await writeFile(resolve(destination, 'notes.txt'), 'keep me\n')
    }],
    ['an earlier artefact whose site is a symbolic link', async (destination) => {
      await fixture.stage({ stagedDirectory: destination })
      await rm(resolve(destination, 'site'), { recursive: true })
      await symlink(outside, resolve(destination, 'site'))
    }],
    ['the artefact of another Worker', stageOther(adminBuild, 'hid-admin', 'staging')],
    ['the artefact of another environment', stageOther(productionBuild, 'hid-web', 'production')],
  ]
  for (const [index, [label, prepare]] of cases.entries()) {
    const parent = resolve(fixture.root, `case-${index}`)
    await mkdir(parent)
    const destination = resolve(parent, 'staged')
    await prepare(destination)
    const before = { parent: await snapshot(parent), outside: await snapshot(outside) }
    await assert.rejects(fixture.stage({ stagedDirectory: destination }), (error) => {
      assert.ok(error instanceof HealthIdArtifactError, `${label}: expected a refusal, got ${error}`)
      assert.ok(error.issues.some((issue) => /not an earlier staged Health-id artefact for hid-web staging/.test(issue)),
        `${label}: unexpected issues:\n- ${error.issues.join('\n- ')}`)
      return true
    }, label)
    assert.deepEqual({ parent: await snapshot(parent), outside: await snapshot(outside) }, before,
      `${label}: a refused stage must leave the destination and its parent unchanged`)
  }

  // Nothing is lost by replacing an empty directory, such as a fresh mkdtemp.
  const empty = resolve(fixture.root, 'empty')
  await mkdir(empty)
  const { siteDirectory } = await fixture.stage({ stagedDirectory: empty })
  assert.deepEqual(await filesBelow(siteDirectory), await filesBelow(fixture.buildDirectory))
})

test('the stage command reports a refusal, writes nothing, and stages an accepted build', async (t) => {
  const root = await temporaryDirectory()
  t.after(() => rm(root, { recursive: true, force: true }))
  const bad = await writeHealthIdBuild(resolve(root, 'bad'), { values: { VITE_HID_TURNSTILE_SITE_KEY: undefined } })
  const good = await writeHealthIdBuild(resolve(root, 'good'))
  const stagedDirectory = resolve(root, 'staged')
  const args = (build) => [stageScript, '--worker', 'hid-web', '--environment', 'staging', '--build', build,
    '--source-commit', SOURCE_COMMIT, '--staged-directory', stagedDirectory]

  await assert.rejects(execute(process.execPath, args(bad)), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Refusing to stage/)
    assert.match(error.stderr, /VITE_HID_TURNSTILE_SITE_KEY/)
    return true
  })
  assert.equal(await exists(stagedDirectory), false)

  // A mistyped --staged-directory that names anything but an earlier artefact
  // of this Worker and environment is refused and left as it was.
  const mistyped = resolve(root, 'not-an-artefact')
  await mkdir(resolve(mistyped, 'nested'), { recursive: true })
  await writeFile(resolve(mistyped, 'important.txt'), 'keep me\n')
  await writeFile(resolve(mistyped, 'nested', 'also-important.txt'), 'keep me too\n')
  const mistypedArgs = args(good)
  mistypedArgs[mistypedArgs.indexOf('--staged-directory') + 1] = mistyped
  await assert.rejects(execute(process.execPath, mistypedArgs), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Refusing to stage/)
    assert.match(error.stderr, /not an earlier staged Health-id artefact/)
    return true
  })
  assert.deepEqual(await filesBelow(mistyped), ['important.txt', 'nested/also-important.txt'])
  assert.deepEqual((await readdir(root)).sort(), ['bad', 'good', 'not-an-artefact'])

  const { stdout } = await execute(process.execPath, args(good))
  const summary = JSON.parse(stdout)
  assert.equal(summary.status, 'staged')
  assert.equal(summary.worker, 'hid-web')
  assert.equal(summary.environment, 'staging')
  assert.equal(summary.host, 'staging.healthidentitydirectory.com')
  assert.equal(summary.source_commit, SOURCE_COMMIT)
  assert.equal(summary.file_count, 5)
  assert.equal(await exists(resolve(stagedDirectory, 'provenance.json')), true)

  await assert.rejects(execute(process.execPath, [stageScript, '--worker', 'hid-web']), /Usage/)
})
