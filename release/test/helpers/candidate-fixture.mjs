// Synthetic fixtures only; never used for publication.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { computeArtifactSetSha256, loadConfiguration } from '../../scripts/verify-release-contract.mjs'
const configuration = await loadConfiguration()
const COMPONENTS = configuration.components.oci_components
const FRONTENDS = configuration.components.frontends
export const ACCOUNT = '123456789012'
export const REGION = 'af-south-1'
export const GIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const ADMISSION_TIME = '2026-08-31T15:00:00Z'
const SHA256 = /^[a-f0-9]{64}$/
const MEDIA = {
  bundle: 'application/vnd.hid.release-bundle+json',
  archive: 'application/vnd.hid.frontend-ustar',
  manifest: 'application/vnd.hid.frontend-content-manifest+json',
  sbom: 'application/spdx+json',
  scan: 'application/vnd.hid.scan-summary+json',
  provenance: 'application/vnd.in-toto+jsonl',
  worker: 'text/javascript',
  ledger: 'application/vnd.hid.migration-ledger+json',
  migrationVerification: 'application/vnd.hid.migration-verification+json',
  promotion: 'application/vnd.hid.promotion-evidence+json',
}
const REQUIRED_CHECKS = {
  'staging-acceptance': ['release-bundle-admitted', 'deployment-healthy', 'frontend-canary', 'api-canary'],
  'migration-dry-run': ['migration-ledger-verified', 'dry-run-completed', 'schema-postconditions'],
  'staging-copy-migration': ['source-copy-restored', 'migration-completed', 'schema-postconditions', 'application-smoke'],
  'backup-restore': ['backup-created', 'restore-completed', 'data-integrity', 'application-smoke'],
  'rollback-drill': ['forward-rollback-release', 'rollback-deployed', 'application-smoke'],
  approval: ['all-staging-gates-bound', 'artifact-set-identical', 'production-change-approved'],
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function releaseId(sequence) {
  return `r${String(sequence).padStart(10, '0')}-g${GIT_SHA}`
}

function target(environment, id, relativePath, mediaType, length = 97) {
  return {
    path: `environments/${environment}/releases/${id}/${relativePath}`,
    length,
    sha256: sha256(`content:${relativePath}`),
    media_type: mediaType,
  }
}

function evidenceRef(environment, id, relativePath, mediaType) {
  return { format: 'SPDX-JSON', target: target(environment, id, relativePath, mediaType) }
}

function provenanceRef(environment, id, relativePath) {
  return {
    format: 'in-toto-jsonl',
    predicate_type: 'https://slsa.dev/provenance/v1',
    target: target(environment, id, relativePath, MEDIA.provenance),
  }
}

function scanRef(environment, id, relativePath) {
  return {
    scanner: 'trivy',
    scanner_version: '1.2.3',
    completed_at: '2026-08-31T10:30:00Z',
    critical: 0,
    high: 0,
    decision: 'pass',
    target: target(environment, id, relativePath, MEDIA.scan),
  }
}

export function buildBundle(environment, sequence, stagingBundle) {
  const id = releaseId(sequence)
  const environmentConfig = configuration.environments.environments.find((item) => item.name === environment)
  const createdAt = environment === 'staging' ? '2026-08-31T12:00:00Z' : '2026-08-31T14:00:00Z'
  const workerScript = target(environment, id, 'edge/frontend-worker.mjs', MEDIA.worker, 4096)
  const bundle = {
    schema_version: '2.0.0',
    release: {
      id,
      sequence,
      source_repository: configuration.components.source_repository,
      git_sha: GIT_SHA,
      created_at: createdAt,
      artifact_set_sha256: '0'.repeat(64),
    },
    environment: {
      name: environment,
      tuf_repository_id: environmentConfig.tuf_repository_id,
      update_origin: environmentConfig.update_origin,
      target_prefix: environmentConfig.target_prefix,
      aws_account_id: ACCOUNT,
      aws_region: REGION,
    },
    oci_images: COMPONENTS.map((component) => {
      const base = `oci/${component.name}`
      return {
        component: component.name,
        repository_uri: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${environment}/hid/${component.ecr_repository}`,
        digest: `sha256:${sha256(`image:${component.name}`)}`,
        size_bytes: 1048576,
        platform: { os: 'linux', architecture: 'amd64' },
        built_at: '2026-08-31T10:00:00Z',
        sbom: evidenceRef(environment, id, `${base}/sbom.spdx.json`, MEDIA.sbom),
        scan: scanRef(environment, id, `${base}/scan-summary.json`),
        provenance: provenanceRef(environment, id, `${base}/provenance.intoto.jsonl`),
      }
    }),
    frontends: FRONTENDS.map(({ app, worker }) => {
      const base = `frontends/${app}`
      return {
        app,
        archive: {
          format: 'ustar',
          file_count: 3,
          uncompressed_size_bytes: 3072,
          target: target(environment, id, `${base}/assets.tar`, MEDIA.archive, 10240),
        },
        content_manifest: target(environment, id, `${base}/content-manifest.json`, MEDIA.manifest),
        worker: {
          name: `${worker}-${environment}`,
          script: structuredClone(workerScript),
          compatibility_date: '2026-08-12',
          hostname: environmentConfig.frontend_hosts[app],
          api_origin: environmentConfig.api_origin,
          cache_generation: GIT_SHA,
        },
        sbom: evidenceRef(environment, id, `${base}/sbom.spdx.json`, MEDIA.sbom),
        scan: scanRef(environment, id, `${base}/scan-summary.json`),
        provenance: provenanceRef(environment, id, `${base}/provenance.intoto.jsonl`),
      }
    }),
    edge: {
      frontend_worker: structuredClone(workerScript),
      apex_redirect: environment === 'staging' ? null : {
        name: environmentConfig.apex_redirect.worker,
        script: target(environment, id, 'edge/apex-redirect-worker.mjs', MEDIA.worker, 2048),
        hostname: environmentConfig.apex_redirect.hostname,
        destination_origin: environmentConfig.apex_redirect.destination_origin,
      },
    },
    migration: {
      image_component: 'database-migration',
      first: '0001',
      last: '0032',
      count: 32,
      ledger: target(environment, id, 'migrations/ledger.json', MEDIA.ledger),
      verification: target(environment, id, 'migrations/verification.json', MEDIA.migrationVerification),
    },
    promotion: environment === 'staging' ? { kind: 'candidate' } : {
      kind: 'staging-validated',
      staging_release_id: stagingBundle.release.id,
      staging_artifact_set_sha256: stagingBundle.release.artifact_set_sha256,
      evidence: Object.fromEntries([
        ['staging_acceptance', 'staging-acceptance.json'],
        ['migration_dry_run', 'migration-dry-run.json'],
        ['staging_copy_migration', 'staging-copy-migration.json'],
        ['backup_restore', 'backup-restore.json'],
        ['rollback_drill', 'rollback-drill.json'],
        ['approval', 'approval.json'],
      ].map(([key, filename]) => [key, target(environment, id, `promotion/${filename}`, MEDIA.promotion)])),
    },
  }
  bundle.release.artifact_set_sha256 = computeArtifactSetSha256(bundle)
  if (environment === 'production') {
    assert.equal(bundle.release.artifact_set_sha256, stagingBundle.release.artifact_set_sha256)
  }
  return bundle
}

