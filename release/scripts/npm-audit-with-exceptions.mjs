#!/usr/bin/env node
// npm audit gate with reviewed, expiring exceptions. Node built-ins only.
//
// Usage: node release/scripts/npm-audit-with-exceptions.mjs <directory> [--exceptions <file>]
//
// Runs `npm --prefix <directory> audit --json` and passes only when every
// advisory at moderate severity or above is covered by an entry in the
// reviewed exceptions file (security/npm-audit-exceptions.json by default).
// An entry covers one advisory (GHSA id) in one package, at npm's exact
// vulnerable range and severity, at each listed installed path, in one audited
// directory, until it expires. Everything else fails closed:
//   - an advisory, or an installed path of it, that no entry covers;
//   - an expired entry (anywhere in the file);
//   - a stale entry: one of its paths no longer matches the audit. Stale
//     entries fail rather than warn, so the file cannot keep dead approvals;
//   - a malformed exceptions file, including one not in canonical
//     JSON.stringify(value, null, 2) form (which also rules out duplicate keys);
//   - npm failing to run, exiting other than 0 or 1, printing anything but a
//     version 2 audit report, or reporting an error.
// Advisories below moderate pass without an entry, as with --audit-level=moderate.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 'hid.npm-audit-exceptions/v1'
export const AUDIT_LEVEL = 'moderate'
export const SEVERITIES = Object.freeze(['info', 'low', 'moderate', 'high', 'critical'])
export const MAX_EXCEPTION_DAYS = 92
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const DEFAULT_EXCEPTIONS_PATH = resolve(REPOSITORY_ROOT, 'security/npm-audit-exceptions.json')

const DAY_MS = 86_400_000
const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/
const ADVISORY_URL = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ENTRY_FIELDS = Object.freeze(['directory', 'id', 'package', 'vulnerable_range', 'severity', 'paths',
  'justification', 'fix_status', 'approved_by', 'approved_at', 'expires_at'])
const FILE_FIELDS = Object.freeze(['schema_version', 'description', 'exceptions'])

export class AuditGateError extends Error {}
const fail = message => { throw new AuditGateError(message) }
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = value => typeof value === 'string' && value.trim() === value && value.length > 0
const rank = severity => SEVERITIES.indexOf(severity)
const gated = severity => rank(severity) >= rank(AUDIT_LEVEL)

function dayStart(value, field, label) {
  if (typeof value !== 'string' || !DATE.test(value)) fail(`${label}: ${field} must be a YYYY-MM-DD date`)
  const time = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) fail(`${label}: ${field} is not a real date`)
  return time
}

function describe(entry) {
  return `${entry.id} ${entry.package} ${entry.vulnerable_range} (${entry.severity}) in ${entry.directory}`
}

// Validates the whole exceptions file. `now` is checked against approval dates
// here; expiry is reported by evaluateAudit so it is listed with the findings.
export function parseExceptions(text, now) {
  let file
  try { file = JSON.parse(text) } catch { fail('exceptions file is not valid JSON') }
  if (!isPlainObject(file)) fail('exceptions file must be a JSON object')
  for (const key of Object.keys(file)) if (!FILE_FIELDS.includes(key)) fail(`exceptions file has unknown field ${key}`)
  if (file.schema_version !== SCHEMA_VERSION) fail(`exceptions file schema_version must be ${SCHEMA_VERSION}`)
  if (file.description !== undefined && !isText(file.description)) fail('exceptions file description must be text')
  if (!Array.isArray(file.exceptions)) fail('exceptions file must list exceptions in an array')
  const keys = new Set()
  file.exceptions.forEach((entry, index) => {
    const label = `exception ${index + 1}`
    if (!isPlainObject(entry)) fail(`${label} must be an object`)
    for (const key of Object.keys(entry)) if (!ENTRY_FIELDS.includes(key)) fail(`${label} has unknown field ${key}`)
    for (const key of ENTRY_FIELDS) if (!Object.hasOwn(entry, key)) fail(`${label} is missing ${key}`)
    for (const key of ['directory', 'id', 'package', 'vulnerable_range', 'severity', 'justification', 'fix_status', 'approved_by']) {
      if (!isText(entry[key])) fail(`${label}: ${key} must be non-empty text`)
    }
    if (isAbsolute(entry.directory) || entry.directory.split('/').some(part => part === '' || part === '.' || part === '..')) {
      fail(`${label}: directory must be a repository-relative path`)
    }
    if (!GHSA_ID.test(entry.id)) fail(`${label}: id must be a GHSA id`)
    if (!SEVERITIES.includes(entry.severity)) fail(`${label}: severity must be one of ${SEVERITIES.join(', ')}`)
    if (!gated(entry.severity)) fail(`${label}: severity ${entry.severity} is below ${AUDIT_LEVEL} and needs no exception`)
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) fail(`${label}: paths must list the installed paths`)
    for (const path of entry.paths) {
      if (!isText(path) || !path.startsWith('node_modules/') || /\s/.test(path) || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
        fail(`${label}: ${JSON.stringify(path)} is not an installed package path`)
      }
    }
    if (new Set(entry.paths).size !== entry.paths.length) fail(`${label}: paths repeat`)
    const approved = dayStart(entry.approved_at, 'approved_at', label)
    const expires = dayStart(entry.expires_at, 'expires_at', label)
    if (expires <= approved) fail(`${label}: expires_at must be after approved_at`)
    if (expires - approved > MAX_EXCEPTION_DAYS * DAY_MS) fail(`${label}: an exception may last at most ${MAX_EXCEPTION_DAYS} days`)
    if (approved > now.getTime()) fail(`${label}: approved_at ${entry.approved_at} is in the future`)
    const key = JSON.stringify([entry.directory, entry.id, entry.package])
    if (keys.has(key)) fail(`${label}: more than one exception for ${entry.id} ${entry.package} in ${entry.directory}`)
    keys.add(key)
  })
  if (text !== `${JSON.stringify(file, null, 2)}\n`) fail('exceptions file must be canonical JSON (2-space indent, one trailing newline, no duplicate keys)')
  return file
}

