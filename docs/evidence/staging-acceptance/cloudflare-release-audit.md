# Cloudflare and release staging audit

Audited source: `a709e643a731b444f7cb775b2b16fe28164146a7`. Worktree: `/home/l2e/hid-staging-worktrees/a709e643a731b444f7cb775b2b16fe28164146a7`. Date: 2026-09-08. Scope: read-only source review, locked dependency installation, local tests/build-only checks, and read-only authentication status. No source edits, uploads, deployments, DNS changes, secret/key creation, or production operations were performed by this audit.

Decision: **NOT READY**. **STAGING DEPLOYMENT AUTHORIZATION: BLOCKED**. **STAGING NOT ACCEPTED**. **PRODUCTION LOCKED**.

The user's staging mandate supersedes old source runbook statements about the then-unmerged PR and lack of ordinary CI authorization. Current merge/CI facts are established independently by the root baseline. Permanent ADR-033/ADR-035 release and isolation controls remain applicable. No old preparation JSON is treated as live evidence.

| Area | Classification | Evidence and required action |
| --- | --- | --- |
| Frontend staging isolation | PASS (source) | All seven `infra/cloudflare/workers/hid-{app}/wrangler.json` already include explicit `env.staging`, distinct `hid-{app}-staging` names, exact staging custom domains and `https://api.staging.healthidentitydirectory.com`. There is no staging apex redirect because the staging apex hosts Web. No missing routes/env source fix is needed. |
| Fixed origin and fail-closed edge | PASS (source) | `src/frontend-worker.mjs:74` binds environment/app/host/origin and validates `ORIGIN_AUTH_TOKEN`. Only `/api/v1` is proxied; forwarded headers are reconstructed, response bodies stream, redirects are manual, API caching is disabled. Cross-environment and missing-secret denial tests pass. |
| Cloudflare identity and deployment permissions | BLOCKER | Pinned `wrangler whoami` reports unauthenticated even though its process exit is 0. All inspected Cloudflare credential/account environment names are unset. Provide authorized staging-scoped credential context and independently bind account/zone ownership; never use temporary Wrangler accounts or production credentials. |
| Live staging frontend origin secret | NOT VERIFIED (deployment blocker) | No authenticated Cloudflare secret metadata readback is available. Each of the seven staging Workers requires `ORIGIN_AUTH_TOKEN`, matching the staging regional WAF origin-secret boundary. Its absence fails every request with 502 before assets. Install/verify secrets only through approved external staging secret management; record names/versions and safe negative/positive connectivity results, never secret values. |
| Live DNS, TLS, edge WAF, origin routing | NOT VERIFIED (deployment blocker) | Exact hostnames are design inputs, not observed resources. Account/zone/Worker version, certificate, API DNS/ACM/ALB, origin protection, and denied direct-origin behavior require authenticated staging inventory and actual request evidence. Shared parent-zone nameserver changes affect production and are outside this staging mandate. |
| TUF Worker isolation and bindings | PASS (source) | Dedicated `hid-tuf-staging` config, exact update custom domain, ASSETS binding, Worker-first handling, no HTML fallback, workers.dev disabled and exact-version preview enabled. No TUF R2 bucket or CloudFront distribution belongs to this architecture. |
| TUF path/cache/security policy | PASS (source) | GET/HEAD only; only versioned metadata and hash-addressed targets; staging target namespace only; no query/range requests; timestamp/no-error caching disabled, immutable content cached; security headers and PHI-free structured error logs. Tests cover the rejected paths. |
| Signed staging repository and trust | BLOCKER | Real `infra/cloudflare/workers/hid-tuf-staging/repository` and `release/local` are absent. No accepted root ceremony pin, release ID, signed candidate/metadata history, repository closure, or durable publication receipt was supplied. Existing synthetic test roots/metadata cannot authorize a release. |
| Identifier manifest | BLOCKER | Structural template check passes but strict validation exits 1 with 96 unresolved fields and `live_ownership_verified=false`, `NOT_AUTHORIZED`. Supply verified non-secret account/region/role/KMS/bucket/credential version/image/provenance/root/metadata/migration inputs; do not replace placeholders with invented values. |
| Release contracts/admission | PASS (source) | 29 tests and schema/semantic verify pass. Twelve digest-qualified OCI identities plus seven frontend trees, complete SBOM/scan/provenance and migration ledger must be admitted as one source-bound artifact set. Local unadmitted frontend builds do not complete this contract. |
| Publication orchestration | BLOCKER | Only `tuf-local-gates.yml`, `tuf-protected-readiness.yml`, and reusable-only `tuf-publish.yml` exist. There is no immutable caller/candidate-builder/attestation/signing/capability workflow arrangement or witnessed expiry canary. `docs/TUF-STAGING-EXECUTION.md:235` explicitly identifies these missing source execution parts. Implement/review the staging orchestration under the selected custody model, with exact immutable pins; an ad hoc local deploy would bypass the accepted mechanism. |
| Publication effect and replay controls | PASS (source) | Existing reusable publisher and driver bind source SHA, candidate run/artifact, protected workflow/tooling/config hashes, OIDC identity, release/artifact-set/repository hashes, and fresh durable authorization. Journal CAS intent precedes each effect; unknown results freeze rather than retry. Full local Cloudflare/release test suites pass. No live trust/cross-environment denial proof exists. |
| Irreversible trust prerequisites | BLOCKER | Object Lock resources and signing custody remain unapproved/unbound. The design proposes 90-day staging defaults and 730-day journal/evidence retention. Review concrete account-specific plan, cost/recovery and exact key custody before separately approving those irreversible actions. This audit created none. |
| TUF Worker build | PASS (synthetic source check only) | Actual pinned Wrangler 4.127.1 staging `deploy --dry-run` passed through the repository wrapper using the existing test fixture. Log explicitly marks the fixture as synthetic; it was removed afterward. No actual staging release dry-run or publish evidence exists. |
| Frontend Worker configuration/build | PASS (local source build) | Root-hosted artifacts built by the root agent passed `npm run verify` in `infra/cloudflare`; audited pinned Wrangler 4.127.1 then compiled all seven Workers with explicit `--env staging --dry-run`, exit 0. No remote secret or DNS/route readiness is proved by a dry-run. |
| Fresh npm dependency security audit | NOT VERIFIED | Both `npm audit --audit-level=moderate --json` requests failed at the npm advisory endpoint; their JSON contains no security finding/result. This is an unavailable scan, not proof of vulnerabilities or zero vulnerabilities. Independently verified exact-SHA CI audit records can supplement it. |
| Observability | WARNING / NOT VERIFIED live | TUF logs are explicitly enabled with invocation logs disabled and only bounded error fields. Frontend configs do not explicitly enable Workers observability and frontend error paths have no structured error event. Establish PHI-safe staging edge logs/metrics/alert destinations and demonstrate failures; API/Gateway observability does not alone prove edge-origin failures are visible. |
| Rollback | PASS (source design); NOT VERIFIED live | `release/config/environments.json` requires forward-only higher-sequence recovery selecting retained verified artifacts. Never use Wrangler rollback to restore old TUF metadata or clear high-water state. Previous accepted release bytes and live A/B/C recovery receipts are absent. |

