#!/usr/bin/env node
// Local public-data intake only. No key creation, credential resolution, signing,
// trust-state writes, network calls or deployment authorization.
import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import duplicateKeyJson from 'json-dup-key-validator'
import { validatePublicRootFile } from '../../infra/cloudflare/scripts/tuf-repository-layout.mjs'

export const template = JSON.parse(await readFile(new URL('../config/staging-public-custody.template.json', import.meta.url), 'utf8'))
const sha256 = /^[a-f0-9]{64}$/
const publicLabel = /^[A-Za-z][A-Za-z0-9 ._-]{1,79}$/

export async function validateStagingPublicCustody(input, { rootPath, now } = {}) {
  const missing = [], errors = []
  function visit(expected, actual, path) {
    if (expected === null) {
      if (actual === null) { missing.push(path); return }
      const valid = path.endsWith('.version') ? Number.isSafeInteger(actual) && actual > 0
        : path.endsWith('.custodian_id') || path.endsWith('.hardware_provider')
          ? typeof actual === 'string' && publicLabel.test(actual) && !/private|secret|password|token|production|approved|verified|authorized|\bpin\b/i.test(actual)
          : typeof actual === 'string' && sha256.test(actual)
      if (!valid) errors.push(`${path}: invalid public value`)
    } else if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) { errors.push(`${path}: expected three records`); return }
      expected.forEach((entry, index) => visit(entry, actual[index], `${path}[${index}]`))
    } else if (typeof expected === 'object') {
      if (!actual || typeof actual !== 'object' || Array.isArray(actual)) { errors.push(`${path}: expected object`); return }
      if (Object.keys(expected).sort().join() !== Object.keys(actual).sort().join()) errors.push(`${path}: missing or unknown fields`)
      for (const [key, value] of Object.entries(expected)) visit(value, actual[key], path ? `${path}.${key}` : key)
    } else if (actual !== expected) errors.push(`${path}: governed value differs`)
  }
  visit(template, input, '')
  // Only inspect values after the exact public schema has passed. Diagnostics
  // never echo supplied values or unknown property names (which may be secrets).
  let root = null
  if (errors.length === 0) {
    const allKeyIDs = new Set()
    for (const role of ['root', 'targets']) {
      const custodians = new Set()
      for (const record of input.offline_custodians[role]) {
        if (record.key_id !== null) {
          if (allKeyIDs.has(record.key_id)) errors.push('offline_custodians: duplicate key')
          allKeyIDs.add(record.key_id)
        }
        if (record.custodian_id !== null) {
          const identity = record.custodian_id.toLowerCase().replace(/[ ._-]/g, '')
          if (custodians.has(identity)) errors.push(`offline_custodians.${role}: duplicate custodian`)
          custodians.add(identity)
        }
      }
    }
    if (rootPath !== undefined) {
      try { root = await validatePublicRootFile(rootPath, { now }) }
      catch { errors.push('trusted_root: public metadata rejected') }
      if (root) {
        if (input.trusted_root.version !== null && input.trusted_root.version !== root.version) errors.push('trusted_root: version mismatch')
        if (input.trusted_root.sha256 !== null && input.trusted_root.sha256 !== root.sha256) errors.push('trusted_root: independent digest mismatch')
        for (const role of ['root', 'targets']) {
          const authorized = new Set(root.keys.filter(key => key.role === role).map(key => key.key_id))
          if (input.offline_custodians[role].some(record => record.key_id !== null && !authorized.has(record.key_id))) errors.push(`offline_custodians.${role}: root role key mismatch`)
        }
      }
    } else missing.push('trusted_root.local_public_metadata_file')
  }
  return {
    schema_version: 'hid.staging-public-custody-check/v1', environment: 'staging',
    valid: errors.length === 0 && missing.length === 0 && root !== null,
    shape_valid: errors.length === 0, input_complete: errors.length === 0 && missing.length === 0,
    status: 'NOT_READY', authorization: 'NOT_AUTHORIZED', deployment_authorized: false,
    custody_verified: false, public_evidence_verified: false, staging_key_separation_verified: false,
    missing, errors, derived_public_root: errors.length === 0 ? root : null,
    remaining_gates: ['independent staging root provenance and hardware custody review',
      'staging/production key separation and online KMS public-key binding',
      'retained root rotation chain and signed candidate admission',
      'protected owner approval, immutable journal and live staging acceptance'],
  }
}

export async function loadPublicCustody(path) {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('noncanonical intake path')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > 16384) throw new Error('intake size/type')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) throw new Error('intake changed')
      offset += result.bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new Error('intake changed')
    return duplicateKeyJson.parse(bytes.toString('utf8'), false)
  } finally { await handle.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), checkTemplate = args[0] === '--check-template'
    if (checkTemplate) args.shift()
    if (args.length !== 1 && args.length !== 2) throw new Error('usage')
    const result = await validateStagingPublicCustody(await loadPublicCustody(args[0]), { rootPath: args[1] })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!(checkTemplate ? result.shape_valid : result.valid)) process.exitCode = 1
  } catch { process.stderr.write('staging public custody intake rejected\n'); process.exitCode = 1 }
}