// Turns npm's result into a validated version 2 audit report, or throws.
export function parseAuditResult({ error, signal, status, stdout }) {
  if (error) fail(`npm audit could not run: ${error.code ?? error.message}`)
  if (signal) fail(`npm audit was stopped by ${signal}`)
  if (status !== 0 && status !== 1) fail(`npm audit exited with status ${status}`)
  let report
  try { report = JSON.parse(stdout) } catch { fail('npm audit did not print a JSON report') }
  if (!isPlainObject(report)) fail('npm audit did not print a JSON report')
  if (Object.hasOwn(report, 'error')) {
    const detail = isPlainObject(report.error) ? [report.error.code, report.error.summary].filter(isText).join(': ') : ''
    fail(`npm audit failed${detail ? `: ${detail}` : ''}`)
  }
  if (report.auditReportVersion !== 2) fail('npm audit report is not auditReportVersion 2')
  if (!isPlainObject(report.vulnerabilities)) fail('npm audit report has no vulnerabilities object')
  const counts = report.metadata?.vulnerabilities
  if (!isPlainObject(counts)) fail('npm audit report has no vulnerability counts')
  const seen = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]))
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!isPlainObject(vulnerability) || vulnerability.name !== name) fail(`npm audit entry ${name} is malformed`)
    if (!SEVERITIES.includes(vulnerability.severity)) fail(`npm audit entry ${name} has an unknown severity`)
    if (!Array.isArray(vulnerability.nodes) || vulnerability.nodes.length === 0 || !vulnerability.nodes.every(isText)) {
      fail(`npm audit entry ${name} has no installed paths`)
    }
    if (!Array.isArray(vulnerability.via) || vulnerability.via.length === 0) fail(`npm audit entry ${name} has no cause`)
    for (const via of vulnerability.via) {
      if (typeof via === 'string') {
        if (!Object.hasOwn(report.vulnerabilities, via)) fail(`npm audit entry ${name} depends on unreported ${via}`)
      } else if (!isPlainObject(via) || via.name !== name || !SEVERITIES.includes(via.severity) || !isText(via.range) || typeof via.url !== 'string') {
        fail(`npm audit entry ${name} has a malformed advisory`)
      }
    }
    seen[vulnerability.severity] += 1
  }
  for (const severity of SEVERITIES) if (counts[severity] !== seen[severity]) fail(`npm audit report counts do not match its ${severity} entries`)
  const total = Object.keys(report.vulnerabilities).length
  if (counts.total !== total) fail('npm audit report total does not match its entries')
  if (status === 1 && total === 0) fail('npm audit exited with status 1 without reporting a vulnerability')
  return report
}

// One finding per advisory per package; entries reached only through another
// package (`via` names) carry no advisory of their own.
export function advisories(report) {
  const found = []
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability.via) {
      if (typeof via === 'string') continue
      found.push({ id: ADVISORY_URL.exec(via.url)?.[1] ?? null, url: via.url, title: typeof via.title === 'string' ? via.title : '',
        package: via.name, range: via.range, severity: via.severity, paths: [...vulnerability.nodes] })
    }
  }
  return found
}

