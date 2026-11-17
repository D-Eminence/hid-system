import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuditGateError, REPOSITORY_ROOT, SEVERITIES, evaluateAudit, main, parseAuditResult,
  parseExceptions, parseRange, satisfies } from '../scripts/npm-audit-with-exceptions.mjs'
import { EXCEPTION_GATE_DIRECTORIES } from '../scripts/verify-publication-workflow.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/npm-audit-with-exceptions.mjs', import.meta.url))
const reviewedText = await readFile(new URL('../../security/npm-audit-exceptions.json', import.meta.url), 'utf8')
const reviewed = JSON.parse(reviewedText)
const NOW = new Date('2026-11-17T12:00:00Z')
const MINIMATCH_PATH = 'node_modules/aws-cdk-lib/node_modules/minimatch'

// Shaped like `npm --prefix infra/aws audit --json` on the 2026-11-01 lockfile.
const minimatchAdvisory = (changes = {}) => ({ source: 1244012, name: 'minimatch', dependency: 'minimatch',
  title: 'minimatch has potential denial of service via globparts amplification', url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249',
  severity: 'moderate', cwe: ['CWE-405'], cvss: { score: 0, vectorString: null }, range: '>=7.0.0 <11.0.1', ...changes })
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
const entry = (changes = {}) => ({ ...structuredClone(reviewed.exceptions.find(item => item.id === 'GHSA-g3hv-75wg-m249')), ...changes })
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
  const only = reviewed.exceptions.find(item => item.directory === 'infra/aws')
  assert.equal(reviewed.exceptions.length, 2)
  assert.deepEqual({ directory: only.directory, id: only.id, package: only.package, vulnerable_range: only.vulnerable_range, severity: only.severity,
    paths: only.paths, approved_by: only.approved_by, approved_at: only.approved_at, expires_at: only.expires_at },
  { directory: 'infra/aws', id: 'GHSA-g3hv-75wg-m249', package: 'minimatch', vulnerable_range: '>=7.0.0 <11.0.1', severity: 'moderate',
    paths: [MINIMATCH_PATH], approved_by: 'D-Eminence (in chat, 2026-11-01; re-approved for the reworded range in chat, 2026-11-04: "Q32 yes")', approved_at: '2026-11-04', expires_at: '2026-12-01' })
  // Exceptions may name only the directories audited through the gate.
  assert.ok(reviewed.exceptions.every(item => EXCEPTION_GATE_DIRECTORIES.includes(item.directory)))
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
  assert.match(failuresOf(elsewhere), /no reviewed exception: GHSA-g3hv-75wg-m249 minimatch >=7\.0\.0 <11\.0\.1 \(moderate\) at .* in infra\/cloudflare/)
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
    'longer than the limit': json(withEntries(entry({ expires_at: '2027-02-05' }))),
    'approved in the future': json(withEntries(entry({ approved_at: '2026-11-20', expires_at: '2026-12-20' }))),
    'duplicate exception': json(withEntries(entry(), entry({ paths: ['node_modules/minimatch'] }))),
    'duplicate key': json(reviewed).replace('"expires_at": "2026-12-01"', '"expires_at": "2026-11-20",\n      "expires_at": "2026-12-01"'),
    'not canonical': json(reviewed).replace('\n  "exceptions"', '\n  "exceptions" '),
    'no trailing newline': json(reviewed).trimEnd(),
  }
  for (const [name, text] of Object.entries(bad)) assert.throws(() => parseExceptions(text, NOW), AuditGateError, name)
  assert.doesNotThrow(() => parseExceptions(json(withEntries(entry({ expires_at: '2027-02-04' }))), NOW))
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
  assert.match(passed.out, /covered: GHSA-g3hv-75wg-m249 minimatch >=7\.0\.0 <11\.0\.1 \(moderate\) at node_modules\/aws-cdk-lib\/node_modules\/minimatch; approved by D-Eminence/)
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

