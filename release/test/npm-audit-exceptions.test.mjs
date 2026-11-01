import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuditGateError, REPOSITORY_ROOT, SEVERITIES, evaluateAudit, main, parseAuditResult,
  parseExceptions } from '../scripts/npm-audit-with-exceptions.mjs'
import { AWS_AUDIT_GATE } from '../scripts/verify-publication-workflow.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/npm-audit-with-exceptions.mjs', import.meta.url))
const reviewedText = await readFile(new URL('../../security/npm-audit-exceptions.json', import.meta.url), 'utf8')
const reviewed = JSON.parse(reviewedText)
const NOW = new Date('2026-11-15T12:00:00Z')
const MINIMATCH_PATH = 'node_modules/aws-cdk-lib/node_modules/minimatch'

// Shaped like `npm --prefix infra/aws audit --json` on the 2026-11-01 lockfile.
const minimatchAdvisory = (changes = {}) => ({ source: 1244012, name: 'minimatch', dependency: 'minimatch',
  title: 'minimatch has potential denial of service via globparts amplification', url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249',
  severity: 'moderate', cwe: ['CWE-405'], cvss: { score: 0, vectorString: null }, range: '<11.0.1', ...changes })
function report(vulnerabilities) {
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]))
  for (const vulnerability of Object.values(vulnerabilities)) counts[vulnerability.severity] += 1
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { ...counts, total: Object.keys(vulnerabilities).length },
    dependencies: { prod: 26, dev: 33, optional: 27, peer: 0, peerOptional: 0, total: 58 } } }
}
const cdk = () => ({ name: 'aws-cdk-lib', severity: 'moderate', isDirect: true, via: ['minimatch'], effects: [], range: '*', nodes: ['node_modules/aws-cdk-lib'], fixAvailable: false })
const minimatch = (advisory = minimatchAdvisory(), nodes = [MINIMATCH_PATH]) => ({ name: 'minimatch', severity: advisory.severity, isDirect: false,
  via: [advisory], effects: ['aws-cdk-lib'], range: advisory.range, nodes, fixAvailable: false })
const awsReport = () => report({ 'aws-cdk-lib': cdk(), minimatch: minimatch() })
const lowAdvisory = (severity = 'low') => ({ name: 'tiny-glob', severity, isDirect: false, via: [{ source: 1, name: 'tiny-glob', dependency: 'tiny-glob',
  title: 'Lower-severity advisory', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity, cwe: [], cvss: { score: 0, vectorString: null }, range: '<2.0.0' }],
  effects: [], range: '<2.0.0', nodes: ['node_modules/tiny-glob'], fixAvailable: true })
const withEntries = (...entries) => ({ ...reviewed, exceptions: entries })
const entry = (changes = {}) => ({ ...structuredClone(reviewed.exceptions[0]), ...changes })
function evaluate(auditReport, file = reviewed, now = NOW, directory = 'infra/aws') {
  const status = Object.keys(auditReport.vulnerabilities).length > 0 ? 1 : 0
  return evaluateAudit({ report: parseAuditResult({ status, stdout: JSON.stringify(auditReport) }),
    exceptions: parseExceptions(json(file), now), directory, now })
}
const failuresOf = result => result.failures.join('\n')
const json = value => `${JSON.stringify(value, null, 2)}\n`