export function evaluateAudit({ report, exceptions, directory, now }) {
  const failures = [], covered = [], belowLevel = [], expired = new Set()
  for (const entry of exceptions.exceptions) {
    if (now.getTime() >= dayStart(entry.expires_at, 'expires_at', describe(entry))) {
      expired.add(entry)
      failures.push(`expired exception: ${describe(entry)} expired on ${entry.expires_at}; review it again or remove it`)
    }
  }
  const entries = exceptions.exceptions.filter(entry => entry.directory === directory)
  const matched = new Map(entries.map(entry => [entry, new Set()]))
  for (const finding of advisories(report)) {
    const label = `${finding.id ?? finding.url} ${finding.package} ${finding.range} (${finding.severity})`
    if (!gated(finding.severity)) { belowLevel.push(finding); continue }
    for (const path of finding.paths) {
      const entry = entries.find(candidate => candidate.id === finding.id && candidate.package === finding.package
        && candidate.vulnerable_range === finding.range && candidate.severity === finding.severity && candidate.paths.includes(path))
      if (!entry) { failures.push(`no reviewed exception: ${label} at ${path} in ${directory}`); continue }
      matched.get(entry).add(path)
      if (!expired.has(entry)) covered.push({ finding, path, entry })
    }
  }
  for (const [entry, paths] of matched) {
    for (const path of entry.paths) {
      if (!paths.has(path)) failures.push(`stale exception: ${describe(entry)} no longer matches npm audit at ${path}; correct or remove it`)
    }
  }
  return { ok: failures.length === 0, failures, covered, belowLevel }
}

export function auditDirectory(argument, cwd = process.cwd(), root = REPOSITORY_ROOT) {
  const absolute = resolve(cwd, argument)
  const key = relative(root, absolute).split(sep).join('/')
  if (key === '' || key === '..' || key.startsWith('../') || isAbsolute(key)) fail(`audit directory must be inside the repository: ${argument}`)
  return { absolute, key }
}

function parseArguments(argv) {
  const positional = []
  let exceptionsPath = DEFAULT_EXCEPTIONS_PATH
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--exceptions' && index + 1 < argv.length) exceptionsPath = argv[++index]
    else if (value.startsWith('--exceptions=')) exceptionsPath = value.slice('--exceptions='.length)
    else if (value.startsWith('-')) fail(`unknown option ${value}`)
    else positional.push(value)
  }
  if (positional.length !== 1 || !exceptionsPath) fail('usage: npm-audit-with-exceptions.mjs <directory> [--exceptions <file>]')
  return { directory: positional[0], exceptionsPath }
}

export function main(argv, { now = new Date(), cwd = process.cwd(), spawn = spawnSync, readText = path => readFileSync(path, 'utf8'),
  out = text => process.stdout.write(text), err = text => process.stderr.write(text) } = {}) {
  let directory = '(unknown)'
  try {
    const options = parseArguments(argv)
    const target = auditDirectory(options.directory, cwd)
    directory = target.key
    let exceptionsText
    try { exceptionsText = readText(resolve(cwd, options.exceptionsPath)) } catch { fail(`cannot read exceptions file ${options.exceptionsPath}`) }
    const exceptions = parseExceptions(exceptionsText, now)
    const report = parseAuditResult(spawn('npm', ['--prefix', target.absolute, 'audit', '--json'], { cwd, encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, timeout: 300_000, stdio: ['ignore', 'pipe', 'inherit'] }))
    const result = evaluateAudit({ report, exceptions, directory, now })
    for (const { finding, path, entry } of result.covered) {
      out(`covered: ${finding.id} ${finding.package} ${finding.range} (${finding.severity}) at ${path}; approved by ${entry.approved_by} on ${entry.approved_at}, expires ${entry.expires_at}\n`)
    }
    for (const finding of result.belowLevel) out(`below ${AUDIT_LEVEL}, not gated: ${finding.id ?? finding.url} ${finding.package} ${finding.range} (${finding.severity})\n`)
    if (!result.ok) {
      for (const failure of result.failures) err(`${failure}\n`)
      err(`npm audit gate failed for ${directory}\n`)
      return 1
    }
    out(`npm audit gate passed for ${directory}: ${result.covered.length} covered, ${result.belowLevel.length} below ${AUDIT_LEVEL}\n`)
    return 0
  } catch (error) {
    if (!(error instanceof AuditGateError)) throw error
    err(`${error.message}\nnpm audit gate failed for ${directory}\n`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`npm audit gate failed: ${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
