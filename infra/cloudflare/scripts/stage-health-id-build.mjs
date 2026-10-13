#!/usr/bin/env node
// Stages a Health-id apps/patient-web build as the asset directory of one
// launch Worker (hid-web or hid-admin) in one environment, with a provenance
// file. Offline only: it reads the build and writes under the Worker's
// git-ignored staged/ directory; it never deploys, and needs no credential.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HealthIdArtifactError, stageHealthIdBuild } from './health-id-artifact.mjs'
import { stagedDirectoryFor } from './launch-manifest.mjs'

const cloudflareRoot = resolve(import.meta.dirname, '..')
const USAGE = 'Usage: node scripts/stage-health-id-build.mjs --worker <hid-web|hid-admin> '
  + '--environment <staging|production> --build <Health-id apps/patient-web/dist> '
  + '--source-commit <40-hex Health-id commit> [--staged-directory <directory>]'
const OPTIONS = new Map([
  ['--worker', 'worker'], ['--environment', 'environment'], ['--build', 'build'],
  ['--source-commit', 'sourceCommit'], ['--staged-directory', 'stagedDirectory'],
])

export function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = OPTIONS.get(argv[index])
    const value = argv[index + 1]
    if (!name || value === undefined || value.startsWith('--') || Object.hasOwn(values, name)) throw new Error(USAGE)
    values[name] = value
  }
  for (const required of ['worker', 'environment', 'build', 'sourceCommit']) {
    if (!values[required]) throw new Error(USAGE)
  }
  return values
}

export async function main(argv) {
  const options = parseArguments(argv)
  const stagedDirectory = resolve(options.stagedDirectory
    ?? stagedDirectoryFor(cloudflareRoot, options.worker, options.environment))
  const { provenance, siteDirectory, provenancePath } = await stageHealthIdBuild({
    build: options.build,
    sourceCommit: options.sourceCommit,
    worker: options.worker,
    environment: options.environment,
    cloudflareRoot,
    stagedDirectory,
  })
  return {
    status: 'staged',
    worker: provenance.worker,
    environment: provenance.environment,
    host: provenance.host,
    source_commit: provenance.source_commit,
    build_environment: provenance.build_environment,
    file_count: provenance.file_count,
    tree_sha256: provenance.tree_sha256,
    site_directory: siteDirectory,
    provenance: provenancePath,
    deployed: false,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`)
  } catch (error) {
    if (error instanceof HealthIdArtifactError) {
      const [worker, environment] = [process.argv[process.argv.indexOf('--worker') + 1], process.argv[process.argv.indexOf('--environment') + 1]]
      process.stderr.write(`Refusing to stage the Health-id build for ${worker} ${environment}; nothing was written:\n- ${error.issues.join('\n- ')}\n`)
    } else {
      process.stderr.write(`${error.message}\n`)
    }
    process.exitCode = 1
  }
}
