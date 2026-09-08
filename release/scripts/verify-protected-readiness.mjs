#!/usr/bin/env node
// A GitHub-only approval/OIDC probe. No cloud SDK, publisher, package install,
// deployment, signing material, or raw token output belongs in this program.
import { createPublicKey, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REPOSITORY = 'D-Eminence/hid-system'
export const REPOSITORY_ID = '1317340803'
export const OWNER_LOGIN = 'D-Eminence'
export const OWNER_ID = '182018869'
export const PROTECTED_REF = 'refs/heads/tuf-production-release'
export const WORKFLOW = '.github/workflows/tuf-protected-readiness.yml'
export const WORKFLOW_NAME = 'Protected staging readiness probe'
export const AUDIENCE = 'hid-protected-ci-readiness'
export const ISSUER = 'https://token.actions.githubusercontent.com'
export const JWKS_URL = `${ISSUER}/.well-known/jwks`
export const ENVIRONMENTS = Object.freeze(['staging', 'production', 'staging-publisher', 'production-publisher'])
const SHA = /^[a-f0-9]{40}$/
const ID = /^[1-9][0-9]{0,19}$/
class ReadinessError extends Error {}
const requireCondition = (value, reason) => { if (!value) throw new ReadinessError(reason) }
const numericId = value => Number.isSafeInteger(value) && value > 0

export function verifyReadinessContext(e, checkedOutSha) {
  const expected = {
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: REPOSITORY_ID, GITHUB_REPOSITORY_OWNER: OWNER_LOGIN, GITHUB_REPOSITORY_OWNER_ID: OWNER_ID,
    GITHUB_REF: PROTECTED_REF, GITHUB_REF_TYPE: 'branch', GITHUB_REF_PROTECTED: 'true',
    READINESS_ENVIRONMENT: 'staging', RUNNER_ENVIRONMENT: 'github-hosted',
    // Approval history has no attempt binding. A fresh dispatch is required
    // rather than treating a previous attempt's approval as new evidence.
    GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW: WORKFLOW_NAME, GITHUB_WORKFLOW_REF: `${REPOSITORY}/${WORKFLOW}@${PROTECTED_REF}`,
  }
  requireCondition(Object.entries(expected).every(([key, value]) => e[key] === value), 'Readiness context rejected')
  requireCondition(SHA.test(e.GITHUB_SHA ?? '') && [checkedOutSha, e.READINESS_SOURCE_SHA,
    e.TUF_READINESS_APPROVED_SHA, e.GITHUB_WORKFLOW_SHA].every(value => value === e.GITHUB_SHA), 'Readiness source pin rejected')
  requireCondition(!e.GITHUB_HEAD_REF && !e.GITHUB_BASE_REF, 'Pull request context rejected')
  requireCondition(ID.test(e.GITHUB_RUN_ID ?? '') && ID.test(e.GITHUB_ACTOR_ID ?? '')
    && typeof e.GITHUB_ACTOR === 'string' && e.GITHUB_ACTOR.length > 0 && e.GITHUB_ACTOR.length <= 100, 'Readiness run identity rejected')
  return { sourceSha: e.GITHUB_SHA, runId: e.GITHUB_RUN_ID, actorId: e.GITHUB_ACTOR_ID }
}

export function verifyEnvironmentProtections(environments) {
  requireCondition(Array.isArray(environments) && environments.length === ENVIRONMENTS.length, 'Environment inventory rejected')
  const ids = new Set()
  return ENVIRONMENTS.map(name => {
    const matches = environments.filter(value => value?.name === name)
    requireCondition(matches.length === 1, 'Environment name rejected')
    const environment = matches[0]
    requireCondition(numericId(environment.id) && !ids.has(environment.id), 'Environment separation rejected')
    ids.add(environment.id)
    requireCondition(environment.can_admins_bypass === false
      && environment.deployment_branch_policy?.protected_branches === true
      && environment.deployment_branch_policy?.custom_branch_policies === false, 'Environment bypass or branch policy rejected')
    const rules = environment.protection_rules?.filter(rule => rule.type === 'required_reviewers')
    requireCondition(rules?.length === 1 && rules[0].prevent_self_review === false, 'Environment review policy rejected')
    const reviewers = rules[0].reviewers
    // GitHub accepts one approval from the configured reviewer list. Keep that
    // list limited to the actual owner so another reviewer cannot replace owner
    // authorization. Self-approval is intentional under HID's solo-owner model.
    requireCondition(Array.isArray(reviewers) && reviewers.length === 1
      && reviewers[0].type === 'User' && reviewers[0].reviewer?.id === Number(OWNER_ID)
      && reviewers[0].reviewer.login === OWNER_LOGIN, 'Owner-only environment reviewer policy rejected')
    return { name, id: environment.id, prevent_self_review: false, can_admins_bypass: false,
      protected_branches: true, custom_branch_policies: false,
      reviewers: reviewers.map(value => ({ type: value.type, id: value.reviewer.id, login: value.reviewer.login })) }
  })
}

export function verifyStagingApproval(history, staging) {
  requireCondition(Array.isArray(history) && history.length > 0 && history.length <= 100, 'Approval history rejected')
  requireCondition(staging?.name === 'staging' && numericId(staging.id)
    && staging.reviewers?.length === 1 && staging.reviewers[0].type === 'User'
    && staging.reviewers[0].id === Number(OWNER_ID) && staging.reviewers[0].login === OWNER_LOGIN,
  'Owner staging approval policy rejected')
  const relevant = history.filter(value => value.environments?.some(environment => environment.id === staging.id || environment.name === 'staging'))
  requireCondition(relevant.length > 0 && relevant.every(value => value.state === 'approved'
    && Array.isArray(value.environments) && value.environments.length === 1
    && value.environments[0].name === 'staging' && value.environments[0].id === staging.id
    && value.user?.type === 'User' && value.user.id === Number(OWNER_ID)
    && value.user.login === OWNER_LOGIN), 'Owner staging approval rejected')
  return [...new Set(relevant.map(value => value.user.id))]
}

export function trustedTokenRequestUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new ReadinessError('OIDC request endpoint rejected') }
  requireCondition(url.protocol === 'https:' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.actions\.githubusercontent\.com$/.test(url.hostname)
    && !url.username && !url.password && !url.port && !url.hash, 'OIDC request endpoint rejected')
  // Overwrite any inherited audience. This token must never target AWS STS.
  url.searchParams.set('audience', AUDIENCE)
  return url
}