Local command evidence in this directory:

- `infra-cloudflare-npm-ci.log`: locked install exit 0.
- `release-npm-ci.log`: locked install exit 0.
- `cloudflare-test.log`: 52 tests, 52 pass, zero skips/failures, exit 0.
- `release-test.log`: 29 tests, 29 pass, zero skips/failures, exit 0.
- `release-verify.log`: schema/machine configuration/semantic contracts pass, exit 0.
- `publication-workflow-verify.log`: workflow control source verifier pass, exit 0.
- `cloudflare-verify.log`: complete Worker config, pinned schema/toolchain, and root-hosted artifact verifier pass, exit 0.
- `cloudflare-frontend-staging-dry-run.log`: seven actual staging-only Worker compilation dry-runs pass, exit 0.
- `staging-identifiers-template-check.json`: structural pass, 96 missing inputs.
- `staging-identifiers-strict-check.json`: deliberate strict rejection of unfilled template, exit 1.
- `cloudflare-value-free-prerequisites.json`: presence-only environment/file status and exact workflow inventory.
- `cloudflare-whoami.log`: unauthenticated; no tokens retained.
- `tuf-synthetic-staging-dry-run.log`: pinned local build-only check exit 0, test fixture only.
- `infra-cloudflare-npm-audit.json`, `release-npm-audit.json`: endpoint errors, exit 1; no vulnerability conclusions.

The Cloudflare unit suite emits a line mentioning a production dry-run because its spawn dependency is mocked to assert argument isolation. No actual production Wrangler command or network request was performed. Ordinary source unit fixtures exercise both environment policies without touching either deployment.

Smallest safe next actions: supply existing non-secret staging cloud identity/resource references and usable scoped authentication; select/complete protected candidate, signing, caller and canary orchestration; retain exact-SHA build/SBOM/scan/provenance and independently verified tooling/config hashes; prepare account-specific trust/app plans; clear only the concrete external secret/custody/Object Lock gates; then perform admitted staging publication, application rollout, migration/restore, security and rollback validation in order. No minimal staging-only config patch found by this audit would eliminate those gates. Changing release source requires a reviewed successor source pin; never describe changed artifacts as the approved original SHA.

Current official references retrieved on 2026-09-08:

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): Worker review patterns and safe observability.
- [Wrangler Worker commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/): distinguish build-only dry-run from upload, deployment and trigger mutation.
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/): environment-specific non-inherited variables, assets and observability. This source has no vars inheritance gap because every frontend staging environment supplies its exact values.
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/): custom-domain creation provisions DNS/certificates and matches exact hosts; source declarations cannot prove live TLS/route readiness.

The installed audited Wrangler schema and executable hashes are checked by the source verifier. Registry lookup reported newer Workers types `5.20260908.1`, and Wrangler printed an available `4.130.0` update; the approved source pins (`5.20260831.1`, `4.127.1`) remain unchanged. No unreviewed toolchain update was performed. These references guide review; they are not evidence that any Cloudflare resource was deployed.