test('the CLI still runs the gate when reached through a symlink, so it cannot pass silently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-npm-audit-gate-link-'))
  try {
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'npm'), '#!/bin/sh\ncat "$FAKE_NPM_REPORT"\nexit 1\n')
    await chmod(join(bin, 'npm'), 0o755)
    const today = new Date(), day = 86_400_000
    const date = time => new Date(time).toISOString().slice(0, 10)
    const exceptionsPath = join(directory, 'exceptions.json')
    await writeFile(exceptionsPath, json(withEntries(entry({ approved_at: date(today.getTime() - day), expires_at: date(today.getTime() + 10 * day) }))))
    const critical = { ...lowAdvisory('critical'), name: 'evil-glob', via: [{ ...lowAdvisory('critical').via[0], name: 'evil-glob', dependency: 'evil-glob',
      url: 'https://github.com/advisories/GHSA-9999-8888-7777' }], nodes: ['node_modules/evil-glob'] }
    await writeFile(join(directory, 'covered.json'), JSON.stringify(awsReport()))
    await writeFile(join(directory, 'uncovered.json'), JSON.stringify(report({ 'aws-cdk-lib': cdk(), minimatch: minimatch(), 'evil-glob': critical })))
    await symlink(REPOSITORY_ROOT, join(directory, 'checkout'), 'dir')
    await symlink(SCRIPT, join(directory, 'gate.mjs'), 'file')
    const linked = { 'symlinked checkout': join(directory, 'checkout', 'release', 'scripts', 'npm-audit-with-exceptions.mjs'),
      'symlinked script': join(directory, 'gate.mjs') }
    for (const [name, script] of Object.entries(linked)) {
      const cli = auditReport => spawnSync(process.execPath, [script, 'infra/aws', '--exceptions', exceptionsPath], { cwd: REPOSITORY_ROOT, encoding: 'utf8',
        timeout: 20000, env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_NPM_REPORT: join(directory, auditReport) } })
      const refused = cli('uncovered.json')
      assert.equal(refused.status, 1, `${name}: ${refused.stdout}${refused.stderr}`)
      assert.match(refused.stderr, /no reviewed exception: GHSA-9999-8888-7777 evil-glob <2\.0\.0 \(critical\) at node_modules\/evil-glob in infra\/aws/, name)
      assert.match(refused.stderr, /npm audit gate failed for infra\/aws/, name)
      const passed = cli('covered.json')
      assert.equal(passed.status, 0, `${name}: ${passed.stderr}`)
      assert.match(passed.stdout, /npm audit gate passed for infra\/aws: 1 covered/, name)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

// --- apps/ehr: picomatch (GHSA-fc5q-39xc-vjpf), build tooling under vite ------

