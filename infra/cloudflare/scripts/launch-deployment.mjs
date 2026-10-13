// Launch deployment checks: the manifest, the Health-id Worker configuration
// and the staged Health-id artefacts. Offline only.
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { HealthIdArtifactError, verifyStagedHealthIdArtifact } from './health-id-artifact.mjs'
import {
  HEALTH_ID_WORKERS,
  LAUNCH_ENVIRONMENTS,
  assertHealthIdWorkerConfig,
  assertLaunchManifest,
  launchWorkers,
  loadWorkerConfigs,
  readLaunchManifest,
  stagedDirectoryFor as defaultStagedDirectoryFor,
} from './launch-manifest.mjs'

export * from './launch-manifest.mjs'

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Verifies the launch manifest and the Health-id Workers, then every staged
 * Health-id artefact. With `requireStaged` (a launch environment named), each
 * Health-id Worker deployed in that environment must have a staged artefact
 * that verifies; otherwise (repository mode, `environment` null) artefacts are
 * optional, but any that is present must verify completely.
 */
export async function verifyLaunchDeployment({
  cloudflareRoot = resolve(import.meta.dirname, '..'),
  environment,
  requireStaged,
  stagedDirectoryFor = (worker, deployment) => defaultStagedDirectoryFor(cloudflareRoot, worker, deployment),
}) {
  if (environment !== null && !LAUNCH_ENVIRONMENTS.includes(environment)) {
    throw new Error(`Launch environment must be staging or production (received ${JSON.stringify(environment)})`)
  }
  if (requireStaged && environment === null) throw new Error('Requiring staged artefacts needs a launch environment')
  const manifest = await readLaunchManifest(cloudflareRoot)
  const configs = await loadWorkerConfigs(cloudflareRoot)
  assertLaunchManifest(manifest, configs)
  for (const worker of HEALTH_ID_WORKERS) assertHealthIdWorkerConfig(worker, configs[worker])

  const artifacts = []
  for (const deployment of environment === null ? LAUNCH_ENVIRONMENTS : [environment]) {
    for (const entry of manifest.environments[deployment].deploy) {
      if (!HEALTH_ID_WORKERS.includes(entry.worker)) continue
      const stagedDirectory = stagedDirectoryFor(entry.worker, deployment)
      if (!await exists(stagedDirectory)) {
        if (requireStaged) {
          throw new Error(`${entry.worker} ${deployment}: the Health-id artefact is not staged at ${stagedDirectory}; `
            + 'build Health-id apps/patient-web for this host and run scripts/stage-health-id-build.mjs')
        }
        continue
      }
      let provenance
      try {
        provenance = await verifyStagedHealthIdArtifact({
          worker: entry.worker, environment: deployment, host: entry.host, stagedDirectory,
        })
      } catch (error) {
        if (!(error instanceof HealthIdArtifactError)) throw error
        throw new Error(`${entry.worker} ${deployment}: staged Health-id artefact refused: ${error.issues.join('; ')}`)
      }
      artifacts.push({
        worker: entry.worker,
        environment: deployment,
        host: entry.host,
        source_commit: provenance.source_commit,
        tree_sha256: provenance.tree_sha256,
        file_count: provenance.file_count,
        staged_at: provenance.staged_at,
      })
    }
  }
  return {
    environment,
    deploy: environment === null ? null : launchWorkers(manifest, environment),
    not_deployed: environment === null ? null : manifest.environments[environment].not_deployed.map((entry) => entry.worker),
    artifacts,
  }
}
