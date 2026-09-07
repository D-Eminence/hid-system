#!/usr/bin/env node
// Invoked ONLY by the immutable workflow after OIDC identity and tooling
// archive checks. Candidate artifacts are data: never imported or executed.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'
import { runPublicationPipeline, evidenceEnvelope } from './publication-pipeline.mjs'
import { admitReleaseBundle, collectTargetReferences, loadConfiguration, verifyProductionPromotionEvidence } from './verify-release-contract.mjs'
import { validateTufRepositoryDirectory } from '../../infra/cloudflare/scripts/tuf-repository-layout.mjs'
import { obtainPublicationAuthorization } from '../../infra/cloudflare/scripts/tuf-publication-authorization.mjs'
import { runTufWrangler, validateUploadReceipt, validateDeployReceipt } from '../../infra/cloudflare/scripts/tuf-wrangler.mjs'
import { runPreviewGate } from '../../infra/cloudflare/scripts/tuf-preview-gate.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha = /^[a-f0-9]{64}$/
const reject = () => { throw Error('protected publication rejected; retain evidence and reconcile before retry') }
const parse = (bytes) => duplicateKeyJson.parse(bytes.toString('utf8'), false)
const utc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

async function pinnedFile(path, expected, limit) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path || !sha.test(expected)) reject()
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await input.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > limit || (stat.mode & 0o022) !== 0) reject()
    const data = await input.readFile()
    if (data.length !== stat.size || hash(data) !== expected) reject()
    return data
  } finally { await input.close() }
}