const PICOMATCH_DEPENDENTS = ['node_modules/@vitejs/plugin-react', 'node_modules/fdir', 'node_modules/tinyglobby', 'node_modules/vite']
// Shaped like `npm --prefix apps/ehr audit --json` on 2026-11-17 (staging-novu-ci-20261005 73eae090).
const picomatchAdvisory = (changes = {}) => ({ source: 1247710, name: 'picomatch', dependency: 'picomatch',
  title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs', url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  severity: 'high', cwe: ['CWE-1333'], cvss: { score: 0, vectorString: null }, range: '<=4.0.7', ...changes })
const through = (name, via, nodes = [`node_modules/${name}`]) => ({ name, severity: 'high', isDirect: false, via, effects: [], range: '*', nodes, fixAvailable: false })
const ehrVulnerabilities = (advisory = picomatchAdvisory()) => ({
  '@vitejs/plugin-react': { ...through('@vitejs/plugin-react', ['vite']), isDirect: true },
  fdir: through('fdir', ['picomatch']),
  picomatch: { name: 'picomatch', severity: advisory.severity, isDirect: false, via: [advisory], effects: ['fdir', 'tinyglobby', 'vite'],
    range: advisory.range, nodes: ['node_modules/picomatch'], fixAvailable: false },
  tinyglobby: through('tinyglobby', ['fdir', 'picomatch']),
  vite: { ...through('vite', ['picomatch', 'tinyglobby']), isDirect: true },
})
const ehrReport = (vulnerabilities = ehrVulnerabilities()) => report(vulnerabilities)
const ehrLockfile = { lockfileVersion: 3, packages: { '': { name: '@hid/ehr' }, 'node_modules/picomatch': { version: '4.0.7', dev: true } } }
const picomatchEntry = (changes = {}) => ({ ...structuredClone(reviewed.exceptions.find(item => item.id === 'GHSA-fc5q-39xc-vjpf')), ...changes })
const REGISTRY = ['2.3.1', '3.0.1', '4.0.6', '4.0.7']
function evaluateEhr(auditReport = ehrReport(), { file = reviewed, now = NOW, lockfile = ehrLockfile, versions = REGISTRY } = {}) {
  const status = Object.keys(auditReport.vulnerabilities).length > 0 ? 1 : 0
  return evaluateAudit({ report: parseAuditResult({ status, stdout: JSON.stringify(auditReport) }), exceptions: parseExceptions(json(file), now),
    directory: 'apps/ehr', now, lockfile,
    publishedVersions: versions === null ? undefined : () => { if (versions instanceof Error) throw versions; return versions } })
}

test('the reviewed exception covers the real apps/ehr picomatch advisory while no fix is published', () => {
  const result = evaluateEhr()
  assert.equal(result.ok, true, failuresOf(result))
  assert.deepEqual(result.covered.map(({ finding, path }) => [finding.id, finding.package, path]), [['GHSA-fc5q-39xc-vjpf', 'picomatch', 'node_modules/picomatch']])
  assert.match(result.notes.join('\n'), /no fixed version published: no release of picomatch outside <=4\.0\.7 is newer than the installed 4\.0\.7/)
  const only = picomatchEntry()
  assert.deepEqual({ directory: only.directory, package: only.package, vulnerable_range: only.vulnerable_range, severity: only.severity, paths: only.paths,
    dependent_paths: only.dependent_paths, ends_when_fix_published: only.ends_when_fix_published, approved_by: only.approved_by,
    approved_at: only.approved_at, expires_at: only.expires_at },
  { directory: 'apps/ehr', package: 'picomatch', vulnerable_range: '<=4.0.7', severity: 'high', paths: ['node_modules/picomatch'],
    dependent_paths: PICOMATCH_DEPENDENTS, ends_when_fix_published: true, approved_by: 'D-Eminence (owner), in chat 17 Nov 2026: "Q95 A"',
    approved_at: '2026-11-17', expires_at: '2026-12-01' })
})

test('the same picomatch advisory fails without the exception, in another directory, or once expired', () => {
  const without = evaluateEhr(ehrReport(), { file: withEntries(entry()) })
  assert.equal(without.ok, false)
  assert.match(failuresOf(without), /no reviewed exception: GHSA-fc5q-39xc-vjpf picomatch <=4\.0\.7 \(high\) at node_modules\/picomatch in apps\/ehr/)
  const elsewhere = evaluateAudit({ report: ehrReport(), exceptions: reviewed, directory: 'packages/ui', now: NOW })
  assert.match(failuresOf(elsewhere), /no reviewed exception: GHSA-fc5q-39xc-vjpf .* in packages\/ui/)
  assert.equal(evaluateEhr(ehrReport(), { now: new Date('2026-11-30T23:59:59Z') }).ok, true)
  const expired = evaluateEhr(ehrReport(), { now: new Date('2026-12-01T00:00:00Z') })
  assert.equal(expired.ok, false)
  assert.match(failuresOf(expired), /expired exception: GHSA-fc5q-39xc-vjpf picomatch .* expired on 2026-12-01/)
})

test('the picomatch exception ends when a fixed version is published, and fails closed when it cannot tell', () => {
  const fixed = evaluateEhr(ehrReport(), { versions: [...REGISTRY, '4.0.8'] })
  assert.equal(fixed.ok, false)
  assert.match(failuresOf(fixed), /fixed version published: picomatch 4\.0\.8 is outside <=4\.0\.7, .* upgrade from 4\.0\.7 and remove the exception/)
  assert.match(failuresOf(evaluateEhr(ehrReport(), { versions: [...REGISTRY, '5.0.0'] })), /picomatch 5\.0\.0 is outside/)
  // A prerelease, or an older line outside the range, is not a fix.
  assert.equal(evaluateEhr(ehrReport(), { versions: [...REGISTRY, '4.0.8-beta.1', '5.0.0-rc.0'] }).ok, true)
  const cases = {
    'registry unreachable': [{ versions: new Error('npm view picomatch failed') }, /npm view picomatch failed/],
    'registry lists nothing': [{ versions: [] }, /listed no versions/],
    'no registry lookup': [{ versions: null }, /no registry lookup was given/],
    'no lockfile': [{ lockfile: null }, /package-lock\.json has no packages map/],
    'lockfile without the version': [{ lockfile: { packages: {} } }, /package-lock\.json has no version for node_modules\/picomatch/],
  }
  for (const [name, [options, message]] of Object.entries(cases)) {
    const result = evaluateEhr(ehrReport(), options)
    assert.equal(result.ok, false, name)
    assert.match(failuresOf(result), /cannot check for a fixed version of picomatch/, name)
    assert.match(failuresOf(result), message, name)
  }
})

test('the picomatch exception fails when the advisory spreads, moves or changes, and when a listed dependent is gone', () => {
  const spread = ehrVulnerabilities()
  spread['runtime-lib'] = through('runtime-lib', ['tinyglobby'])
  const spreadResult = evaluateEhr(ehrReport(spread))
  assert.equal(spreadResult.ok, false)
  assert.match(failuresOf(spreadResult), /advisory has spread: GHSA-fc5q-39xc-vjpf picomatch .* now reaches node_modules\/runtime-lib, which dependent_paths does not list/)
  const nested = ehrVulnerabilities()
  nested.vite.nodes = ['node_modules/vite', 'node_modules/vitest/node_modules/vite']
  assert.match(failuresOf(evaluateEhr(ehrReport(nested))), /now reaches node_modules\/vitest\/node_modules\/vite/)
  const moved = ehrVulnerabilities()
  moved.picomatch.nodes = ['node_modules/picomatch', 'node_modules/micromatch/node_modules/picomatch']
  assert.match(failuresOf(evaluateEhr(ehrReport(moved))), /no reviewed exception: GHSA-fc5q-39xc-vjpf .* at node_modules\/micromatch\/node_modules\/picomatch/)
  const changed = evaluateEhr(ehrReport(ehrVulnerabilities(picomatchAdvisory({ range: '<4.0.8' }))))
  assert.match(failuresOf(changed), /no reviewed exception: GHSA-fc5q-39xc-vjpf picomatch <4\.0\.8/)
  assert.match(failuresOf(changed), /stale exception: GHSA-fc5q-39xc-vjpf picomatch/)
  const fewer = ehrVulnerabilities()
  delete fewer['@vitejs/plugin-react']
  const fewerResult = evaluateEhr(ehrReport(fewer))
  assert.equal(fewerResult.ok, false)
  assert.match(failuresOf(fewerResult), /stale exception: .* no longer reaches node_modules\/@vitejs\/plugin-react in dependent_paths/)
  const gone = evaluateEhr(report({}))
  assert.equal(gone.ok, false)
  assert.match(failuresOf(gone), /stale exception: GHSA-fc5q-39xc-vjpf picomatch .* no longer matches npm audit at node_modules\/picomatch/)
})

test('malformed optional fields fail closed', () => {
  const bad = {
    'fix check switched off': picomatchEntry({ ends_when_fix_published: false }),
    'fix check as text': picomatchEntry({ ends_when_fix_published: 'true' }),
    'fix check on an unreadable range': picomatchEntry({ vulnerable_range: 'latest' }),
    'fix check on a non-package': picomatchEntry({ package: 'Pico Match' }),
    'no dependent paths': picomatchEntry({ dependent_paths: [] }),
    'wildcard dependent path': picomatchEntry({ dependent_paths: ['node_modules/*', 'node_modules/ vite'] }),
    'escaping dependent path': picomatchEntry({ dependent_paths: ['node_modules/../vite'] }),
    'repeated dependent path': picomatchEntry({ dependent_paths: ['node_modules/vite', 'node_modules/vite'] }),
    'dependent path is the package': picomatchEntry({ dependent_paths: ['node_modules/picomatch', 'node_modules/vite'] }),
  }
  for (const [name, item] of Object.entries(bad)) assert.throws(() => parseExceptions(json(withEntries(entry(), item)), NOW), AuditGateError, name)
  assert.doesNotThrow(() => parseExceptions(json(withEntries(entry(), picomatchEntry())), NOW))
})

test('main audits apps/ehr, then asks the registry for picomatch versions', () => {
  const lockText = JSON.stringify(ehrLockfile)
  const run = (viewResult, { lock = lockText, now = NOW } = {}) => {
    const calls = [], out = [], err = []
    const code = main(['apps/ehr'], { now, cwd: REPOSITORY_ROOT, out: text => out.push(text), err: text => err.push(text),
      readText: path => {
        if (path === resolve(REPOSITORY_ROOT, 'apps/ehr/package-lock.json')) { if (lock === null) throw new Error('ENOENT'); return lock }
        return reviewedText
      },
      spawn: (command, args) => {
        calls.push([command, ...args])
        return args.includes('audit') ? { status: 1, stdout: JSON.stringify(ehrReport()) } : viewResult
      } })
    return { code, calls, out: out.join(''), err: err.join('') }
  }
  const passed = run({ status: 0, stdout: JSON.stringify(REGISTRY) })
  assert.equal(passed.code, 0, passed.err)
  const prefix = resolve(REPOSITORY_ROOT, 'apps/ehr')
  assert.deepEqual(passed.calls, [['npm', '--prefix', prefix, 'audit', '--json'], ['npm', '--prefix', prefix, 'view', 'picomatch', 'versions', '--json']])
  assert.match(passed.out, /covered: GHSA-fc5q-39xc-vjpf picomatch <=4\.0\.7 \(high\) at node_modules\/picomatch; approved by D-Eminence \(owner\)/)
  assert.match(passed.out, /no fixed version published/)
  assert.match(passed.out, /npm audit gate passed for apps\/ehr: 1 covered/)
  for (const [name, viewResult, options, message] of [
    ['fix published', { status: 0, stdout: JSON.stringify([...REGISTRY, '4.0.8']) }, {}, /fixed version published: picomatch 4\.0\.8/],
    ['view failed', { status: 1, stdout: '' }, {}, /cannot check for a fixed version of picomatch .*npm view picomatch failed/],
    ['view not JSON', { status: 0, stdout: 'oops' }, {}, /did not print JSON/],
    ['view missing', { error: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }), status: null, stdout: '' }, {}, /npm view could not run: ENOENT/],
    ['lockfile unreadable', { status: 0, stdout: JSON.stringify(REGISTRY) }, { lock: null }, /package-lock\.json has no packages map/],
  ]) {
    const result = run(viewResult, options)
    assert.equal(result.code, 1, name)
    assert.match(result.err, message, name)
    assert.match(result.err, /npm audit gate failed for apps\/ehr/, name)
  }
  // A single published version comes back as a JSON string.
  assert.equal(run({ status: 0, stdout: JSON.stringify('4.0.7') }).code, 0)
})

test('ranges', () => {
  assert.ok(satisfies('4.0.7', '<=4.0.7'))
  assert.ok(!satisfies('4.0.8', '<=4.0.7'))
  assert.ok(satisfies('9.0.0', '>=7.0.0 <11.0.1'))
  assert.ok(!satisfies('11.0.1', '>=7.0.0 <11.0.1'))
  assert.ok(satisfies('2.0.5', '<1.0.0 || >=2.0.0 <2.1.0'))
  assert.ok(satisfies('1.2.3', '*'))
  assert.ok(satisfies('4.0.8-beta.1', '<4.0.8'))
  assert.equal(parseRange('1.0.0 - 2.0.0'), null)
  assert.equal(parseRange('latest'), null)
})