function tokenSegment(segment, maximum) {
  requireCondition(typeof segment === 'string' && /^[A-Za-z0-9_-]+$/.test(segment), 'OIDC encoding rejected')
  const bytes = Buffer.from(segment, 'base64url')
  requireCondition(bytes.length > 0 && bytes.length <= maximum && bytes.toString('base64url') === segment, 'OIDC encoding rejected')
  return bytes
}

export function verifyReadinessToken(token, jwks, e, now = Date.now()) {
  requireCondition(typeof token === 'string' && token.length <= 32768 && token.split('.').length === 3, 'OIDC token rejected')
  const [encodedHeader, encodedClaims, encodedSignature] = token.split('.')
  let header, claims
  try {
    header = JSON.parse(tokenSegment(encodedHeader, 4096).toString('utf8'))
    claims = JSON.parse(tokenSegment(encodedClaims, 16384).toString('utf8'))
  } catch { throw new ReadinessError('OIDC JSON rejected') }
  requireCondition(header?.alg === 'RS256' && header.typ === 'JWT' && typeof header.kid === 'string'
    && header.kid.length > 0 && header.kid.length <= 128
    && !['jku', 'jwk', 'x5u', 'crit', 'b64'].some(key => key in header), 'OIDC algorithm or key reference rejected')
  requireCondition(Array.isArray(jwks?.keys) && jwks.keys.length > 0 && jwks.keys.length <= 20, 'OIDC signing keys rejected')
  const matching = jwks.keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig'
    && (key.alg === undefined || key.alg === 'RS256') && !['d', 'p', 'q', 'dp', 'dq', 'qi'].some(name => name in key))
  requireCondition(matching.length === 1, 'OIDC signing key rejected')
  let validSignature = false
  try {
    const key = createPublicKey({ key: matching[0], format: 'jwk' })
    validSignature = key.asymmetricKeyDetails.modulusLength >= 2048
      && verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), key, tokenSegment(encodedSignature, 1024))
  } catch { throw new ReadinessError('OIDC signature rejected') }
  requireCondition(validSignature, 'OIDC signature rejected')
  const expected = {
    iss: ISSUER, aud: AUDIENCE, sub: `repo:${REPOSITORY}:environment:staging`,
    repository: REPOSITORY, repository_id: REPOSITORY_ID, repository_owner: OWNER_LOGIN, repository_owner_id: OWNER_ID,
    ref: PROTECTED_REF, ref_type: 'branch', sha: e.GITHUB_SHA, environment: 'staging',
    workflow: WORKFLOW_NAME, workflow_ref: `${REPOSITORY}/${WORKFLOW}@${PROTECTED_REF}`, workflow_sha: e.GITHUB_SHA,
    event_name: 'workflow_dispatch', runner_environment: 'github-hosted', actor: e.GITHUB_ACTOR, actor_id: e.GITHUB_ACTOR_ID,
    run_id: e.GITHUB_RUN_ID, run_attempt: e.GITHUB_RUN_ATTEMPT,
  }
  requireCondition(claims && Object.entries(expected).every(([key, value]) => claims[key] === value)
    && !claims.head_ref && !claims.base_ref
    // This job is not reusable; reusable-workflow identity claims must not be
    // substituted for the direct readiness workflow's exact identity.
    && !claims.job_workflow_ref && !claims.job_workflow_sha, 'OIDC identity claims rejected')
  const seconds = Math.floor(now / 1000)
  requireCondition(['exp', 'iat', 'nbf'].every(key => Number.isSafeInteger(claims[key]))
    && claims.exp > seconds && claims.iat <= seconds + 30 && claims.iat >= seconds - 300
    && claims.nbf <= seconds + 30 && claims.nbf >= claims.iat - 30
    && claims.exp > claims.iat && claims.exp - claims.iat <= 600, 'OIDC freshness rejected')
  // Claims and token bytes are deliberately not returned to evidence writers.
  return { issuer: ISSUER, audience: AUDIENCE, subject: expected.sub, algorithm: 'RS256', signature_verified: true }
}