function command(executable, args, maximum = 1048576, env = process.env) {
  const result = spawnSync(executable, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', maxBuffer: maximum })
  if (result.error || result.status !== 0) reject()
  return parse(Buffer.from(result.stdout))
}

export async function runProtectedPublication(configPath, expectedConfigHash, planPath, outputDirectory) {
  // These checks are additional defenses; AWS verifies the actual GitHub JWT
  // and immutable job_workflow_ref. Local environment variables are not IAM.
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.HID_TUF_IDENTITY_VERIFIED !== 'true') reject()
  const configBytes = await pinnedFile(configPath, expectedConfigHash, 64000)
  const config = parse(configBytes)
  if (config.schema_version !== 'hid.tuf.protected-publisher/v1') reject()
  const journalConfig = config.journal
  const reader = journalConfig?.reader
  if (!reader || !['staging', 'production'].includes(reader.environment)
    || journalConfig.github_repository !== process.env.GITHUB_REPOSITORY
    || journalConfig.workflow_ref !== `${process.env.GITHUB_REPOSITORY}/.github/workflows/tuf-publish.yml@${process.env.HID_TUF_VERIFIED_WORKFLOW_SHA}`) reject()
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  await pinnedFile(resolve(source, '.github/workflows/tuf-publish.yml'), config.workflow_sha256, 64000)
  const binaries = {}
  for (const name of ['hid-tuf', 'hid-tuf-publication', 'hid-tuf-journal']) {
    const pin = config.executables?.[name]
    if (!pin) reject()
    const path = resolve(source, 'tools/tuf-release/bin', name)
    await pinnedFile(path, pin, 134217728)
    binaries[name] = path
  }
  if (!isAbsolute(outputDirectory) || await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) reject()
  await mkdir(outputDirectory, { mode: 0o700 }) // Must not reuse a prior run.
  const plan = parse(await readFile(planPath))
  if (plan.environment !== reader.environment || !/^[a-f0-9]{40}$/.test(plan.git_sha) || plan.git_sha !== process.env.GITHUB_SHA
    || !/^r[0-9]{10}-g[a-f0-9]{40}$/.test(plan.release_id) || !plan.release_id.endsWith(`-g${plan.git_sha}`)
    || !sha.test(plan.repository_sha256) || !sha.test(plan.artifact_sha256) || !sha.test(plan.artifact_set_sha256)
    || typeof plan.bootstrap !== 'boolean') reject()
  const candidatePath = resolve(process.env.RUNNER_TEMP, 'hid-candidate/repository')
  const previousPath = plan.bootstrap ? '-' : resolve(process.env.RUNNER_TEMP, 'hid-previous/repository')
  if (plan.bootstrap ? plan.previous_repository_sha256 !== '' : !sha.test(plan.previous_repository_sha256)) reject()
  const repository = await validateTufRepositoryDirectory(candidatePath, reader.environment)
  if (repository.repositorySha256 !== plan.repository_sha256) reject()
  const artifactIdentity = `environments/${reader.environment}/releases/${plan.release_id}/release-bundle.json`
  const targetFile = `targets/${dirname(artifactIdentity)}/${plan.artifact_sha256}.${basename(artifactIdentity)}`
  const bundleBytes = await pinnedFile(resolve(candidatePath, targetFile), plan.artifact_sha256, 26214400)
  const bundle = parse(bundleBytes)
  admitReleaseBundle(bundle, await loadConfiguration(), { environment: reader.environment, awsAccountId: reader.expected_aws_account_id,
    awsRegion: reader.expected_aws_region, releaseId: plan.release_id, gitSha: plan.git_sha, admissionTime: utc() })
  if (bundle.release.artifact_set_sha256 !== plan.artifact_set_sha256) reject()
  const signedTargets = parse(await readFile(resolve(candidatePath, `metadata/${repository.targetsVersion}.targets.json`))).signed.targets
  if (signedTargets[artifactIdentity]?.hashes?.sha256 !== plan.artifact_sha256) reject()
  const referenced = new Map()
  for (const ref of collectTargetReferences(bundle)) {
    const file = `targets/${dirname(ref.path)}/${ref.sha256}.${basename(ref.path)}`
    if (signedTargets[ref.path]?.hashes?.sha256 !== ref.sha256 || signedTargets[ref.path]?.length !== ref.length) reject()
    const entry = repository.files.find((item) => item.path === file)
    if (!entry || entry.sha256 !== ref.sha256 || entry.length !== ref.length) reject()
    referenced.set(ref.path, file)
  }
  if (reader.environment === 'production') {
    const evidence = {}
    for (const [key, ref] of Object.entries(bundle.promotion.evidence)) evidence[key] = parse(await readFile(resolve(candidatePath, referenced.get(ref.path))))
    verifyProductionPromotionEvidence(bundle, evidence, utc())
  }
  const readerPath = resolve(outputDirectory, 'reader.json')
  const journalPath = resolve(outputDirectory, 'journal.json')
  const readerBytes = Buffer.from(JSON.stringify(reader))
  const journalBytes = Buffer.from(JSON.stringify(journalConfig))
  await writeFile(readerPath, readerBytes, { flag: 'wx', mode: 0o600 })
  await writeFile(journalPath, journalBytes, { flag: 'wx', mode: 0o600 })
  Object.assign(process.env, {
    HID_TUF_PUBLICATION_EXECUTABLE: binaries['hid-tuf-publication'], HID_TUF_PUBLICATION_EXECUTABLE_SHA256: config.executables['hid-tuf-publication'],
    HID_TUF_PUBLICATION_CONFIG: readerPath, HID_TUF_PUBLICATION_CONFIG_SHA256: hash(readerBytes),
    HID_TUF_PREVIOUS_REPOSITORY: previousPath, HID_TUF_PREVIOUS_REPOSITORY_SHA256: plan.bootstrap ? '-' : plan.previous_repository_sha256,
  })
  let freshResult = await obtainPublicationAuthorization(repository)
  if (freshResult.authorization.release_id !== plan.release_id || plan.bootstrap !== (freshResult.authorization.state_revision === 0)) reject()
  const binding = { git_sha: plan.git_sha, artifact_identity: artifactIdentity, artifact_sha256: plan.artifact_sha256, artifact_set_sha256: plan.artifact_set_sha256,
    github_repository: journalConfig.github_repository, workflow_ref: journalConfig.workflow_ref, actor_id: process.env.GITHUB_ACTOR_ID,
    owner: `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`, repository_sha256: plan.repository_sha256,
    previous_repository_sha256: plan.previous_repository_sha256, workflow_sha256: config.workflow_sha256, config_sha256: expectedConfigHash,
    executable_sha256: config.executables['hid-tuf-journal'], authorization: freshResult.authorization }
  let requestNumber = 0
  const journal = async (request) => {
    const path = resolve(outputDirectory, `request-${++requestNumber}.json`)
    await writeFile(path, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
    const response = command(binaries['hid-tuf-journal'], [journalPath, hash(journalBytes), path])
    await writeFile(resolve(outputDirectory, `result-${requestNumber}.json`), JSON.stringify(response), { flag: 'wx', mode: 0o600 })
    return response
  }
  const seal = async (phase, payload) => {
    const evidence = evidenceEnvelope(binding, phase, payload)
    const reference = await journal({ action: 'evidence', evidence: parse(evidence.bytes), evidence_sha256: evidence.sha256 })
    return { ...evidence, reference }
  }
  let credentialLoaded = false
  const credential = async () => {
    if (credentialLoaded) return
    const cf = config.cloudflare
    if (!/^[a-f0-9]{32}$/.test(cf?.account_id) || typeof cf.secret_arn !== 'string'
      || !cf.secret_arn.startsWith(`arn:aws:secretsmanager:${reader.expected_aws_region}:${reader.expected_aws_account_id}:secret:hid-${reader.environment}-cloudflare-publisher-token-`)
      || !/^[A-Za-z0-9-]{32,64}$/.test(cf.secret_version_id)) reject()
    await pinnedFile(cf.aws_cli_path, cf.aws_cli_sha256, 134217728)
    const credentialEnvironment = {
      PATH: process.env.PATH, LANG: 'C.UTF-8',
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1',
    }
    if (!credentialEnvironment.AWS_ACCESS_KEY_ID || !credentialEnvironment.AWS_SECRET_ACCESS_KEY || !credentialEnvironment.AWS_SESSION_TOKEN) reject()
    const secret = command(cf.aws_cli_path, ['secretsmanager', 'get-secret-value', '--secret-id', cf.secret_arn, '--version-id', cf.secret_version_id,
      '--region', reader.expected_aws_region, '--endpoint-url', `https://secretsmanager.${reader.expected_aws_region}.amazonaws.com`, '--output', 'json', '--no-cli-pager'], 64000, credentialEnvironment)
    if (secret.ARN !== cf.secret_arn || secret.VersionId !== cf.secret_version_id || !/^[A-Za-z0-9_-]{20,256}$/.test(secret.SecretString)) reject()
    process.stdout.write(`::add-mask::${secret.SecretString}\n`)
    process.env.CLOUDFLARE_API_TOKEN = secret.SecretString
    process.env.CLOUDFLARE_ACCOUNT_ID = cf.account_id
    credentialLoaded = true
  }
  const receiptPath = (name) => resolve(outputDirectory, `${name}.json`)
  const wrapperOptions = (beforeEffect) => ({ authorize: async (actual) => {
    if (actual.repositorySha256 !== plan.repository_sha256) reject()
    await beforeEffect()
    await credential()
    return freshResult
  } })
  const signal = AbortSignal.timeout(29 * 60 * 1000)
  try {
    const result = await runPublicationPipeline({ binding, bootstrap: plan.bootstrap, signal }, {
      journal: {
        begin: async (value) => (await journal({ action: 'begin', binding: value })).record,
        advance: async (record, phase, evidence_sha256, authorization) => (await journal({ action: 'advance', owner: binding.owner, revision: record.revision, phase, evidence_sha256, authorization })).record,
        fail: async (record, failure_code, evidence_sha256) => (await journal({ action: 'fail', owner: binding.owner, revision: record.revision, failure_code, evidence_sha256 })).record,
        confirm: async (record, confirmation, evidence_sha256) => (await journal({ action: 'confirm', owner: binding.owner, revision: record.revision, confirmation, evidence_sha256 })).record,
      },
      authorize: async () => { freshResult = await obtainPublicationAuthorization(repository); return freshResult.authorization },
      verifyArchive: async () => {
        const archive = await journal({ action: 'archive', repository_directory: candidatePath, repository_sha256: plan.repository_sha256 })
        return seal('archive-verified', { archive, release_id: plan.release_id, git_sha: plan.git_sha, repository_sha256: plan.repository_sha256,
          artifact_sha256: plan.artifact_sha256, artifact_set_sha256: plan.artifact_set_sha256, file_count: repository.fileCount })
      },
      parent: async ({ beforeEffect }) => {
        const receipt = await runTufWrangler(['bootstrap-parent', reader.environment, receiptPath('parent'), `create-inaccessible-hid-tuf-${reader.environment}-parent`], {
          beforeEffect: async () => { await beforeEffect(); await credential() },
        })
        return seal('parent-created', receipt)
      },
      upload: async ({ beforeEffect }) => {
        const receipt = await runTufWrangler(['versions-upload', reader.environment, candidatePath, receiptPath('upload')], wrapperOptions(beforeEffect))
        validateUploadReceipt(receipt, reader.environment)
        return seal('uploaded', receipt)
      },
      preview: async () => {
        const result = await runPreviewGate({ uploadReceipt: receiptPath('upload'), client: binaries['hid-tuf'], clientSha256: config.executables['hid-tuf'],
          root: resolve(candidatePath, 'metadata/1.root.json'), rootSha256: reader.bootstrap_root_sha256, releaseId: plan.release_id, gitSha: plan.git_sha,
          awsAccountId: reader.expected_aws_account_id, awsRegion: reader.expected_aws_region, admissionTime: utc(), workspace: resolve(outputDirectory, 'preview-workspace'), output: receiptPath('preview') })
        if (result.deployment_plan?.artifact_set_sha256 !== plan.artifact_set_sha256) reject()
        return seal('preview-verified', result)
      },
      deploy: async ({ beforeEffect, upload }) => {
        const receipt = await runTufWrangler(['versions-deploy', reader.environment, candidatePath, receiptPath('upload'), receiptPath('preview'), receiptPath('deploy'),
          `deploy-hid-tuf-${reader.environment}-${upload.payload.version_id}-at-100-percent`], wrapperOptions(beforeEffect))
        validateDeployReceipt(receipt, reader.environment, plan.repository_sha256)
        if (receipt.artifact_set_sha256 !== plan.artifact_set_sha256) reject()
        return seal('deployed', receipt)
      },
      route: async ({ beforeEffect, deployment }) => {
        const host = reader.environment === 'production' ? 'updates.healthidentitydirectory.com' : 'updates.staging.healthidentitydirectory.com'
        const receipt = await runTufWrangler(['activate-route', reader.environment, candidatePath, receiptPath('deploy'), receiptPath('route'),
          `activate-${host}-for-${deployment.payload.version_id}`], wrapperOptions(beforeEffect))
        return seal('route-activated', receipt)
      },
      confirmPublished: async () => {
        // Retrying this read cannot cause publication or checkpoint mutation.
        let result
        try { result = command(binaries['hid-tuf-publication'], ['confirm', readerPath, candidatePath, plan.repository_sha256, String(binding.authorization.state_revision)]) } catch { return null }
        if (result.schema_version !== 'hid.tuf.publication-confirmation/v1' || result.repository_sha256 !== plan.repository_sha256 || result.file_count !== repository.fileCount) reject()
        return seal('confirmed', result.confirmation)
      },
    })
    await writeFile(receiptPath('summary'), JSON.stringify(result), { flag: 'wx', mode: 0o600 })
    return result
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN
    delete process.env.CLOUDFLARE_ACCOUNT_ID
    try { await journal({ action: 'read' }) } catch { /* A failed read never repairs an unresolved head. */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6) { process.stderr.write('protected publisher requires config, config hash, plan and fresh output directory\n'); process.exitCode = 1 }
  else runProtectedPublication(...process.argv.slice(2)).catch(() => { process.stderr.write('protected publication failed; preserve journal and reconcile before any retry\n'); process.exitCode = 1 })
}
