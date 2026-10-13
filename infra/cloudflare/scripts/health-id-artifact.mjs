// Validates a Health-id apps/patient-web build for one launch host and stages
// it, with a provenance file, as the asset directory of that host's Worker.
// Offline only: no credential, network or Cloudflare API access.
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import {
  HEALTH_ID_ARTIFACT_SOURCE,
  parseStrictJson,
  resolveHealthIdTarget,
} from './launch-manifest.mjs'

export { HEALTH_ID_ARTIFACT_SOURCE }
export const PROVENANCE_SCHEMA = 'hid.cloudflare.health-id-artifact/v1'
export const SOURCE_REPOSITORY = 'D-Eminence/Health-id'
export const SOURCE_APPLICATION = 'apps/patient-web'
export const BUILD_COMMAND = 'npm ci && npm run build:patient-web'

const cloudflareRootDefault = resolve(import.meta.dirname, '..')
const SOURCE_COMMIT = /^[0-9a-f]{40}$/
// Real Turnstile widgets have `0x` site keys; Cloudflare's documented test
// keys (`1x…`, `2x…`, `3x…`) always pass or fail and are not deployable.
const TURNSTILE_SITE_KEY = /^0x[0-9A-Za-z_-]{16,64}$/
const HASHED_ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,}\.(?:js|css|png|svg|webp|jpe?g|gif|ico|woff2?)$/
const TEXT_FILE = /\.(?:html|js|css|svg)$/
const MAX_FILES = 500
// Cloudflare Workers Static Assets refuses larger files.
const MAX_FILE_BYTES = 25 * 1024 * 1024

/**
 * The keys of Health-id's public environment record
 * (apps/patient-web/src/publicEnvironment.ts), which Vite inlines as one
 * object literal with its values. The provenance records exactly these.
 */
const RECORD_KEYS = Object.freeze([
  'VITE_HID_ENVIRONMENT', 'VITE_HID_API_BASE_URL', 'VITE_HID_APP_ORIGIN',
  'VITE_HID_TURNSTILE_SITE_KEY', 'VITE_HID_SENTRY_DSN',
])
const REQUIRED_RECORD_KEYS = Object.freeze([
  'VITE_HID_ENVIRONMENT', 'VITE_HID_API_BASE_URL', 'VITE_HID_APP_ORIGIN', 'VITE_HID_TURNSTILE_SITE_KEY',
])
/**
 * Google sign-in in a build. VITE_HID_GOOGLE_CLIENT_ID is not part of the
 * record: Health-id reads it where it is used (GoogleButton.tsx and the sign-in,
 * enrollment and portal routes), so a build with it set carries the id as a
 * bare literal of any value, with no key beside it, together with the Google
 * Identity Services loader and calls; with it unset, Vite drops all of them.
 * These markers, not the variable's name, are therefore the check.
 */