async function readJson(fetcher, url, headers = {}) {
  const response = await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(30000) })
  requireCondition(response.ok && !response.redirected, 'GitHub read request failed')
  let size = 0
  const chunks = []
  requireCondition(response.body, 'GitHub response body missing')
  for await (const chunk of response.body) {
    size += chunk.byteLength
    requireCondition(size <= 256 * 1024, 'GitHub response exceeds evidence bound')
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ReadinessError('GitHub response JSON rejected') }
}

export async function collectProtectedReadiness(e, { checkedOutSha, fetcher = fetch, now = Date.now() } = {}) {
  const context = verifyReadinessContext(e, checkedOutSha)
  const endpoint = trustedTokenRequestUrl(e.ACTIONS_ID_TOKEN_REQUEST_URL)
  requireCondition(typeof e.GH_READINESS_READ_TOKEN === 'string' && e.GH_READINESS_READ_TOKEN.length > 0
    && typeof e.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' && e.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0, 'GitHub runtime token unavailable')
  const headers = { Authorization: `Bearer ${e.GH_READINESS_READ_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const metadata = []
  for (const name of ENVIRONMENTS) metadata.push(await readJson(fetcher, `https://api.github.com/repos/${REPOSITORY}/environments/${name}`, headers))
  const protections = verifyEnvironmentProtections(metadata)
  const history = await readJson(fetcher, `https://api.github.com/repos/${REPOSITORY}/actions/runs/${context.runId}/approvals`, headers)
  const reviewerIds = verifyStagingApproval(history, protections.find(value => value.name === 'staging'))
  // No OIDC request occurs until source, live protections and approval pass.
  const jwks = await readJson(fetcher, JWKS_URL)
  const response = await readJson(fetcher, endpoint, { Authorization: `Bearer ${e.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` })
  const oidc = verifyReadinessToken(response.value, jwks, e, now)
  return { schema_version: 'hid.tuf.protected-readiness/v1', recorded_at: new Date(now).toISOString(),
    repository: REPOSITORY, repository_id: REPOSITORY_ID, repository_owner_id: OWNER_ID,
    source_sha: context.sourceSha, workflow_sha: context.sourceSha, ref: PROTECTED_REF,
    run_id: context.runId, run_attempt: e.GITHUB_RUN_ATTEMPT, environment: 'staging',
    governance_model: 'sole-owner-approval', owner_self_approval_permitted: true,
    approval_reviewer_ids: reviewerIds, environment_protections: protections, oidc,
    readiness_result: 'approval-and-oidc-verified', publication_result: 'not-attempted',
    cloud_mutation: false, staging_status: 'NOT ACCEPTED', data_migration: 'NOT AUTHORIZED', production: 'LOCKED',
    evidence_scope: 'GitHub staging approval and readiness-audience OIDC only; no release publication, deployment, migration, signing or staging acceptance.' }
}

async function main() {
  const e = process.env
  const checkedOutSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  requireCondition(isAbsolute(e.RUNNER_TEMP ?? '') && resolve(e.RUNNER_TEMP) === await realpath(e.RUNNER_TEMP), 'Runner evidence directory rejected')
  const result = await collectProtectedReadiness(e, { checkedOutSha })
  await writeFile(join(e.RUNNER_TEMP, 'tuf-protected-readiness.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write('Protected readiness approval/OIDC probe passed. STAGING NOT ACCEPTED; PRODUCTION LOCKED.\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never print transport errors, JWTs, raw response bodies or request headers.
    process.stderr.write(`${error instanceof ReadinessError ? error.message : 'Protected readiness probe failed'}\n`)
    process.exitCode = 1
  })
}
