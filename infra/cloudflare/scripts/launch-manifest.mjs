// The launch deployment manifest (launch-deployment.json): which Cloudflare
// Workers are deployed at launch, in each environment, and which are not.
// Offline only: no credential, network or Cloudflare API access.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import duplicateKeyJson from 'json-dup-key-validator'

export const HEALTH_ID_ARTIFACT_SOURCE = 'health-id-patient-web'
export const LAUNCH_ENVIRONMENTS = Object.freeze(['staging', 'production'])
export const LAUNCH_MANIFEST_SCHEMA = 'hid.cloudflare.launch-deployment/v1'

/** The Workers that serve the staged Health-id patient-web build (ADR-052). */
export const HEALTH_ID_WORKERS = Object.freeze(['hid-web', 'hid-admin'])

/** The modules the gateway proxies at launch (infra/aws/src/config.ts launchApiRoutes, D-Eminence/hid-system#65). */
export const LAUNCH_API_MODULES = Object.freeze(['identity', 'ehr'])

const NOT_DEPLOYED = Object.freeze(['hid-ehr', 'hid-lab', 'hid-pharmacy', 'hid-ocr', 'hid-outreach', 'hid-ocr-redirect'])

/**
 * The decided launch subset. The manifest must state exactly this, so widening
 * the launch takes a reviewed change here and in the manifest (and its own
 * decision), never an edit of one file.
 */
export const LAUNCH_DECISION = Object.freeze({
  staging: Object.freeze({
    deploy: Object.freeze(['hid-web', 'hid-admin']),
    not_deployed: NOT_DEPLOYED,
    separately_governed: Object.freeze(['hid-tuf-staging']),
  }),
  production: Object.freeze({
    deploy: Object.freeze(['hid-web', 'hid-admin', 'hid-apex-redirect']),
    not_deployed: NOT_DEPLOYED,
    separately_governed: Object.freeze(['hid-tuf-production']),
  }),
})

const FRONTEND_WORKER_MAIN = '../../src/frontend-worker.mjs'
const APEX_REDIRECT_MAIN = '../../src/apex-redirect-worker.mjs'

export function parseStrictJson(raw, label) {
  try {
    return duplicateKeyJson.parse(raw, false)
  } catch (error) {
    throw new Error(`${label} must be duplicate-free JSON: ${error.message}`)
  }
}

export function launchManifestPath(cloudflareRoot) {
  return resolve(cloudflareRoot, 'launch-deployment.json')
}

export async function readLaunchManifest(cloudflareRoot) {
  return parseStrictJson(await readFile(launchManifestPath(cloudflareRoot), 'utf8'), 'infra/cloudflare/launch-deployment.json')
}

