#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'

import { admit } from '../../../release/scripts/admit-release.mjs'
import { validateUploadReceipt } from './tuf-wrangler.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const SHA256 = /^[a-f0-9]{64}$/
const FLAGS = new Map([
  ['--upload-receipt', 'uploadReceipt'],
  ['--client', 'client'],
  ['--client-sha256', 'clientSha256'],
  ['--root', 'root'],
  ['--root-sha256', 'rootSha256'],
  ['--release', 'releaseId'],
  ['--git-sha', 'gitSha'],
  ['--aws-account', 'awsAccountId'],
  ['--aws-region', 'awsRegion'],
  ['--admission-time', 'admissionTime'],
  ['--workspace', 'workspace'],
  ['--output', 'output'],
])

function parseArguments(values) {
  if (values.length !== FLAGS.size * 2) throw new Error('preview gate requires every documented flag exactly once')
  const parsed = {}
  const seen = new Set()
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index]
    const value = values[index + 1]
    const key = FLAGS.get(flag)
    if (key === undefined || value === undefined || value.length === 0 || seen.has(flag)) {
      throw new Error(`unknown, empty, or duplicate preview-gate flag ${flag}`)
    }
    parsed[key] = value
    seen.add(flag)
  }
  return parsed
}

async function readRegular(path, maximum) {
  if (!isAbsolute(path)) throw new Error(`preview gate path must be absolute: ${path}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum) throw new Error(`${path} is not a bounded regular file`)
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) throw new Error(`${path} changed while being read`)
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new Error(`${path} grew while being read`)
    return bytes
  } finally {
    await handle.close()
  }
}

export async function runPreviewGate(options, dependencies = {}) {
  for (const field of ['uploadReceipt', 'client', 'root', 'workspace', 'output']) {
    if (typeof options[field] !== 'string' || !isAbsolute(options[field])) {
      throw new Error(`preview gate requires an absolute ${field} path`)
    }
  }
  const receiptBytes = await readRegular(options.uploadReceipt, 1048576)
  const rawReceipt = duplicateKeyJson.parse(receiptBytes.toString('utf8'), false)
  const receipt = validateUploadReceipt(rawReceipt, rawReceipt.deployment)
  if (options.rootSha256 !== receipt.publication_authorization.authorization.bootstrap_root_sha256) {
    throw new Error('preview bootstrap root differs from the broker-authorized trust pin')
  }
  if (!SHA256.test(options.rootSha256) || !SHA256.test(options.clientSha256)) throw new Error('root and client hashes must be exact lowercase SHA-256 values')
  const root = options.root
  const rootBytes = await readRegular(root, 524288)
  if (createHash('sha256').update(rootBytes).digest('hex') !== options.rootSha256) throw new Error('bootstrap root bytes do not match the supplied out-of-band pin')

  const workspace = options.workspace

  const temporaryDirectory = await mkdtemp(join(tmpdir(), `hid-${receipt.deployment}-preview-trust-`))
  try {
    const previewOrigin = receipt.preview_url.slice(0, -1)
    const config = {
      schema_version: '1.0.0',
      environment: receipt.deployment,
      repository_id: `hid-${receipt.deployment}-preview-${receipt.version_id.slice(0, 8)}`,
      metadata_url: `${previewOrigin}/metadata`,
      targets_url: `${previewOrigin}/targets`,
      trusted_root_path: root,
      trusted_root_sha256: options.rootSha256,
      state_dir: resolve(temporaryDirectory, 'state'),
      max_target_bytes: 26214400,
    }
    const configPath = resolve(temporaryDirectory, 'trust.json')
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    return await (dependencies.admitRelease ?? admit)({
      client: options.client,
      clientSha256: options.clientSha256,
      config: configPath,
      environment: receipt.deployment,
      releaseId: options.releaseId,
      gitSha: options.gitSha,
      awsAccountId: options.awsAccountId,
      awsRegion: options.awsRegion,
      admissionTime: options.admissionTime,
      workspace,
      output: options.output,
    })
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  runPreviewGate(parseArguments(process.argv.slice(2))).then((record) => {
    process.stdout.write(`${JSON.stringify({
      status: 'preview-admitted',
      environment: record.deployment_plan.environment,
      release_id: record.deployment_plan.release_id,
      plan_sha256: record.deployment_plan.plan_sha256,
      admission_record_sha256: record.admission_record_sha256,
    })}\n`)
  }).catch((error) => {
    process.stderr.write(`TUF preview verification failed closed: ${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
