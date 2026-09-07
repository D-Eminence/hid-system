#!/usr/bin/env node

import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateTufRepositoryDirectory } from './tuf-repository-layout.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const DEPLOYMENTS = new Set(['staging', 'production'])

export function parseArguments(values) {
  if (!Array.isArray(values) || values.length !== 2) {
    throw new Error('repository validation requires exactly DEPLOYMENT and REPOSITORY_DIRECTORY')
  }
  const [deployment, repository] = values
  if (!DEPLOYMENTS.has(deployment)) {
    throw new Error('DEPLOYMENT must be staging or production')
  }
  if (typeof repository !== 'string' || repository.length === 0
    || !isAbsolute(repository) || resolve(repository) !== repository) {
    throw new Error('REPOSITORY_DIRECTORY must be a canonical absolute path')
  }
  return Object.freeze({ deployment, repository })
}

export async function runTufRepositoryValidation(values, options = {}) {
  const { deployment, repository } = parseArguments(values)
  let canonicalRepository
  try {
    canonicalRepository = await realpath(repository)
  } catch {
    throw new Error('REPOSITORY_DIRECTORY must resolve to an existing canonical absolute path')
  }
  if (canonicalRepository !== repository) {
    throw new Error('REPOSITORY_DIRECTORY must be its canonical real path')
  }

  const validated = await validateTufRepositoryDirectory(repository, deployment, options)
  return Object.freeze({
    schema_version: '1.0.0',
    status: 'repository-valid',
    deployment: validated.deployment,
    repository: validated.repository,
    repository_sha256: validated.repositorySha256,
    file_count: validated.fileCount,
    root_version: validated.rootVersion,
    targets_version: validated.targetsVersion,
    snapshot_version: validated.snapshotVersion,
    timestamp_version: validated.timestampVersion,
  })
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  runTufRepositoryValidation(process.argv.slice(2)).then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  }).catch((error) => {
    process.stderr.write(`TUF repository validation failed closed: ${error.message}\n`)
    process.exitCode = 1
  })
}
