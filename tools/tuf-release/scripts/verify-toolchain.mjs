import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(root, 'toolchain', 'verified-upstream-build.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const options = parseArguments(process.argv.slice(2))

verifyManifest()

const pinnedGoInstalled = await isReadable(manifest.go.binary_path)
const goBinary = pinnedGoInstalled ? manifest.go.binary_path : (process.env.HID_TUF_GO || 'go')
await verifyGoRuntime(goBinary, options.requireInstalled)
await verifyProjectModules(goBinary)
await verifyDownloadedUpstreamModule(goBinary)

if (options.requireInstalled) {
  await verifyReferenceClient(manifest.reference_client.binary_path)
}
if (options.sourceDir !== undefined) {
  await verifySourceCheckout(options.sourceDir, goBinary)
}
if (options.goDistribution !== undefined) {
  await verifyGoDistribution(options.goDistribution)
}
if (options.buildA !== undefined) {
  assert.notEqual(await realpath(options.buildA), await realpath(options.buildB),
    'build A and build B resolve to the same artifact')
  await verifyReferenceClient(options.buildA)
  await verifyReferenceClient(options.buildB)
}

const checks = ['manifest', 'project modules', 'upstream module origin/content', 'Go runtime']
if (options.requireInstalled) checks.push('installed reference client')
if (options.sourceDir !== undefined) checks.push('clean upstream Git source/tree')
if (options.goDistribution !== undefined) checks.push('Go distribution archive')
if (options.buildA !== undefined) checks.push('build A/build B artifacts')
process.stdout.write(`Pinned TUF toolchain evidence verified (${checks.join(', ')}); no production key material is represented.\n`)

function verifyManifest () {
  assert.equal(manifest.schema_version, '1.0.0')
  assert.match(manifest.verified_at, /^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/)
  assert.equal(manifest.project,
    'github.com/theupdateframework/go-tuf/v2/examples/cli/tuf-client')
  assert.equal(manifest.go_tuf.module, 'github.com/theupdateframework/go-tuf/v2')
  assert.equal(manifest.go_tuf.version, 'v2.4.2')
  assert.equal(manifest.go_tuf.commit, 'f5edbde31e5507f46db2069402dc38903fe6d9d4')
  assert.equal(manifest.go_tuf.source_tree_sha256,
    '6ceb2d9979e910310c37243d27040c310c279748c57142301f980b29c2b25ebd')
  assert.equal(manifest.go_tuf.source_tree_hash_algorithm,
    'sha256 of the exact git ls-tree -r HEAD stdout bytes')
  assert.equal(manifest.go_tuf.go_mod_sha256,
    'd0e895542701e1bb30a3a4bbcbaddc889777968ee8d4b49bd971152d04c9e947')
  assert.equal(manifest.go_tuf.go_sum_sha256,
    '153125c407a41dfbab9b1b27b1b3c854475103c5077f3a0fa06f847f73b4f436')
  assert.equal(manifest.go_tuf.module_sum,
    'h1:w7976/W8uTwlsegP5nRymlpjPgrwSh+AXUf85is6nJk=')
  assert.equal(manifest.go_tuf.go_mod_sum,
    'h1:JqBrIUnNLAaNq/8GmBcEMFWfAFBbqp/MkJEJseXKbks=')

  assert.equal(manifest.go.version, 'go1.25.0')
  assert.equal(manifest.go.platform, 'linux/amd64')
  assert.equal(manifest.go.distribution_filename, 'go1.25.0.linux-amd64.tar.gz')
  assert.equal(manifest.go.distribution_sha256,
    '2852af0cb20a13139b3448992e69b868e50ed0f8a1e5940ee1de9e19a123b613')
  assert.equal(manifest.go.distribution_size_bytes, 59659213)
  assert.equal(manifest.go.binary_path, '/opt/hid-release-tools/go/1.25.0/bin/go')
  assert.equal(manifest.go.binary_sha256,
    'b93cdfdbc72f1afc3f21498c80bf3d155a44a9b95e2d690c940511051574bc25')

  assert.equal(manifest.reference_client.main_package, manifest.project)
  assert.equal(manifest.reference_client.binary_path,
    '/opt/hid-release-tools/tuf-client/2.4.2/tuf-client')
  assert.equal(manifest.reference_client.binary_sha256,
    '6933984fa57625a361896db52b9eb8fdd9658f98327b7bd44d806096114fb351')
  assert.equal(manifest.reference_client.size_bytes, 12857047)
  assert.equal(manifest.reference_client.build_a_sha256,
    manifest.reference_client.binary_sha256)
  assert.equal(manifest.reference_client.build_b_sha256,
    manifest.reference_client.binary_sha256)
  assert.equal(manifest.reference_client.installed_artifact_sha256,
    manifest.reference_client.binary_sha256)
  assert.equal(manifest.reference_client.installed_artifact_size_bytes,
    manifest.reference_client.size_bytes)
  assert.equal(manifest.reference_client.reproducibility_result,
    'build-a and build-b were byte-identical')
  assert.deepEqual(manifest.reference_client.build_command, [
    'go', 'build', '-mod=readonly', '-trimpath', '-buildvcs=false',
    '-ldflags=-buildid=', './examples/cli/tuf-client',
  ])
  assert.deepEqual(manifest.reference_client.build_environment, {
    GOENV: 'off', GOTOOLCHAIN: 'local', GOOS: 'linux', GOARCH: 'amd64', GOAMD64: 'v1',
    CGO_ENABLED: '0', GOPROXY: 'off', SOURCE_DATE_EPOCH: '0', TZ: 'UTC', LC_ALL: 'C', LANG: 'C',
  })

  assert.equal(manifest.policy.production_updater, false)
  assert.equal(manifest.policy.allowed_use,
    'local and staging interoperability/attack-test oracle')
  assert.equal(manifest.policy.private_keys_present, false)
  assert.equal(manifest.policy.module_verification, 'all modules verified')
}

async function verifyGoRuntime (goBinary, requirePinnedBinary) {
  if (isAbsolute(goBinary)) {
    assert(!(await lstat(goBinary)).isSymbolicLink(), `Go binary is a symlink: ${goBinary}`)
    const details = await stat(goBinary)
    assert(details.isFile(), `Go path is not a regular file: ${goBinary}`)
    assert.notEqual(details.mode & 0o111, 0, `Go binary is not executable: ${goBinary}`)
  }
  if (requirePinnedBinary) {
    assert.equal(resolve(goBinary), resolve(manifest.go.binary_path))
    assert.equal(await sha256File(goBinary), manifest.go.binary_sha256)
  }
  const { stdout: versionOutput } = await run(goBinary, ['version'])
  assert.equal(versionOutput.trim(), `go version ${manifest.go.version} ${manifest.go.platform}`)
  const { stdout: environmentOutput } = await run(goBinary,
    ['env', 'GOVERSION', 'GOOS', 'GOARCH'], { cwd: root })
  assert.deepEqual(environmentOutput.trim().split('\n'), ['go1.25.0', 'linux', 'amd64'])
}

async function verifyProjectModules (goBinary) {
  const goMod = await readFile(resolve(root, 'go.mod'), 'utf8')
  const goSum = await readFile(resolve(root, 'go.sum'), 'utf8')
  assert.match(goMod, /github\.com\/theupdateframework\/go-tuf\/v2 v2\.4\.2(?:\s|$)/)
  assert.match(goMod, /github\.com\/sigstore\/sigstore v1\.10\.6(?:\s|$)/)
  assert(goSum.split('\n').includes(
    `${manifest.go_tuf.module} ${manifest.go_tuf.version} ${manifest.go_tuf.module_sum}`))
  assert(goSum.split('\n').includes(
    `${manifest.go_tuf.module} ${manifest.go_tuf.version}/go.mod ${manifest.go_tuf.go_mod_sum}`))

  const { stdout: verification } = await run(goBinary, ['mod', 'verify'], { cwd: root })
  assert.equal(verification.trim(), manifest.policy.module_verification)
  const { stdout: moduleJSON } = await run(goBinary,
    ['list', '-mod=readonly', '-m', '-json', manifest.go_tuf.module], { cwd: root })
  const projectModule = JSON.parse(moduleJSON)
  assert.equal(projectModule.Path, manifest.go_tuf.module)
  assert.equal(projectModule.Version, manifest.go_tuf.version)
  assert.equal(projectModule.Sum, manifest.go_tuf.module_sum)
  assert.equal(projectModule.GoModSum, manifest.go_tuf.go_mod_sum)
}

async function verifyDownloadedUpstreamModule (goBinary) {
  const requestedModule = `${manifest.go_tuf.module}@${manifest.go_tuf.version}`
  const { stdout } = await run(goBinary, ['mod', 'download', '-json', requestedModule], { cwd: root })
  const downloaded = JSON.parse(stdout)
  assert.equal(downloaded.Path, manifest.go_tuf.module)
  assert.equal(downloaded.Version, manifest.go_tuf.version)
  assert.equal(downloaded.Sum, manifest.go_tuf.module_sum)
  assert.equal(downloaded.GoModSum, manifest.go_tuf.go_mod_sum)
  assert.equal(downloaded.Error, undefined)
  assert.equal(downloaded.Origin?.VCS, 'git')
  assert.equal(downloaded.Origin?.URL, 'https://github.com/theupdateframework/go-tuf')
  assert.equal(downloaded.Origin?.Hash, manifest.go_tuf.commit)
  assert.equal(downloaded.Origin?.Ref, `refs/tags/${manifest.go_tuf.version}`)
  assert.equal(await sha256File(downloaded.GoMod), manifest.go_tuf.go_mod_sha256)
  assert.equal(await sha256File(resolve(downloaded.Dir, 'go.sum')), manifest.go_tuf.go_sum_sha256)
}

async function verifySourceCheckout (sourceDirectory, goBinary) {
  const source = resolve(sourceDirectory)
  assert(!(await lstat(source)).isSymbolicLink(), `source checkout is a symlink: ${source}`)
  const { stdout: commit } = await run('git', ['-C', source, 'rev-parse', 'HEAD'])
  assert.equal(commit.trim(), manifest.go_tuf.commit)
  const { stdout: status } = await run('git', ['-C', source, 'status', '--porcelain=v1'])
  assert.equal(status, '', 'upstream source checkout is not clean')
  const { stdout: tree } = await execFile('git', ['-C', source, 'ls-tree', '-r', 'HEAD'], {
    encoding: 'buffer', maxBuffer: 16 << 20,
  })
  assert.equal(createHash('sha256').update(tree).digest('hex'),
    manifest.go_tuf.source_tree_sha256)
  assert.equal(await sha256File(resolve(source, 'go.mod')), manifest.go_tuf.go_mod_sha256)
  assert.equal(await sha256File(resolve(source, 'go.sum')), manifest.go_tuf.go_sum_sha256)
  const { stdout: verification } = await run(goBinary, ['mod', 'verify'], {
    cwd: source, env: { GOPROXY: 'off', GOTOOLCHAIN: 'local' },
  })
  assert.equal(verification.trim(), manifest.policy.module_verification)
}

async function verifyGoDistribution (archivePath) {
  const archive = resolve(archivePath)
  assert(!(await lstat(archive)).isSymbolicLink(), `Go distribution is a symlink: ${archive}`)
  const details = await stat(archive)
  assert(details.isFile(), `Go distribution is not a regular file: ${archive}`)
  assert.equal(basename(archive), manifest.go.distribution_filename)
  assert.equal(details.size, manifest.go.distribution_size_bytes)
  assert.equal(await sha256File(archive), manifest.go.distribution_sha256)
  const header = (await readFile(archive)).subarray(0, 2)
  assert.deepEqual([...header], [0x1f, 0x8b], 'Go distribution is not gzip data')
}

async function verifyReferenceClient (binaryPath) {
  const binary = resolve(binaryPath)
  assert(!(await lstat(binary)).isSymbolicLink(), `reference client is a symlink: ${binary}`)
  const details = await stat(binary)
  assert(details.isFile(), `reference client is not a regular file: ${binary}`)
  assert.notEqual(details.mode & 0o111, 0, `reference client is not executable: ${binary}`)
  assert.equal(details.size, manifest.reference_client.size_bytes)
  assert.equal(await sha256File(binary), manifest.reference_client.binary_sha256)
  const bytes = await readFile(binary)
  assert.deepEqual([...bytes.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46],
    'reference client is not ELF')
  assert.equal(bytes[4], 2, 'reference client is not a 64-bit ELF')
  assert.equal(bytes[5], 1, 'reference client is not little-endian ELF')
  assert.equal(bytes.readUInt16LE(18), 0x3e, 'reference client is not x86-64 ELF')

  const goBinary = await isReadable(manifest.go.binary_path)
    ? manifest.go.binary_path
    : (process.env.HID_TUF_GO || 'go')
  const { stdout: buildInfo } = await run(goBinary, ['version', '-m', binary])
  assert.match(buildInfo, new RegExp(`^${escapeRegExp(binary)}: ${escapeRegExp(manifest.go.version)}$`, 'm'))
  assert.match(buildInfo, new RegExp(`^\\tpath\\t${escapeRegExp(manifest.project)}$`, 'm'))
  assert.match(buildInfo, new RegExp(`^\\tmod\\t${escapeRegExp(manifest.go_tuf.module)}\\t\\(devel\\)\\t$`, 'm'))
  for (const setting of [
    '-trimpath=true', 'CGO_ENABLED=0', 'GOARCH=amd64', 'GOOS=linux', 'GOAMD64=v1',
  ]) {
    assert.match(buildInfo, new RegExp(`^\\tbuild\\t${escapeRegExp(setting)}$`, 'm'))
  }
}

async function sha256File (filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function isReadable (filePath) {
  try {
    await access(filePath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function run (command, commandArguments, options = {}) {
  const environment = { ...process.env, GOTOOLCHAIN: 'local', ...options.env }
  return execFile(command, commandArguments, {
    cwd: options.cwd, env: environment, encoding: 'utf8', maxBuffer: 16 << 20,
  })
}

function parseArguments (arguments_) {
  const parsed = {
    requireInstalled: false, sourceDir: undefined, goDistribution: undefined,
    buildA: undefined, buildB: undefined,
  }
  const seen = new Set()
  for (let index = 0; index < arguments_.length; index++) {
    const name = arguments_[index]
    assert(!seen.has(name), `duplicate verifier option ${name}`)
    seen.add(name)
    if (name === '--require-installed') {
      parsed.requireInstalled = true
      continue
    }
    const properties = new Map([
      ['--source-dir', 'sourceDir'], ['--go-distribution', 'goDistribution'],
      ['--build-a', 'buildA'], ['--build-b', 'buildB'],
    ])
    const property = properties.get(name)
    assert(property !== undefined, `unknown verifier option ${name}`)
    index++
    assert(index < arguments_.length && arguments_[index] !== '', `${name} requires a value`)
    parsed[property] = arguments_[index]
  }
  assert.equal(parsed.buildA === undefined, parsed.buildB === undefined,
    '--build-a and --build-b must be supplied together')
  if (parsed.buildA !== undefined) {
    assert.notEqual(resolve(parsed.buildA), resolve(parsed.buildB),
      '--build-a and --build-b must identify distinct retained artifacts')
  }
  return parsed
}

function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