/** Every Worker configuration under workers/, keyed by its directory name. */
export async function loadWorkerConfigs(cloudflareRoot) {
  const workersRoot = resolve(cloudflareRoot, 'workers')
  const configs = {}
  for (const entry of await readdir(workersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = resolve(workersRoot, entry.name, 'wrangler.json')
    configs[entry.name] = parseStrictJson(await readFile(path, 'utf8'), `${entry.name} Wrangler configuration`)
  }
  return configs
}

/**
 * The Workers configured for an environment: a named Wrangler environment of
 * that name, or (the TUF repository Workers) a configuration bound to it
 * without named environments.
 */
export function configuredWorkers(configs, environment) {
  return Object.entries(configs)
    .filter(([, config]) => config.env?.[environment] !== undefined
      || (config.env === undefined && config.vars?.DEPLOYMENT_ENV === environment))
    .map(([worker]) => worker)
    .sort()
}

/** The host a Worker answers on in an environment, from its own configuration. */
export function workerHost(config, environment) {
  const named = config.env?.[environment]
  const routes = named ? named.routes : config.routes
  assert.ok(Array.isArray(routes) && routes.length === 1 && routes[0].custom_domain === true,
    `${config.name} must have exactly one custom domain in ${environment}`)
  const host = routes[0].pattern
  const expected = named ? named.vars?.EXPECTED_HOST : config.vars?.EXPECTED_HOST
  if (expected !== undefined) assert.equal(expected, host, `${config.name} EXPECTED_HOST must be its custom domain in ${environment}`)
  return host
}

export function stagedDirectoryFor(cloudflareRoot, worker, environment) {
  return resolve(cloudflareRoot, 'workers', worker, 'staged', environment)
}

/**
 * A Health-id Worker has no default asset directory: each named environment
 * serves the build staged for its own host, beside its provenance file.
 */
export function assertHealthIdWorkerConfig(worker, config) {
  assert.ok(HEALTH_ID_WORKERS.includes(worker), `${worker} is not a Health-id launch Worker`)
  assert.equal(config.name, worker)
  assert.equal(config.main, FRONTEND_WORKER_MAIN, `${worker} must run the shared frontend Worker`)
  assert.equal(config.assets, undefined, `${worker} must not have a default asset directory`)
  assert.equal(config.routes, undefined, `${worker} must require an explicit deployment environment`)
  assert.equal(config.vars, undefined, `${worker} must not have a default API environment`)
  assert.deepEqual(Object.keys(config.env ?? {}).sort(), [...LAUNCH_ENVIRONMENTS].sort())
  for (const environment of LAUNCH_ENVIRONMENTS) {
    assert.deepEqual(config.env[environment].assets, {
      directory: `./staged/${environment}/site`,
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: true,
    }, `${worker} ${environment} must serve the Health-id build staged for that environment`)
  }
}

function assertExactKeys(value, keys, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has unexpected or missing fields`)
}

/**
 * Checks the manifest against the decided launch subset and the Worker
 * configurations: every Worker configured for an environment is classified
 * exactly once, deployed hosts are the Workers' own hosts, and the Health-id
 * Workers serve the staged Health-id build.
 */
export function assertLaunchManifest(manifest, configs, { environments = LAUNCH_ENVIRONMENTS } = {}) {
  assertExactKeys(manifest, ['schema_version', 'decision', 'frontend_artifact', 'api_route_closure', 'environments'], 'launch manifest')
  assert.equal(manifest.schema_version, LAUNCH_MANIFEST_SCHEMA)
  assert.match(manifest.decision, /ADR-052/)
  assert.equal(manifest.frontend_artifact.source, HEALTH_ID_ARTIFACT_SOURCE)
  assert.equal(manifest.frontend_artifact.repository, 'D-Eminence/Health-id')
  assert.equal(manifest.frontend_artifact.application, 'apps/patient-web')
  assert.equal(manifest.api_route_closure.mechanism, 'gateway HID_ENABLED_API_ROUTES',
    'deferred modules are closed by the gateway route switch, not by an absent host')
  assert.deepEqual(manifest.api_route_closure.launch_modules, [...LAUNCH_API_MODULES])
  assert.deepEqual(Object.keys(manifest.environments).sort(), [...LAUNCH_ENVIRONMENTS].sort())

  for (const environment of environments) {
    const plan = manifest.environments[environment]
    const decision = LAUNCH_DECISION[environment]
    assertExactKeys(plan, ['deploy', 'not_deployed', 'separately_governed'], `launch manifest ${environment}`)
    for (const category of ['deploy', 'not_deployed', 'separately_governed']) {
      assert.ok(Array.isArray(plan[category]), `${environment}.${category} must be a list`)
      assert.deepEqual(plan[category].map((entry) => entry.worker), [...decision[category]],
        `${environment}.${category} must be exactly the decided launch subset (ADR-052)`)
    }
    const classified = [...plan.deploy, ...plan.not_deployed, ...plan.separately_governed].map((entry) => entry.worker)
    assert.equal(new Set(classified).size, classified.length, `${environment}: a Worker is classified twice`)
    assert.deepEqual([...classified].sort(), configuredWorkers(configs, environment),
      `${environment}: every configured Worker must be classified exactly once`)

    for (const entry of plan.deploy) {
      assertExactKeys(entry, ['worker', 'host', 'assets', 'proxies_api'], `${environment} deploy ${entry.worker}`)
      const config = configs[entry.worker]
      assert.equal(entry.host, workerHost(config, environment), `${entry.worker} ${environment} host must be its Worker host`)
      if (HEALTH_ID_WORKERS.includes(entry.worker)) {
        assert.equal(entry.assets, HEALTH_ID_ARTIFACT_SOURCE, `${entry.worker} must serve the Health-id build`)
        assert.equal(entry.proxies_api, true)
        assertHealthIdWorkerConfig(entry.worker, config)
      } else {
        assert.equal(entry.worker, 'hid-apex-redirect', `${entry.worker} is not a launch Worker`)
        assert.equal(config.main, APEX_REDIRECT_MAIN)
        assert.equal(config.assets, undefined)
        assert.equal(entry.assets, null)
        assert.equal(entry.proxies_api, false)
      }
    }
    for (const entry of [...plan.not_deployed, ...plan.separately_governed]) {
      assertExactKeys(entry, ['worker', 'reason'], `${environment} ${entry.worker}`)
      assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 0, `${entry.worker} needs a reason`)
    }
  }
}

export function launchWorkers(manifest, environment) {
  assert.ok(LAUNCH_ENVIRONMENTS.includes(environment), 'Launch environment must be staging or production')
  return manifest.environments[environment].deploy.map((entry) => entry.worker)
}

/**
 * The host a Health-id build for this Worker and environment must target, or
 * the reasons there is none (the Worker or environment is not a launch target).
 */
export async function resolveHealthIdTarget({ cloudflareRoot, worker, environment }) {
  const issues = []
  if (!LAUNCH_ENVIRONMENTS.includes(environment)) {
    issues.push(`environment must be staging or production (received ${JSON.stringify(environment)})`)
    return { issues }
  }
  const manifest = await readLaunchManifest(cloudflareRoot)
  const configs = await loadWorkerConfigs(cloudflareRoot)
  assertLaunchManifest(manifest, configs)
  const deployed = manifest.environments[environment].deploy
    .filter((entry) => entry.assets === HEALTH_ID_ARTIFACT_SOURCE)
  const entry = deployed.find((candidate) => candidate.worker === worker)
  if (!entry) {
    issues.push(`${JSON.stringify(worker)} is not a Health-id launch frontend in ${environment} `
      + `(launch-deployment.json deploys ${deployed.map((candidate) => candidate.worker).join(', ')})`)
    return { issues }
  }
  return { issues, target: { worker, environment, host: entry.host } }
}