test('the reviewed exception covers the real infra/aws minimatch advisory', () => {
  const result = evaluate(awsReport())
  assert.equal(result.ok, true, failuresOf(result))
  assert.deepEqual(result.covered.map(({ finding, path }) => [finding.id, finding.package, path]), [['GHSA-g3hv-75wg-m249', 'minimatch', MINIMATCH_PATH]])
  const [only] = reviewed.exceptions
  assert.equal(reviewed.exceptions.length, 1)
  assert.deepEqual({ directory: only.directory, id: only.id, package: only.package, vulnerable_range: only.vulnerable_range, severity: only.severity,
    paths: only.paths, approved_by: only.approved_by, approved_at: only.approved_at, expires_at: only.expires_at },
  { directory: 'infra/aws', id: 'GHSA-g3hv-75wg-m249', package: 'minimatch', vulnerable_range: '<11.0.1', severity: 'moderate',
    paths: [MINIMATCH_PATH], approved_by: 'D-Eminence (in chat, 2026-11-01)', approved_at: '2026-11-01', expires_at: '2026-12-01' })
  // The only audited directory using the gate is the only one exceptions may name.
  assert.ok(reviewed.exceptions.every(item => AWS_AUDIT_GATE.endsWith(` ${item.directory}`)))
})

test('advisories without a matching exception fail: new advisory, new path, changed range, raised severity, other directory', () => {
  const cases = {
    'new advisory': report({ 'aws-cdk-lib': cdk(), minimatch: minimatch(), other: { ...lowAdvisory('moderate'), name: 'other',
      via: [{ ...lowAdvisory('moderate').via[0], name: 'other', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff' }] } }),
    'new advisory for the same package': report({ 'aws-cdk-lib': cdk(), minimatch: { ...minimatch(), via: [minimatchAdvisory(),
      minimatchAdvisory({ source: 2, url: 'https://github.com/advisories/GHSA-2222-3333-4444' })] } }),
    'new installed path': report({ 'aws-cdk-lib': cdk(), minimatch: minimatch(minimatchAdvisory(), [MINIMATCH_PATH, 'node_modules/minimatch']) }),
    'changed range': report({ 'aws-cdk-lib': cdk(), minimatch: minimatch(minimatchAdvisory({ range: '<11.0.2' })) }),
    'raised severity': report({ 'aws-cdk-lib': { ...cdk(), severity: 'high' }, minimatch: minimatch(minimatchAdvisory({ severity: 'high' })) }),
    'advisory without a GHSA id': report({ 'aws-cdk-lib': cdk(), minimatch: minimatch(minimatchAdvisory({ url: 'https://example.invalid/advisory/1' })) }),
  }
  for (const [name, auditReport] of Object.entries(cases)) {
    const result = evaluate(auditReport)
    assert.equal(result.ok, false, name)
    assert.match(failuresOf(result), /no reviewed exception/, name)
  }
  const elsewhere = evaluate(awsReport(), reviewed, NOW, 'infra/cloudflare')
  assert.equal(elsewhere.ok, false)
  assert.match(failuresOf(elsewhere), /no reviewed exception: GHSA-g3hv-75wg-m249 minimatch <11\.0\.1 \(moderate\) at .* in infra\/cloudflare/)
})

test('an expired exception fails from 00:00 UTC on expires_at, whichever directory it names', () => {
  assert.equal(evaluate(awsReport(), reviewed, new Date('2026-11-30T23:59:59Z')).ok, true)
  for (const now of [new Date('2026-12-01T00:00:00Z'), new Date('2027-03-01T00:00:00Z')]) {
    const result = evaluate(awsReport(), reviewed, now)
    assert.equal(result.ok, false)
    assert.match(failuresOf(result), /expired exception: GHSA-g3hv-75wg-m249 minimatch .* expired on 2026-12-01/)
  }
  const other = entry({ directory: 'infra/cloudflare', id: 'GHSA-2222-3333-4444', approved_at: '2026-10-01', expires_at: '2026-11-10' })
  const result = evaluate(awsReport(), withEntries(entry(), other))
  assert.equal(result.ok, false)
  assert.match(failuresOf(result), /expired exception: GHSA-2222-3333-4444 .* in infra\/cloudflare/)
})

test('a stale exception fails rather than warns', () => {
  const cases = {
    'advisory fixed': [report({}), withEntries(entry())],
    'path no longer installed': [awsReport(), withEntries(entry({ paths: [MINIMATCH_PATH, 'node_modules/minimatch'] }))],
    'advisory range changed': [report({ 'aws-cdk-lib': cdk(), minimatch: minimatch(minimatchAdvisory({ range: '<11.0.2' })) }), withEntries(entry())],
  }
  for (const [name, [auditReport, file]] of Object.entries(cases)) {
    const result = evaluate(auditReport, file)
    assert.equal(result.ok, false, name)
    assert.match(failuresOf(result), /stale exception: GHSA-g3hv-75wg-m249 minimatch/, name)
  }
  // An unused exception for an unaudited directory is not stale here; it is
  // checked when that directory is audited.
  assert.equal(evaluate(awsReport(), withEntries(entry(), entry({ directory: 'infra/cloudflare' }))).ok, true)
})

test('advisories below moderate still pass without an exception, as with --audit-level=moderate', () => {
  for (const severity of ['info', 'low']) {
    const alone = evaluate(report({ 'tiny-glob': lowAdvisory(severity) }), withEntries())
    assert.equal(alone.ok, true, severity)
    assert.deepEqual(alone.belowLevel.map(finding => [finding.id, finding.severity]), [['GHSA-aaaa-bbbb-cccc', severity]])
    const mixed = evaluate(report({ 'aws-cdk-lib': cdk(), minimatch: minimatch(), 'tiny-glob': lowAdvisory(severity) }))
    assert.equal(mixed.ok, true, failuresOf(mixed))
    assert.equal(mixed.covered.length, 1)
  }
  assert.equal(evaluate(report({}), withEntries()).ok, true)
})

test('malformed exception files fail closed', () => {
  const bad = {
    'not JSON': '{"schema_version":',
    'not an object': '[]',
    'wrong schema': json({ ...reviewed, schema_version: 'hid.npm-audit-exceptions/v0' }),
    'unknown top-level field': json({ ...reviewed, ignore: ['GHSA-g3hv-75wg-m249'] }),
    'exceptions not a list': json({ ...reviewed, exceptions: {} }),
    'unknown entry field': json(withEntries({ ...entry(), reviewed_by: '' })),
    'missing approval': json(withEntries((({ approved_by, ...rest }) => rest)(entry()))),
    'empty approval': json(withEntries(entry({ approved_by: '' }))),
    'empty justification': json(withEntries(entry({ justification: ' ' }))),
    'not a GHSA id': json(withEntries(entry({ id: 'CVE-2026-0001' }))),
    'unknown severity': json(withEntries(entry({ severity: 'medium' }))),
    'needless low exception': json(withEntries(entry({ severity: 'low' }))),
    'no paths': json(withEntries(entry({ paths: [] }))),
    'wildcard path': json(withEntries(entry({ paths: ['*'] }))),
    'escaping path': json(withEntries(entry({ paths: ['node_modules/../minimatch'] }))),
    'repeated path': json(withEntries(entry({ paths: [MINIMATCH_PATH, MINIMATCH_PATH] }))),
    'escaping directory': json(withEntries(entry({ directory: '../infra/aws' }))),
    'absolute directory': json(withEntries(entry({ directory: '/infra/aws' }))),
    'impossible date': json(withEntries(entry({ expires_at: '2026-11-31' }))),
    'timestamp not date': json(withEntries(entry({ expires_at: '2026-12-01T00:00:00Z' }))),
    'expires before approval': json(withEntries(entry({ expires_at: '2026-10-31' }))),
    'longer than the limit': json(withEntries(entry({ expires_at: '2027-02-02' }))),
    'approved in the future': json(withEntries(entry({ approved_at: '2026-11-20', expires_at: '2026-12-20' }))),
    'duplicate exception': json(withEntries(entry(), entry({ paths: ['node_modules/minimatch'] }))),
    'duplicate key': json(reviewed).replace('"expires_at": "2026-12-01"', '"expires_at": "2026-11-20",\n      "expires_at": "2026-12-01"'),
    'not canonical': json(reviewed).replace('\n  "exceptions"', '\n  "exceptions" '),
    'no trailing newline': json(reviewed).trimEnd(),
  }
  for (const [name, text] of Object.entries(bad)) assert.throws(() => parseExceptions(text, NOW), AuditGateError, name)
  assert.doesNotThrow(() => parseExceptions(json(withEntries(entry({ expires_at: '2027-02-01' }))), NOW))
  assert.doesNotThrow(() => parseExceptions(reviewedText, NOW))
})

test('npm errors and anything but a version 2 audit report fail closed', () => {
  const good = JSON.stringify(awsReport())
  const broken = (edit) => { const value = awsReport(); edit(value); return JSON.stringify(value) }
  const cases = {
    'npm missing': { error: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }), status: null, stdout: '' },
    'timed out': { error: Object.assign(new Error('spawnSync npm ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null, stdout: '' },
    'killed': { signal: 'SIGKILL', status: null, stdout: '' },
    'unexpected status': { status: 2, stdout: good },
    'empty output': { status: 1, stdout: '' },
    'not JSON': { status: 1, stdout: 'npm ERR! code ECONNRESET' },
    'truncated JSON': { status: 1, stdout: good.slice(0, 200) },
    'npm error report': { status: 1, stdout: JSON.stringify({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }) },
    'empty object': { status: 0, stdout: '{}' },
    'old report version': { status: 1, stdout: broken(value => { value.auditReportVersion = 1 }) },
    'no counts': { status: 1, stdout: broken(value => { delete value.metadata }) },
    'counts disagree': { status: 1, stdout: broken(value => { value.metadata.vulnerabilities.moderate = 1 }) },
    'total disagrees': { status: 1, stdout: broken(value => { value.metadata.vulnerabilities.total = 1 }) },
    'unknown severity': { status: 1, stdout: broken(value => { value.vulnerabilities.minimatch.severity = 'severe' }) },
    'advisory for another package': { status: 1, stdout: broken(value => { value.vulnerabilities.minimatch.via[0].name = 'other' }) },
    'advisory without range': { status: 1, stdout: broken(value => { delete value.vulnerabilities.minimatch.via[0].range }) },
    'unreported cause': { status: 1, stdout: broken(value => { value.vulnerabilities['aws-cdk-lib'].via = ['missing'] }) },
    'no installed paths': { status: 1, stdout: broken(value => { value.vulnerabilities.minimatch.nodes = [] }) },
    'failure without findings': { status: 1, stdout: JSON.stringify(report({})) },
  }
  for (const [name, result] of Object.entries(cases)) assert.throws(() => parseAuditResult(result), AuditGateError, name)
  assert.equal(parseAuditResult({ status: 1, stdout: good }).auditReportVersion, 2)
  assert.equal(parseAuditResult({ status: 0, stdout: JSON.stringify(report({})) }).auditReportVersion, 2)
})

test('main audits the named directory with npm audit --json and fails closed', () => {
  const run = (argv, spawnResult, file = reviewedText, now = NOW) => {
    const calls = [], out = [], err = []
    const code = main(argv, { now, cwd: REPOSITORY_ROOT, readText: () => file, out: text => out.push(text), err: text => err.push(text),
      spawn: (command, args) => { calls.push([command, ...args]); return spawnResult } })
    return { code, calls, out: out.join(''), err: err.join('') }
  }
  const passed = run(['infra/aws'], { status: 1, stdout: JSON.stringify(awsReport()) })
  assert.equal(passed.code, 0, passed.err)
  assert.deepEqual(passed.calls, [['npm', '--prefix', resolve(REPOSITORY_ROOT, 'infra/aws'), 'audit', '--json']])
  assert.match(passed.out, /covered: GHSA-g3hv-75wg-m249 minimatch <11\.0\.1 \(moderate\) at node_modules\/aws-cdk-lib\/node_modules\/minimatch; approved by D-Eminence/)
  assert.match(passed.out, /npm audit gate passed for infra\/aws/)
  const expired = run(['infra/aws'], { status: 1, stdout: JSON.stringify(awsReport()) }, reviewedText, new Date('2026-12-01T00:00:00Z'))
  assert.equal(expired.code, 1)
  assert.match(expired.err, /expired exception/)
  const npmFailed = run(['infra/aws'], { status: 1, stdout: '{"error":{"code":"E503","summary":"registry unavailable"}}' })
  assert.equal(npmFailed.code, 1)
  assert.match(npmFailed.err, /npm audit failed: E503: registry unavailable\nnpm audit gate failed for infra\/aws/)
  for (const argv of [[], ['infra/aws', 'release'], ['infra/aws', '--audit-level=none'], ['infra/aws', '--exceptions'], ['..'], ['/']]) {
    const refused = run(argv, { status: 0, stdout: JSON.stringify(report({})) })
    assert.equal(refused.code, 1, JSON.stringify(argv))
    assert.deepEqual(refused.calls, [], JSON.stringify(argv))
  }
  const unreadable = main(['infra/aws'], { now: NOW, cwd: REPOSITORY_ROOT, readText: () => { throw new Error('ENOENT') }, out: () => {}, err: () => {},
    spawn: () => { throw new Error('npm must not run without a readable exception file') } })
  assert.equal(unreadable, 1)
})

test('the CLI fails closed on real npm process failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-npm-audit-gate-'))
  try {
    const bin = join(directory, 'bin'), empty = join(directory, 'empty')
    await Promise.all([bin, empty].map(path => import('node:fs/promises').then(({ mkdir }) => mkdir(path))))
    await writeFile(join(bin, 'npm'), `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_NPM_ARGS"
case "$FAKE_NPM_MODE" in
  report) cat "$FAKE_NPM_REPORT"; exit 1 ;;
  status) cat "$FAKE_NPM_REPORT"; exit 3 ;;
  error) echo '{"error":{"code":"ENOLOCK","summary":"This command requires an existing lockfile."}}'; exit 1 ;;
  text) echo 'npm error network request failed'; exit 1 ;;
  killed) kill -9 $$ ;;
esac
exit 1
`)
    await chmod(join(bin, 'npm'), 0o755)
    const today = new Date(), day = 86_400_000
    const date = time => new Date(time).toISOString().slice(0, 10)
    const exceptionsPath = join(directory, 'exceptions.json')
    await writeFile(exceptionsPath, json(withEntries(entry({ approved_at: date(today.getTime() - day), expires_at: date(today.getTime() + 10 * day) }))))
    await writeFile(join(directory, 'report.json'), JSON.stringify(awsReport()))
    const cli = (mode, path = `${bin}:/usr/bin:/bin`) => spawnSync(process.execPath, [SCRIPT, 'infra/aws', '--exceptions', exceptionsPath], {
      cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 20000,
      env: { PATH: path, FAKE_NPM_MODE: mode, FAKE_NPM_REPORT: join(directory, 'report.json'), FAKE_NPM_ARGS: join(directory, `args-${mode}`) } })
    const passed = cli('report')
    assert.equal(passed.status, 0, passed.stderr)
    assert.match(passed.stdout, /npm audit gate passed for infra\/aws: 1 covered/)
    assert.equal(await readFile(join(directory, 'args-report'), 'utf8'), `--prefix\n${resolve(REPOSITORY_ROOT, 'infra/aws')}\naudit\n--json\n`)
    for (const [mode, message] of [['status', /exited with status 3/], ['error', /npm audit failed: ENOLOCK/], ['text', /did not print a JSON report/],
      ['killed', /stopped by SIGKILL/]]) {
      const result = cli(mode)
      assert.equal(result.status, 1, mode)
      assert.match(result.stderr, message, mode)
      assert.match(result.stderr, /npm audit gate failed for infra\/aws/, mode)
    }
    const missing = cli('report', empty)
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /npm audit could not run: ENOENT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