const GOOGLE_SIGN_IN = /accounts\.google\.com|\.apps\.googleusercontent\.com|\bgoogle\.accounts\.id\b|\/gsi\/client\b/
/** A build that inlines the whole env object would name the variable beside its value. */
const GOOGLE_CLIENT_ID_KEY = /(?:^|[{,\s])["']?VITE_HID_GOOGLE_CLIENT_ID["']?\s*:\s*/g
const NON_LITERAL = Symbol('non-literal')
const LITERAL_VALUE = /^(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`|(void 0|undefined)\b)/

const CREDENTIAL_PATTERNS = Object.freeze([
  ['an AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a PEM private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['a Stripe secret key', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
])

export class HealthIdArtifactError extends Error {
  constructor(issues) {
    super(`Health-id artefact refused:\n- ${issues.join('\n- ')}`)
    this.name = 'HealthIdArtifactError'
    this.issues = issues
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function posix(path) {
  return path.split(sep).join('/')
}

async function pathKind(path) {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return 'symlink'
    if (metadata.isDirectory()) return 'directory'
    if (metadata.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function listEntries(root, issues) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const relativePath = posix(relative(root, path))
      if (entry.isSymbolicLink()) issues.push(`${relativePath} is a symbolic link, not a regular file`)
      else if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(relativePath)
      else issues.push(`${relativePath} is not a regular file`)
    }
  }
  await visit(root)
  return files.sort()
}

function classifyPath(path, issues) {
  const name = path.split('/').at(-1)
  if (/\.map$/i.test(path)) {
    issues.push(`source map ${path}: Health-id builds publish no source maps (sourcemap: false)`)
  } else if (/^(?:service-worker|sw|workbox)(?:[-.][^/]*)?\.js$/i.test(name)) {
    issues.push(`service worker file ${path}: the Health-id portal registers no service worker`)
  } else if (/\.webmanifest$/i.test(name) || /^manifest(?:[-.][^/]*)?\.json$/i.test(name)) {
    issues.push(`web app manifest ${path}: the Health-id portal is not installable`)
  } else if (path !== 'index.html' && !HASHED_ASSET.test(path)) {
    issues.push(`${path} is outside the expected set (index.html and content-hashed files under assets/)`)
  }
}

function parseLiteral(source) {
  const match = LITERAL_VALUE.exec(source)
  if (!match) return NON_LITERAL
  if (match[4] !== undefined) return null
  const value = match[1] ?? match[2] ?? match[3]
  return value === '' ? null : value
}

function collectRecord(path, source, occurrences) {
  for (const key of RECORD_KEYS) {
    const pattern = new RegExp(`(?:^|[{,\\s])["']?${key}["']?\\s*:\\s*`, 'g')
    for (const match of source.matchAll(pattern)) {
      const value = parseLiteral(source.slice(match.index + match[0].length))
      occurrences[key].push({ path, value })
    }
  }
}

// index.html is allow-listed, not scanned for known-bad markup. Together with
// the edge Content-Security-Policy (frontend-worker.mjs, ADR-055), which allows
// script only from the build's own origin and Turnstile, this keeps it to the
// shell Vite writes for Health-id
// (doctype, html, head with meta charset/viewport/robots, title, one module
// entry script, modulepreload and stylesheet links, comments, and a body with
// the root div), loading code and styles only from the build's own /assets/.
// Anything it cannot parse exactly is refused.
const SHELL_TOKEN = new RegExp([
  '(?<comment><!--(?:[^<>!-]|-(?!-))*-->)',
  '(?<doctype><!doctype html>)',
  '<\\/(?<close>[a-z][a-z0-9]*)\\s*>',
  '<(?<open>[a-z][a-z0-9]*)(?<attributes>(?:\\s+[^\\s"\'<>\\/=]+(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'=<>`]+))?)*)\\s*(?<selfClosing>\\/?)>',
  '(?<text>[^<]+)',
].join('|'), 'iy')
const SHELL_ATTRIBUTE = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y
const CROSS_ORIGIN = /^(?:|anonymous)$/
const SHELL_ELEMENTS = Object.freeze({
  html: Object.freeze({ allowed: { lang: /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/ }, required: [] }),
  head: Object.freeze({ allowed: {}, required: [] }),
  title: Object.freeze({ allowed: {}, required: [] }),
  body: Object.freeze({ allowed: {}, required: [] }),
  div: Object.freeze({ allowed: { id: /^root$/ }, required: ['id'] }),
  meta: Object.freeze({ allowed: { charset: /^utf-8$/i, name: /^(?:viewport|robots)$/, content: /^[^<>]*$/ }, required: [] }),
  script: Object.freeze({ allowed: { type: /^module$/, crossorigin: CROSS_ORIGIN, src: 'asset' }, required: ['type', 'src'] }),
  link: Object.freeze({ allowed: { rel: /^(?:modulepreload|stylesheet)$/, crossorigin: CROSS_ORIGIN, href: 'asset' }, required: ['rel', 'href'] }),
})
const VOID_ELEMENTS = new Set(['meta', 'link'])
const CLOSED_ELEMENTS = new Set(['html', 'head', 'title', 'body', 'div', 'script'])
const ASSET_EXTENSION = Object.freeze({ script: '.js', modulepreload: '.js', stylesheet: '.css' })

function parseShellAttributes(source) {
  const attributes = new Map()
  const duplicates = []
  let position = 0
  while (position < source.length) {
    SHELL_ATTRIBUTE.lastIndex = position
    const match = SHELL_ATTRIBUTE.exec(source)
    if (!match) return { attributes, duplicates, unparsed: source.slice(position) }
    const name = match[1].toLowerCase()
    if (attributes.has(name)) duplicates.push(name)
    else attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '')
    position = SHELL_ATTRIBUTE.lastIndex
  }
  return { attributes, duplicates, unparsed: '' }
}

function checkShellElement(name, attributes, files, refuse) {
  const rule = SHELL_ELEMENTS[name]
  for (const [attribute, value] of attributes) {
    const allowed = rule.allowed[attribute]
    if (allowed === undefined) {
      refuse(`has <${name} ${attribute}=…>; the ${attribute} attribute is not part of the Vite shell`)
    } else if (allowed !== 'asset' && !allowed.test(value)) {
      refuse(`has <${name} ${attribute}=${JSON.stringify(value)}>, which the Vite shell does not use`)
    }
  }
  for (const attribute of rule.required) {
    if (!attributes.has(attribute)) refuse(`has a <${name}> without ${attribute}`)
  }
  if (name === 'meta') {
    const keys = [...attributes.keys()].sort().join(',')
    if (keys !== 'charset' && keys !== 'content,name') refuse(`has a <meta> that is neither a charset nor a viewport or robots name`)
  }
  const reference = name === 'script' ? attributes.get('src') : name === 'link' ? attributes.get('href') : undefined
  if (reference === undefined) return
  const extension = ASSET_EXTENSION[name === 'script' ? 'script' : attributes.get('rel')]
  if (!reference.startsWith('/assets/') || !files.includes(reference.slice(1))) {
    refuse(`loads ${reference} from outside its own /assets/ files`)
  } else if (extension !== undefined && !reference.endsWith(extension)) {
    refuse(`loads ${reference} as a ${name === 'script' ? 'script' : attributes.get('rel')}, which must be a ${extension} file`)
  }
}

function inspectIndexHtml(html, files, issues) {
  const refuse = (reason) => issues.push(`index.html ${reason}`)
  let doctype = false
  let scripts = 0
  let position = 0
  while (position < html.length) {
    SHELL_TOKEN.lastIndex = position
    const match = SHELL_TOKEN.exec(html)
    if (!match) {
      refuse(`has markup outside the Vite shell at offset ${position} (${JSON.stringify(html.slice(position, position + 40))})`)
      return
    }
    position = SHELL_TOKEN.lastIndex
    const { comment, close, open, attributes: attributeSource, selfClosing, text } = match.groups
    if (match.groups.doctype !== undefined) {
      if (doctype || html.slice(0, match.index).trim() !== '') refuse('has a doctype that is not its first token')
      doctype = true
      continue
    }
    if (text !== undefined) {
      if (text.trim() !== '') refuse(`has text outside <title> (${JSON.stringify(text.trim().slice(0, 40))})`)
      continue
    }
    if (!doctype) {
      refuse('must start with <!doctype html>')
      return
    }
    if (comment !== undefined) continue
    if (close !== undefined) {
      if (!CLOSED_ELEMENTS.has(close.toLowerCase())) refuse(`has an unexpected end tag </${close}>`)
      continue
    }
    const name = open.toLowerCase()
    if (!Object.hasOwn(SHELL_ELEMENTS, name)) {
      refuse(`has a <${name}> element, which is not part of the Vite shell`)
      continue
    }
    const { attributes, duplicates, unparsed } = parseShellAttributes(attributeSource)
    if (unparsed !== '') refuse(`has a <${name}> whose attributes cannot be parsed (${JSON.stringify(unparsed.slice(0, 40))})`)
    for (const duplicate of duplicates) refuse(`has a <${name}> with a duplicate ${duplicate} attribute`)
    if (selfClosing !== '' && !VOID_ELEMENTS.has(name)) refuse(`has a self-closing <${name}/>`)
    if (name === 'link' && /^manifest$/i.test(attributes.get('rel') ?? '')) {
      refuse('links a web app manifest; the Health-id portal is not installable')
      continue
    }
    checkShellElement(name, attributes, files, refuse)
    if (name === 'script' || name === 'title') {
      // Raw text (script) or escapable raw text (title) runs to the end tag.
      const end = html.slice(position).search(name === 'script' ? /<\/script[\s/>]/i : /<\/title[\s/>]/i)
      if (end === -1) {
        refuse(`has an unclosed <${name}>`)
        return
      }
      const content = html.slice(position, position + end)
      if (name === 'script') {
        scripts += 1
        if (content.trim() !== '') refuse('has an inline script; the build must load code only from /assets/')
      } else if (content.includes('<')) {
        refuse('has markup inside <title>')
      }
      position += end
    }
  }
  if (!doctype) refuse('must start with <!doctype html>')
  if (scripts !== 1) refuse(`must load exactly one entry script (a module script from its own /assets/); it has ${scripts}`)
}

function checkRecord(occurrences, { environment, host }, issues) {
  const origin = `https://${host}`
  const summary = {}
  if (REQUIRED_RECORD_KEYS.every((key) => occurrences[key].length === 0)) {
    issues.push('the build does not carry the Health-id public environment record '
      + '(apps/patient-web/src/publicEnvironment.ts); is this a Health-id patient-web build?')
  }
  for (const key of RECORD_KEYS) {
    const found = occurrences[key]
    if (found.some((entry) => entry.value === NON_LITERAL)) {
      issues.push(`${key} is not inlined as a literal value, so the build cannot be verified`)
      summary[key] = null
      continue
    }
    const values = [...new Set(found.map((entry) => entry.value))]
    if (values.length > 1) {
      issues.push(`${key} is inlined with different values (${values.map((value) => JSON.stringify(value)).join(', ')}); `
        + 'the build must carry exactly one Health-id public environment record')
    }
    summary[key] = values.length === 1 ? values[0] : null
  }

  if (summary.VITE_HID_ENVIRONMENT !== environment) {
    issues.push(`VITE_HID_ENVIRONMENT is ${JSON.stringify(summary.VITE_HID_ENVIRONMENT)} but must be ${JSON.stringify(environment)}`)
  }
  for (const key of ['VITE_HID_API_BASE_URL', 'VITE_HID_APP_ORIGIN']) {
    if (summary[key] === null) {
      issues.push(`${key} is not set; it must be exactly ${origin} (the host's own origin; cookie sessions are same-origin)`)
    } else if (summary[key] !== origin) {
      issues.push(`${key} is ${JSON.stringify(summary[key])} but must be exactly ${origin} `
        + '(the host\'s own origin; cookie sessions are same-origin)')
    }
  }
  const siteKey = summary.VITE_HID_TURNSTILE_SITE_KEY
  if (siteKey === null) {
    issues.push('VITE_HID_TURNSTILE_SITE_KEY is missing; staging and production require the Turnstile site key of the environment\'s widget')
  } else if (!TURNSTILE_SITE_KEY.test(siteKey)) {
    issues.push('VITE_HID_TURNSTILE_SITE_KEY is not a deployable Turnstile site key (expected 0x followed by 16 to 64 characters; test keys are refused)')
  }
  if (summary.VITE_HID_SENTRY_DSN !== null) {
    issues.push('VITE_HID_SENTRY_DSN is set; no error-reporting processor is approved for launch, so build without it')
  }
  return summary
}

/**
 * Checks a Health-id build directory against the launch rules for one host.
 * Returns the file list with hashes and the inlined public environment, or
 * throws HealthIdArtifactError listing every reason it is refused.
 */
export async function inspectHealthIdBuild(directory, { environment, host }) {
  const issues = []
  const kind = await pathKind(directory)
  if (kind !== 'directory') throw new HealthIdArtifactError([`build directory ${directory} is not a directory (${kind})`])
  const paths = await listEntries(directory, issues)
  if (!paths.includes('index.html')) issues.push('index.html is missing at the build root')
  if (paths.length > MAX_FILES) issues.push(`the build has ${paths.length} files; at most ${MAX_FILES} are expected`)

  const occurrences = Object.fromEntries(RECORD_KEYS.map((key) => [key, []]))
  const files = []
  for (const path of paths) {
    classifyPath(path, issues)
    const bytes = await readFile(resolve(directory, path))
    if (bytes.length > MAX_FILE_BYTES) issues.push(`${path} is larger than the Cloudflare asset limit (25 MiB)`)
    files.push({ path, sha256: sha256(bytes), bytes: bytes.length })
    if (!TEXT_FILE.test(path)) continue
    const source = bytes.toString('utf8')
    if (/sourceMappingURL\s*=/.test(source)) issues.push(`source map reference in ${path}: Health-id builds publish no source maps`)
    if (path.endsWith('.js') && /\bserviceWorker\b/.test(source)) {
      issues.push(`service worker registration in ${path}: the Health-id portal registers no service worker`)
    }
    if (GOOGLE_SIGN_IN.test(source)) {
      issues.push(`Google sign-in reference in ${path} (Google Identity Services or a Google OAuth client id): `
        + 'Google sign-in is off at launch, so build without VITE_HID_GOOGLE_CLIENT_ID')
    }
    for (const match of source.matchAll(GOOGLE_CLIENT_ID_KEY)) {
      if (parseLiteral(source.slice(match.index + match[0].length)) !== null) {
        issues.push(`${path} inlines VITE_HID_GOOGLE_CLIENT_ID with a value; Google sign-in is off at launch, so build without it`)
      }
    }
    for (const [label, pattern] of CREDENTIAL_PATTERNS) {
      if (pattern.test(source)) issues.push(`${path} contains a value shaped like ${label}`)
    }
    if (path.endsWith('.js')) collectRecord(path, source, occurrences)
    if (path === 'index.html') inspectIndexHtml(source, paths, issues)
  }
  const buildEnvironment = checkRecord(occurrences, { environment, host }, issues)
  if (issues.length > 0) throw new HealthIdArtifactError(issues)
  return { files, buildEnvironment }
}

export function treeSha256(files) {
  return sha256(files.map((file) => `${file.sha256}  ${file.path}\n`).join(''))
}

/**
 * Why `destination` may not be replaced by a new artefact for this Worker and
 * environment, or null when it may: it is missing, an empty directory, or
 * exactly the site/ directory and provenance.json of an earlier artefact of
 * this schema staged for the same Worker and environment. Anything else, such
 * as a mistyped --staged-directory, is left alone.
 */
async function destinationRefusal(destination, { worker, environment }) {
  const kind = await pathKind(destination)
  if (kind === 'missing') return null
  const refusal = (reason) => `${destination} is not an earlier staged Health-id artefact for ${worker} ${environment} `
    + `(${reason}); refusing to replace it: name a new or empty directory, or that artefact's own staged directory`
  if (kind !== 'directory') return refusal(`it is ${kind === 'symlink' ? 'a symbolic link' : kind === 'file' ? 'a regular file' : 'not a directory'}`)
  const entries = (await readdir(destination)).sort()
  if (entries.length === 0) return null
  if (entries.length !== 2 || entries[0] !== 'provenance.json' || entries[1] !== 'site') {
    const shown = entries.slice(0, 5).map((entry) => JSON.stringify(entry)).join(', ')
    return refusal(`it holds ${shown}${entries.length > 5 ? ', …' : ''}, not exactly site/ and provenance.json`)
  }
  if ((await pathKind(resolve(destination, 'site'))) !== 'directory') return refusal('its site is not a directory')
  if ((await pathKind(resolve(destination, 'provenance.json'))) !== 'file') return refusal('its provenance.json is not a regular file')
  let provenance
  try {
    provenance = parseStrictJson(await readFile(resolve(destination, 'provenance.json'), 'utf8'), 'provenance.json')
  } catch {
    return refusal('its provenance.json is not valid JSON')
  }
  if (provenance === null || typeof provenance !== 'object' || provenance.schema_version !== PROVENANCE_SCHEMA) {
    return refusal(`its provenance.json is not of schema ${PROVENANCE_SCHEMA}`)
  }
  if (provenance.worker !== worker || provenance.environment !== environment) {
    return refusal(`it was staged for ${JSON.stringify(provenance.worker)} ${JSON.stringify(provenance.environment)}`)
  }
  return null
}

function isInside(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep) && path !== '..')
}

/**
 * Validates a Health-id build for one launch Worker and environment and stages
 * it at <stagedDirectory>/site with <stagedDirectory>/provenance.json beside
 * it (never inside the served assets). On any refusal nothing is written.
 */
export async function stageHealthIdBuild({
  build, sourceCommit, worker, environment, cloudflareRoot = cloudflareRootDefault, stagedDirectory, now = new Date(),
}) {
  const issues = []
  if (typeof sourceCommit !== 'string' || !SOURCE_COMMIT.test(sourceCommit)) {
    issues.push('source commit must be the full 40-character lowercase hexadecimal Health-id commit the build was made from')
  }
  const resolved = await resolveHealthIdTarget({ cloudflareRoot, worker, environment })
  issues.push(...resolved.issues)
  if (!resolved.target) throw new HealthIdArtifactError(issues)
  const { host } = resolved.target
  const buildDirectory = resolve(build)
  const destination = resolve(stagedDirectory)
  if (isInside(destination, buildDirectory) || isInside(buildDirectory, destination)) {
    issues.push('the build directory and the staged directory must not contain each other')
    throw new HealthIdArtifactError(issues)
  }
  const refusal = await destinationRefusal(destination, { worker, environment })
  if (refusal !== null) issues.push(refusal)

  let inspected
  try {
    inspected = await inspectHealthIdBuild(buildDirectory, { environment, host })
  } catch (error) {
    if (!(error instanceof HealthIdArtifactError)) throw error
    issues.push(...error.issues)
  }
  if (issues.length > 0) throw new HealthIdArtifactError(issues)

  const provenance = {
    schema_version: PROVENANCE_SCHEMA,
    artifact_source: HEALTH_ID_ARTIFACT_SOURCE,
    source_repository: SOURCE_REPOSITORY,
    source_application: SOURCE_APPLICATION,
    source_commit: sourceCommit,
    build_command: BUILD_COMMAND,
    worker,
    environment,
    host,
    build_environment: inspected.buildEnvironment,
    staged_at: now.toISOString(),
    staged_by: 'infra/cloudflare/scripts/stage-health-id-build.mjs',
    file_count: inspected.files.length,
    tree_sha256: treeSha256(inspected.files),
    files: inspected.files,
  }

  await mkdir(dirname(destination), { recursive: true })
  const suffix = randomBytes(6).toString('hex')
  const temporary = `${destination}.staging-${suffix}`
  const previous = `${destination}.previous-${suffix}`
  try {
    for (const file of inspected.files) {
      const target = resolve(temporary, 'site', file.path)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(resolve(buildDirectory, file.path), target)
    }
    // The copy is what will be served: check it again, so a build changed
    // while it was being copied cannot slip through.
    const copied = await inspectHealthIdBuild(resolve(temporary, 'site'), { environment, host })
    if (treeSha256(copied.files) !== provenance.tree_sha256) {
      throw new HealthIdArtifactError(['the build changed while it was being staged'])
    }
    await writeFile(resolve(temporary, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
    // Checked again just before the swap, in case the destination changed
    // while the build was being copied.
    const lateRefusal = await destinationRefusal(destination, { worker, environment })
    if (lateRefusal !== null) throw new HealthIdArtifactError([lateRefusal])
    const hadPrevious = (await pathKind(destination)) !== 'missing'
    if (hadPrevious) await rename(destination, previous)
    await rename(temporary, destination)
    if (hadPrevious) await rm(previous, { recursive: true, force: true })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return {
    provenance,
    siteDirectory: resolve(destination, 'site'),
    provenancePath: resolve(destination, 'provenance.json'),
  }
}

/**
 * Re-checks a staged artefact: its provenance names this Worker, environment
 * and host, every served file is listed with its hash and nothing else is
 * served, and the files still pass the build rules.
 */
export async function verifyStagedHealthIdArtifact({ worker, environment, host, stagedDirectory }) {
  const issues = []
  const provenancePath = resolve(stagedDirectory, 'provenance.json')
  const siteDirectory = resolve(stagedDirectory, 'site')
  if ((await pathKind(provenancePath)) !== 'file') throw new HealthIdArtifactError([`provenance.json is missing from ${stagedDirectory}`])
  if ((await pathKind(siteDirectory)) !== 'directory') throw new HealthIdArtifactError([`site/ is missing from ${stagedDirectory}`])
  let provenance
  try {
    provenance = parseStrictJson(await readFile(provenancePath, 'utf8'), 'provenance.json')
  } catch (error) {
    throw new HealthIdArtifactError([error.message])
  }
  for (const [field, expected] of [
    ['schema_version', PROVENANCE_SCHEMA], ['artifact_source', HEALTH_ID_ARTIFACT_SOURCE],
    ['source_repository', SOURCE_REPOSITORY], ['source_application', SOURCE_APPLICATION],
    ['worker', worker], ['environment', environment], ['host', host],
  ]) {
    if (provenance[field] !== expected) {
      issues.push(`provenance ${field} is ${JSON.stringify(provenance[field])}, expected ${JSON.stringify(expected)}`)
    }
  }
  if (typeof provenance.source_commit !== 'string' || !SOURCE_COMMIT.test(provenance.source_commit)) {
    issues.push('provenance source_commit is not a full 40-character lowercase hexadecimal commit')
  }
  const listed = Array.isArray(provenance.files) ? provenance.files : []
  if (!Array.isArray(provenance.files)) issues.push('provenance files is not a list')
  if (provenance.file_count !== listed.length) issues.push('provenance file_count does not match its file list')
  if (provenance.tree_sha256 !== treeSha256(listed)) issues.push('provenance tree_sha256 does not match its file list')

  let inspected
  try {
    inspected = await inspectHealthIdBuild(siteDirectory, { environment, host })
  } catch (error) {
    if (!(error instanceof HealthIdArtifactError)) throw error
    issues.push(...error.issues)
  }
  if (inspected) {
    const served = new Map(inspected.files.map((file) => [file.path, file]))
    const recorded = new Map(listed.map((file) => [file.path, file]))
    for (const [path, file] of served) {
      const entry = recorded.get(path)
      if (!entry) issues.push(`${path} is served but not listed in the provenance`)
      else if (entry.sha256 !== file.sha256 || entry.bytes !== file.bytes) issues.push(`${path} does not match its provenance hash`)
    }
    for (const path of recorded.keys()) {
      if (!served.has(path)) issues.push(`${path} is listed in the provenance but not staged`)
    }
    if (JSON.stringify(provenance.build_environment) !== JSON.stringify(inspected.buildEnvironment)) {
      issues.push('provenance build_environment does not match the staged build')
    }
  }
  if (issues.length > 0) throw new HealthIdArtifactError(issues)
  return provenance
}
