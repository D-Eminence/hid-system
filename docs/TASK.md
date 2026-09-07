# Current HID Platform Task

## Current authoritative stage — 2026-09-07

**PHASE C LOCALLY VERIFIED AND COMMITTED — STAGING NOT ACCEPTED**.

GitHub protection preparation now has live, read-back-verified PR/check/no-bypass
rules on `main` and `tuf-production-release`, restricted SHA-pinned Actions,
external-contributor approval, and four distinct staging/production and publisher
environments. All use the verified owner with self-review/admin bypass disabled;
independent reviewer coverage remains missing. CODEOWNERS and readiness source
are local preparation only. **PROTECTED CI READINESS: BLOCKED**.

Ordinary run `34103460898` failed (four jobs passed, three failed). Two local
fixes address missing EHR shared dependencies and an unsafe test-fixture
executable assumption; isolated EHR build/tests, Cloudflare 52 tests, actionlint,
full `npm test` and `npm run verify` pass. No remote rerun or protected run was
performed. Exact state, changes and remaining inputs are recorded in the
[canonical protection milestone](TUF-PRODUCTION-IMPLEMENTATION.md#github-protection-preparation--2026-09-07)
and [non-secret prerequisites](../release/config/protected-ci-prerequisites.json).

## Historical Phase C commit and push records

Original implementation previous SHA: `abc77af52f1c09831e1fcdb9c3ba1aaafd0f60b0`.
Phase C implementation SHA: `46e76cecf9e846061203c8fd68a0fcfd0c2825a5`.
Message: `Implement TUF release trust and prepare protected staging gates`.
Commit timestamp: `2026-09-07T04:11:04+01:00`. Branch: `tuf-production-release`.
The original local commit includes the 193 reviewed files; no amend/history
rewrite occurred. Every committed blob matches the approved inventory.
The unrelated `docs/SECURITY.md` edit remains untouched and excluded.
Pre-/post-commit diff, scope, evidence and security checks pass with zero secret
findings. Prior local suite results remain recorded in the canonical document.

The separately authorized correction sets immutable journal/evidence retention
to **2 years (730 days)** and is now committed:

| Correction commit evidence | Verified value |
| --- | --- |
| Previous SHA | `46e76cecf9e846061203c8fd68a0fcfd0c2825a5` |
| New correction SHA / HEAD | `ba2cd3290e7c1fe72817c3bdfb806dd306b2c633` |
| Exact message | `Correct immutable evidence retention to two years` |
| Commit timestamp | `2026-09-07T09:48:21+01:00` |
| Scope and statistics | Exactly 22 reviewed files; 789 insertions and 159 deletions |
| Verification | PASS: every reviewed blob hash, parent, single new commit and recomputed commit object hash |

The original commit retains the superseded proposal as history. The correction
covers Go implementation, IAM/configuration, tests, plans and runbooks; its exact
paths and reviewed hashes are in
[retention evidence](evidence/tuf-phase-c/retention-correction.json), resolved at
the new correction SHA. Its pre-commit status fields are historical and are
superseded by this record.

All requested checks were rerun before committing: 58 AWS tests/typecheck,
Go 1.26.8 normal/race/vet/module verification, 24 release tests, configuration
and security validation, both synthetic plans and five paired builds passed.
No active obsolete retention settings or secrets/private signing material were
found. The index was empty before staging, and status/diff/cached-diff/whitespace
checks passed. Immediately after committing, only ` M docs/SECURITY.md` remained
and the index was empty. The original commit was not amended or rewritten.

`git log -2 --oneline`:

```text
ba2cd32 Correct immutable evidence retention to two years
46e76ce Implement TUF release trust and prepare protected staging gates
```

At the correction-commit milestone, the two canonical records remained
unstaged/uncommitted alongside the untouched unrelated SECURITY edit. The later
GitHub-preparation request separately authorizes a new logical local commit; no
additional push is authorized. Exact historical commit evidence is recorded
in the [canonical implementation record](TUF-PRODUCTION-IMPLEMENTATION.md).

```text
PHASE C IMPLEMENTATION: COMMITTED
RETENTION CORRECTION: COMMITTED
PUSH: COMPLETE
PROTECTED CI: NOT RUN
GITHUB PROTECTIONS: PARTIAL — OWNER REVIEWER COVERAGE PENDING
OBJECT LOCK: UNAPPROVED / NOT CREATED
STAGING: NOT ACCEPTED
DATA MIGRATION: NOT AUTHORIZED
PRODUCTION: LOCKED
```

- The separately authorized exact-history push is complete; no AWS or Cloudflare mutation occurred.
- No protected CI run exists; branch/Actions/environment settings are active, with independent reviewer coverage and remote CODEOWNERS still pending.
- Exact AWS/Cloudflare identifiers remain pending.
- **OBJECT LOCK: UNAPPROVED / NOT CREATED**; retention correction grants no creation authority.
- Signing/custody and candidate/signing/canary execution review remain pending.
- Live restore and live rollback remain unverified.
- Staging authorization remains pending; **STAGING NOT ACCEPTED**.
- **DATA MIGRATION: NOT AUTHORIZED. PRODUCTION: LOCKED.**

Push completed at `2026-09-07T08:58:39.696382+00:00` to configured repository
`https://github.com/D-Eminence/hid-system.git`, branch `tuf-production-release`.
At `2026-09-07T08:59:27.303148+00:00`, independent `git ls-remote` and GitHub API
checks both verified remote HEAD equals local HEAD:
`ba2cd3290e7c1fe72817c3bdfb806dd306b2c633`, with parent
`46e76cecf9e846061203c8fd68a0fcfd0c2825a5`. The upstream is
`origin/tuf-production-release`, 0 ahead and 0 behind. Only the target branch
was created; before/after remote heads and tags show no unexpected changes.

Executed command (exit 0):

```sh
git push --porcelain --no-follow-tags --recurse-submodules=no --set-upstream origin refs/heads/tuf-production-release:refs/heads/tuf-production-release
```

No force, history rewrite, amend, tags, releases or additional commit occurred
during that original push.
The two existing commits preserve the exact reviewed scopes; all 215 changed
committed blobs were scanned with zero secret/private-signing-material findings.
The existing SECURITY edit remains untouched and excluded. Both canonical
documentation updates remain unstaged/uncommitted and were not pushed.

The push automatically started ordinary credential-free
[TUF local security gates](https://github.com/D-Eminence/hid-system/actions/runs/34103460898),
observed `in_progress` at the verification time above. No workflow was manually
dispatched and no protected workflow ran. No completed CI result or staging
acceptance is claimed; monitoring did not continue under this authorization.
The canonical implementation record retains the full push evidence and hashes.

Current next action: owner-supplied independent reviewers and production
approval coverage, then separately authorized exact-SHA publication of the local
preparation through a review branch/protected PR. Keep branch and environment
protections intact. Successful ordinary CI, default-branch dispatch availability,
a staging-only approved SHA variable and explicit readiness dispatch remain
required. No protected CI or cloud action follows automatically.

## Historical implementation trail

Continuation on 2026-09-05: a read-only pending-publication authorizer now
reloads durable state twice, exact-matches both predecessor and candidate
metadata, reserves the 30-minute freshness margin, and emits a five-minute
decision bound to state revision and all role hashes. Focused signing-broker
tests pass, including recovered version-3 authorization over an expired
version-1 predecessor, superseded-output rejection, changed metadata,
concurrent state changes, slow reads, cancellation, and clock rollback.
The read-only `hid-tuf-publication` operator and upload/deploy/initial-route
integration now use that decision. Upload/deployment receipts are schema
`2.0.0`; preview trust is bound to the broker bootstrap root and exact versions.
Uploads use a private, revalidated copy. The 12 focused publication/preview
tests pass, including authorization failure, changed operator pins, caller
edits during upload, malformed output and expired decisions. AWS typechecking
and all 54 infrastructure tests pass; the publisher gains only exact state
reads and S3-context-bound decryption, with no state writes or signing.
Root `npm test` and `npm run verify`, release 9/9 tests plus contract verification,
and EHR 5/5 tests also passed on this working tree. Root checks preceded the
latest wrapper/IaC edits, which have their focused tests. Per-environment
publication serialization, final combined gates, and pristine
checkout evidence remain under implementation. No cloud API was called.

Recovered materialization now also passes its full policy path: the ordinary
operator rejects a version-1-to-3 online gap; the state-authenticated constructor
accepts the exact pending version 3, retains published version 1, excludes
superseded private version 2, and reauthorizes before its atomic directory
commit. The independent Node validator agrees on the whole repository hash.
Failed final authorization leaves no destination or temporary generation.
All 12 Go packages pass the validator-backed run (10 tested, 2 with no tests),
and the updated complete Cloudflare suite passes 49/49 plus configuration
verification. Cross-publisher serialization remains a required live gate;
fresh authorization alone is not a distributed lock.

Continuation review: the full root `npm run build` and validator-backed Go
race suite, `go vet`, and `go mod verify` passed. All four local TUF commands
produced identical bytes across paired builds; the publication binary was
rebuilt after the subsequent predecessor-pin and confirmation changes. Receipt
paths are now checked before any mutation; malformed preview artifact hashes
cannot reach deployment, and a
deployment receipt's release must match its authorization. All 51 Cloudflare
tests pass. A separate protected predecessor repository hash now prevents a
pruned but otherwise valid predecessor from discarding published history;
the Go regression passed, including the full 12-package race run, vet and module
verification. A direct Cloudflare config check after the normal subpath build
correctly rejected its non-root artifact paths; `npm run verify` rebuilt them
through its declared prerequisites and the complete `npm run verify` passed.
A subsequent root `npm test` initially stopped at an Admin test-teardown error after all
19 assertions passed (`window` disappeared before a queued React commit);
that run remains recorded as failed. The cause was missing Testing Library
cleanup with Vitest globals disabled. Explicit teardown plus an empty-DOM
regression check now passes Admin typechecking and five consecutive 19/19
runs. The corrected full root suite passed. The read-only post-canary `confirm`
operation passes focused Go tests: pending metadata, non-advanced revisions,
substitution, concurrent state changes, cancellation, clock rollback and
freshness-floor crossings are rejected without state writes. Durable serialized
orchestration remains the next local boundary. The corrected full root
`npm test` now passes, including all 54 AWS tests. No cloud mutation occurred.

The storage-independent publication journal now passes seven race-enabled test
groups. It claims one attempt per environment before external mutation, binds
the exact authorization/predecessor/candidate/operator identity, records ordered intent
and receipt transitions, and closes only on fresh exact post-canary confirmation.
Unresolved attempts cannot expire, be stolen, or automatically resume after restart.
Tests cover 32 competing claims/intents, interruption at all 11 pre-completion
phases, lost commit responses, post-commit cancellation, stale owner/revision,
bootstrap-only parent creation, and successor predecessor-hash continuity.
All 13 Go packages pass the validator-backed full race run (11 tested, 2 without
tests), vet and module verification; parent-stage refinements also pass focused
race tests. The four commands remain reproducible and their final hashes are
recorded in the canonical runbook.
This journal is separate from the signing checkpoint; no publisher checkpoint
write grant is authorized. Durable storage, wrapper orchestration and live
concurrency evidence remain required before this can protect actual deployment.

Work is isolated on `tuf-production-release`, created from clean audited source
`abc77af52f1c09831e1fcdb9c3ba1aaafd0f60b0`. Three independent read-only audits
and a primary-agent inspection found no existing TUF metadata, generator,
publisher, verifier, client state, signing adapter, attack suite, or active
repository-root CI workflow. No cloud, DNS, external database, staging, or
production system was contacted or changed, and no signing key was generated,
imported, printed, or stored.

The governed release surface is twelve OCI identities (eleven ECS workloads
plus the EHR migration image) and seven independently deployed Cloudflare
frontend artifacts. The existing manifest authenticates only the twelve image
records. There is no end-user software updater; the release operator/deployer
is the correct TUF verification boundary. Clinical downloads and exports are
not software updates and remain outside TUF. The clinical document bucket's
`release-evidence/` prefix is not a safe TUF boundary because application roles
can access that bucket broadly; trusted repository/evidence storage must be
separate and inaccessible to ECS runtimes.

The supplied upstream go-tuf example client remains a test/interoperability
oracle, not an HID production updater. Its installed Linux/amd64 binary at
`/opt/hid-release-tools/tuf-client/2.4.2/tuf-client` was reverified at 12,857,047
bytes with SHA-256
`6933984fa57625a361896db52b9eb8fdd9658f98327b7bd44d806096114fb351`.
The pinned `go1.25.0` binary SHA-256 is
`b93cdfdbc72f1afc3f21498c80bf3d155a44a9b95e2d690c940511051574bc25`;
it was byte-compared with the binary inside the official
`go1.25.0.linux-amd64.tar.gz` distribution whose SHA-256 is
`2852af0cb20a13139b3448992e69b868e50ed0f8a1e5940ee1de9e19a123b613`.

Local implementation now includes a repository-owned go-tuf v2.4.2 verifier
with pinned bootstrap trust, private durable rollback state, an exclusive state
lock, strict HTTPS/origin/path bounds, deterministic USTAR frontend
pack/extract, and disposable P-256 attack repositories. A review found and the
implementation corrected a critical cross-invocation root-rotation defect: the
client now checkpoints and reloads the latest verified root and rejects replay
under a revoked timestamp key. Its strict batch command resolves a complete
target set through one authenticated refresh before output writes and rejects
overlapping destinations. It also rejects duplicate/trailing JSON,
post-archive payloads, non-USTAR input, link traversal, destination overwrite,
and unsafe target paths. Race-enabled tests and `go vet ./...` pass.

Strict Draft 2020-12 release/channel/frontend/evidence schemas and a semantic
machine contract now compile under AJV strict mode, bind the exact twelve OCI
and seven frontend identities, and cap every public target at Cloudflare's
25 MiB Static Assets limit. Bundle admission now requires exact caller-supplied
environment/account/region/release/Git/admission-time context, recomputes the
artifact-set hash, validates the six mandatory promotion evidence types and
their chronology, and emits a deterministic digest-only deployment plan.
Bounded no-follow duplicate-key JSON parsing and mutation tests cover identity
confusion, target substitution, frontend path attacks, evidence substitution,
expiry/order failures, and the formerly unbound CLI path. `npm --prefix
release test` passes 9/9 and `npm --prefix release run verify` passes. The
end-to-end admission command also pins the verifier executable hash, downloads
the complete post-bundle set through one bounded strict batch request,
independently rechecks every TUF target, validates/extracts frontend content,
and emits an exclusive fsynced plan record; it accepts no raw image or frontend
deployment override and never seals evidence after partial batch failure.

The Cloudflare publication boundary now passes 51 local tests. It verifies
go-tuf-compatible OLPC signatures/key IDs, exact role thresholds and ten
distinct cryptographic keys, metadata/target closure and freshness, immutable
release targets, hostile repository layouts, exact version upload/preview
receipts, 100-percent deployment, and separate route activation. The wrapper
uses audited local Wrangler 4.127.1 bytes; no Cloudflare API was called. A
credential-free five-job CI workflow is present and locally linted, but has not
yet produced a real clean-checkout GitHub run.

The AWS release-trust source now passes all 54 infrastructure tests with eight
distinct OIDC capabilities, Object-Locked KMS-bound archives, isolated P-256
signer candidates, and a fixed five-function signing/checkpoint broker. No
GitHub-assumable role can call `kms:Sign`: each protected signing identity can
write only its candidate request namespace and invoke one exact immutable
Lambda version. Runtime signing is bound to canonical versioned request bytes,
the exact root/state/candidate pins, one KMS key, `DIGEST` plus
`ECDSA_SHA_256`, and the exact unqualified source function ARN. DynamoDB CAS
state is paired with a 730-day Object-Locked S3 manifest chain. Checkpoint
schema `2.0.0` and state-manifest `v3` persist independent snapshot and
timestamp version high-water marks, so an exposed pending version remains
consumed when stale metadata is superseded. Completed decision indexes are
create-only and are accepted only when their exact request
provenance and metadata references appear in the reachable journal at the
original state revision; replay after publication returns those retained bytes
without another signer call. Tests reject lost-index, substituted-version,
altered-output, expired-history, and unauthenticated-head cases. ECR retrieval
is deny-bounded to the exact five functions and reviewed account, CloudTrail
selects those five functions, and every broker alarm targets the exact imported
environment SNS topic. The stack remains deliberately uninstantiated; no AWS
call or key creation occurred. The EHR cache-generation correction passes 5/5
focused tests and local build verification: its generated worker is
exact-Git-SHA bound, preloads the complete shell, and treats the stable
canonical runtime network-first. Focused AWS and EHR npm audits are now clean
after compatible CDK and build-tool updates. The provider-neutral repository
constructor now validates the exact ten-key root policy and sequential root
rotation, creates the canonical targets payload, imports exactly 2-of-3
context-bound offline signatures, and constructs snapshot/timestamp metadata
only after authorizing the supplied signer against the selected root role. The
local operator now builds an exclusive whole repository generation, binds all
four planned versions, requires and hashes the exact predecessor, validates its
full retained root/metadata/target closure, and produces bytes accepted by the
independent Node validator with the same repository hash. Ordinary online
preflight enforces a narrow wall clock, JSON-safe versions, authenticated
previous root and role metadata, exact output increments, and
unchanged-or-one selected-input transitions before AWS initialization. Only
the stateful broker may advance one from its protected online-role high-water.
It preserves exact archived replay without KMS, clears a dependent stale
timestamp when replacing a snapshot, and never reuses either burned version.
New signing also reserves a 30-minute publication margin, checks root/targets
or the complete authorized snapshot context before KMS, and rechecks the
request and complete output immediately before CAS. Offline targets evidence
now carries a
same-custodian domain-separated attestation over the full request, TUF
signature, and signing time. Component-wise descriptor reads reject ancestor
symlinks. Validator-backed tests across all 12 Go packages, the full race run,
`go vet ./...`, and `go mod verify` pass after the recovery change. The
ordinary generation plan and materializer deliberately remain strict `+1`
boundaries: a gapped recovered generation must not be uploaded until a
publisher reloads and exact-matches the durable pending checkpoint immediately
before upload and again before deploy. That hook is implemented locally;
serialized publication, remaining failure coverage, the clean-checkout gate, and
every live staging, migration, restore, rollback, and monitoring proof remain
open gates, not accepted risk. Recovery also fails closed if an
already-unpublished next root or targets expires; retained intermediate offline
lineage/manual recovery is not implemented.

Architecture and local implementation may continue without external access.
ADR-035 now fixes the implementation boundary: isolated staging/production
roots and durable client state; public read-only whole-generation Cloudflare
TUF repositories at the two dedicated `updates` hostnames; a separate private,
versioned, KMS-encrypted, object-locked AWS evidence archive with no ECS access;
2-of-3 offline production root/targets custody; independently authorized
KMS-backed snapshot/timestamp freshness; pinned-root noninteractive release
verification; exact staging artifact promotion; and only forward-version
rollback. The technical KMS baseline is P-256 ECDSA/SHA-256 because that is the
direct stock go-tuf v2.4.2 interoperability path. No key was created.

Production key creation requires an approved algorithm, custody, provider,
threshold, recovery, and ceremony decision. Live work remains ordered and
mandatory: successful staging TUF/application deployment and adversarial
validation, migration dry-run and staging-copy migration, backup/archive
restore and forward-version rollback proof, monitoring proof, and only then an
explicitly approved production action. The canonical evidence and gate ledger
is `docs/TUF-PRODUCTION-IMPLEMENTATION.md`.

## Previous authoritative stage — 2026-08-14

Classification: **CLEAN-CHECKOUT VERIFY PREREQUISITE CORRECTED LOCALLY;
NO DEPLOYMENT IS AUTHORIZED**.

Release candidate `4aca7933ae1e041fdacca432fa5cbf98658ddaa7` passed the
mandatory pristine-checkout root `npm test` before any root build, including
the automatic API-client prerequisite and all 19 Admin tests. Its complete
release provenance run then stopped correctly because root `npm run verify`
did not declare the generated artifacts required when verification precedes
the root build. The first failure was the seven governed frontend artifacts
required by `verify:secret-readiness`; isolated fresh-checkout validation also
confirmed that the unchanged container verifier requires all ten backend
`dist` artifacts.

The secret-readiness verifier's security intent is correct: canonical source
and all seven built Cloudflare frontend artifacts must be scanned, and a
missing required artifact must not be treated as a pass, skip, or warning. The
deterministic lifecycle correction is isolated on
`release-verify-reproducibility-fix` and makes root verification reuse the
existing governed Cloudflare artifact build plus the ten existing backend
builds before running the unchanged verification suite. No application, AWS
IaC, cost-safety, database, migration,
Cloudflare topology, or security rule is changed. No deployment or AWS,
Cloudflare, ECR, Hostinger, HID 1.0, provider, DNS, or production-resource
mutation has occurred.

## Previous authoritative stage — 2026-08-14

Classification: **CLEAN-CHECKOUT TEST PREREQUISITE CORRECTED LOCALLY;
NO DEPLOYMENT IS AUTHORIZED**.

Release candidate `328faee9522f66051067c9a522725e4b7e370f8d` remains blocked
for promotion because its first clean-checkout provenance run exposed an
incomplete root test prerequisite: Admin consumes `@hid/api-client` through
the package's generated `dist` entrypoint, but root `npm test` did not build
that package first. The failure was a build/test orchestration defect, not an
application runtime, AWS, Docker, container-security, or deployment failure.

The deliberate correction is isolated on `release-reproducibility-fix` and
makes the root test lifecycle build only the required generated API-client
prerequisite before running the unchanged test suites. A semantic repository
assertion protects that lifecycle, the compiled package contract remains
unchanged, and generated `dist` output remains untracked. No AWS, ECR,
Cloudflare, Hostinger, HID 1.0, provider, DNS, external database, or production resource
has been accessed or mutated. A new committed SHA must pass clean-worktree
`npm test` before `npm run build`, after which the complete release provenance
gate restarts from that new exact SHA.

## Previous authoritative stage — 2026-08-14

Classification: **COST-SAFE ELASTIC AWS STAGING CONTROLS IMPLEMENTED IN SOURCE;
NO DEPLOYMENT IS AUTHORIZED**.

The work is isolated on `aws-cost-safety`, created directly from accepted
security-remediated release source
`6a247e5ecac5b34947c924bc75b6ca9d54c96733`. Production quality controls remain
intact: three AZs, Multi-AZ private encrypted PostgreSQL, deletion protection,
35-day backup/PITR retention, KMS/TLS/WAF, full endpoints, two ALBs, multiple
replicas, per-service autoscaling, immutable rollback images, RLS/audit/workload
identity, observability and provider isolation. The existing 3-AZ/2-NAT
production shape is unchanged; a third NAT or alternate egress is a measured
future capability, not an unapproved cost increase.

Staging now requires explicit `sleep`, `economy`, or `fidelity` mode. Sleep has
zero ECS desired tasks and no ALB, WAF association, NAT, interface endpoint,
public load-balancer IPv4, or autoscaling target while retaining protected RDS
storage/backups, S3/KMS, secrets, ECR, logs, EventBridge/SQS and metadata. Its
guarded operation stops the exact staging RDS instance; a staging-only,
exact-ARN, zero-retry daily schedule handles AWS automatic restart. Economy is
the bounded two-AZ/one-NAT/single-AZ-small-RDS default. Fidelity restores two
NATs, full two-AZ endpoints, Multi-AZ RDS and multiple replicas for release,
failover, load, migration, provider and rollback exercises. Sleep is explicitly
not zero cost.

Every service has typed CPU/memory, pool size, desired/minimum/normal maximum,
separately reviewed emergency maximum, scaling signal/target and cooldown.
Synth fails an unsafe normal or emergency database connection sum without
raising PostgreSQL `max_connections`. Request, notification, OCR and dispatcher
backlog/latency/drain visibility are mode-aware and PHI-free. No permanent
million-user ceiling or untested capacity claim is introduced.

Clinical and legacy document versions have no generic lifecycle expiration;
temporary, release-evidence and test/staging prefixes are separately governed.
OCR reuses an exact completed source/processing contract, uses a deterministic
Textract PDF start token, distinguishes unknown outcomes, and emits bounded
pages/retries/failure/duplicate signals without reducing clinical quality.
No migration `0029` is needed.

The optional cost-governance stack models cash exposure with credits and gross
consumption without credits, using required email/optional SNS threshold alerts
and account/service plus `Project=HID` anomaly detection. It creates no Budget
Action or automatic shutdown. The $10,000 Activate planning balance and
$416.67/month 24-month reference are not spending targets; the earlier $1,000
runway assumption is corrected. Deterministic quantities are committed in
`infra/aws/cost-inventory.json` without fabricated prices.

All AWS, ECR, Cloudflare, Hostinger, HID 1.0, provider, DNS and production-data
operations remain externally pending. The guarded staging commands require
exact account/region/SHA/confirmation, clean source, readiness, migration,
queue/outbox, billing, RDS-state and CDK-diff gates; their names never silently
deploy.

## Current authoritative stage — 2026-08-13

Classification: **CONTAINER CRITICAL/HIGH REMEDIATED LOCALLY; NO DEPLOYMENT IS
AUTHORIZED**.

The failed local release-artifact candidate
`df4f41328375c9a2235c2e6d48dd482ff6f432af` remains preserved unchanged on
`staging-readiness`. Remediation is isolated on
`release-security-remediation`, created directly from that candidate. Neither
`platform-baseline` nor `main` has been changed. No tag, Cloudflare, AWS, ECR,
Hostinger, HID 1.0, external database, or notification-provider action is
authorized by this stage.

Docker Scout 1.24.0 found three critical and nine high findings in the failed
Identity and EHR final images. SARIF locations attribute the npm findings to
the old Node base image's bundled npm tree (`brace-expansion`, `picomatch`,
`sigstore`, `ip-address`, and `tar`) and the Debian findings to the Bookworm
Perl base package; they do not attribute a critical/high finding to HID
application dependencies. The failed source, report locations, and exact CVE
disposition are retained in `RELEASE_FINDINGS.md`; no exception was created.

All ten Node-service final stages and the separate EHR `migration` target now
use the pinned `gcr.io/distroless/nodejs22-debian13` digest, retain
Bookworm-only build and production-dependency stages, copy only production
dependencies plus compiled output into final images, run as UID/GID 65532, and
use Distroless-compatible Node command and health-check forms. The static
container policy pins this final-stage contract. Representative local Identity
and EHR images built successfully, loaded `argon2`, `pg`, and the shared API
client where applicable, reached ready/healthy state as UID 65532, and exited
cleanly on SIGTERM. Their Docker Scout SARIF reports contain zero findings.

The pattern was then proven across all twelve governed targets. All ten Node
services plus EHR `migration` report zero Scout vulnerabilities. Gateway was
independently pinned to
`nginxinc/nginx-unprivileged@sha256:334d92979f15aaecd5dd50af5105e1230e2bb70765d45b1e2f964e7c5eda81c3`
and reports zero critical/high findings. All twelve images built, generated
checksummed SPDX SBOMs, ran non-root, and produced zero high-confidence final
filesystem secret findings. Node final filesystems contain no npm, Perl, or
shell. Gateway remains API-only and shuts down with SIGQUIT.

Container topology acceptance passed for seven APIs, two OCR workers, two
event dispatchers, the disabled-provider Notification Worker, Gateway, and the
migration target. Six database-backed APIs and both dispatchers failed
readiness closed during a disposable PostgreSQL outage and recovered without
restart. Two OCR replicas resumed authorized claim polling through a non-owner
login. Runtime acceptance exposed and corrected Notification API optional
provider injection and disabled Notification Worker SIGTERM handling; both
rebuilt images retained zero critical/high findings and passed their runtime
contracts. No live provider or external system was contacted.

The local artifact evidence is valid only when regenerated from the exact
clean remediation commit. Images, SBOMs, scans, and frontend checksums from
`df4f41328375c9a2235c2e6d48dd482ff6f432af` remain diagnostic history and are
never promotable. See `RELEASE_ARTIFACT_GATE.md` and `RELEASE_FINDINGS.md`.

## Previous authoritative stage — 2026-08-12

Classification: **STAGING ISOLATION IMPLEMENTED LOCALLY; EXTERNAL ENVIRONMENT
VERIFICATION PENDING**.

The immutable canonical source baseline is commit
`4f5e5140b33cf351962dad9903459d20c51f8f0a` on `platform-baseline`; it is
preserved unchanged. The staging-isolation release-source successor is prepared
on `staging-readiness` without a merge to `main`. No Cloudflare Worker, DNS,
Turnstile widget, AWS resource, Hostinger setting, HID 1.0 system, provider, or
production database has been changed.

Seven Cloudflare Workers now require an explicit named `production` or
`staging` environment. Each deployment environment binds one exact application
host, an allowlisted `API_ORIGIN`, and an application identity. Production
continues to use `api.healthidentitydirectory.com`; staging uses only
`api.staging.healthidentitydirectory.com`. The Worker rejects missing or
mismatched environment configuration and does not derive an upstream from the
browser request, Host header, path, or query. It accepts only `/api/v1/*`,
preserves request method/body and required Origin/CSRF/correlation evidence,
and applies `private, no-store` controls to API responses.

`ORIGIN_AUTH_TOKEN` remains a Worker secret binding, never a Wrangler `vars`
value or frontend artifact. Production and staging require independently
generated external values and AWS now requires respectively named no-echo WAF
inputs. Both configuration boundaries fail closed if absent. Identity uses a
required `HID_DEPLOYMENT_ENV` profile in runtime production mode so server-side
Turnstile Siteverify accepts only the corresponding production or staging
hostname/action matrix while retaining host-only cookies. The existing
production Turnstile widget remains untouched; a staging widget and its
independent site-key/secret pair are external prerequisites.

AWS typed profiles derive public API hostnames and CORS origins from the
environment: staging produces only `api.staging` and the seven staging browser
origins, while production produces only `api` and the approved production
origins. CloudFront remains absent; the topology remains eleven ECS services,
eleven ECR repositories, and twelve governed image identities.

Local Worker tests/config checks, Identity Turnstile tests/typecheck/build,
and development/staging/production offline IaC synth-policy checks pass. A
real Wrangler `deploy --dry-run` is scripted for both environments but has not
run in this session because the local approval system rejected its package
download before execution; no Cloudflare action was attempted. Final root,
database, and release-source checks remain in progress for this stage.

## Previous authoritative stage — 2026-08-12

Classification: **IMPLEMENTED, EXTERNAL ENVIRONMENT VERIFICATION PENDING**.

This section supersedes conflicting deployment statements in the older
checkpoint ledger below. HID 1.0 remains the production authority. This stage
performed no deployment, DNS change, live provider call, production-data
connection, migration, Git commit, or Git push.

## Pre-release secret audit and Git baseline readiness — 2026-08-12

Classification: **LOCAL AUDIT COMPLETE, EXTERNAL SECRET ADMINISTRATION
PENDING**. `docs/SECRET_ROTATION_AND_BASELINE_READINESS.md` is authoritative
for this stage. The canonical-source and built-frontend audit reports zero
high-confidence secret findings; it checks private keys, cloud/session tokens,
hosting and provider credentials, database URLs/passwords, service-account
material, signing keys, cookies, and raw non-test NIN values without printing
values. Browser builds are limited to the public `VITE_` configuration prefix;
server secrets are rejected from source and artifacts.

The active Vercel preview/production workflows were removed. Their prior
`VERCEL_TOKEN` reference was a name only, not evidence of a committed token;
the external Vercel/GitHub secret must nevertheless be revoked as retired
deployment hygiene. Supabase anonymous/browser telemetry identifiers found in
ignored local configuration are public identifiers, not evidence of a service
credential exposure. Local database/authentication values remain ignored and
must be regenerated before any shared-environment reuse. Cloudflare, AWS,
provider, NIN, and target secret-store interfaces contain no discovered value;
they require approved external minting/configuration before deployment.

All required local verification gates passed in this audit. The fresh
authorized `acceptance:container:database` run used a disposable PostgreSQL
16.14 cluster, applied `0001` through `0028`, left zero pending, passed schema,
RLS/ownership, non-owner denial, verified-TLS, outage/recovery/SIGTERM, OCR
Worker and Event Dispatcher concurrency checks, then removed the temporary
cluster. No external database or provider was contacted.

`main` has one initial README-only commit and an empty index. Separate legacy
refs are not ancestors of `main`; they require explicit maintainer review before
any push. `.gitignore` and `.dockerignore` exclude generated/local material and
the preserved `identity/`/`upstream_snapshot/` historical directories while
allowing `.env.example` templates. No stage, commit, push, tag, deployment, or
provider mutation was performed. `scripts/verify-migration-ledger.mjs` pins
accepted checksums for `0001`–`0028`; migration `0028` remains the approved
additive OTP/identity/notification state migration, with no plaintext OTP,
device token, notification body, raw contact value, or raw NIN persistence.

Local acceptance for this stage is complete. Root tests pass **345 tests**;
the standard local build, Cloudflare host-root build, root verification,
Cloudflare Worker tests/config checks, migration-fixture reconciliation,
telemetry/convergence scans, and AWS development/staging/production synth and
policy checks pass. Docker is **AVAILABLE** (server 29.7.2); the disposable
PostgreSQL 16.14 acceptance applies `0001` through `0028`, leaves zero pending,
passes schema/RLS, eight non-owner login/denial checks, verify-full TLS, six API
health/outage/recovery/SIGTERM checks, two OCR Workers, and two Dispatchers,
then removes the temporary cluster. Final release image builds, digests, SBOMs,
image scans, and live cloud/provider validation were intentionally not run.

The accepted target is now:

- Hostinger remains registrar.
- Cloudflare owns authoritative DNS/TLS after a future approved nameserver
  cutover, seven independent Workers Static Assets applications, Turnstile,
  edge security, and the same-origin `/api/v1/*` proxy.
- `healthidentitydirectory.com` redirects to
  `www.healthidentitydirectory.com`; `www`, `ehr`, `lab`, `pharmacy`, `ocr`,
  `outreach`, and `admin` each map to their own Worker and build artifact.
- Browser traffic uses relative `/api/v1/*` paths. The Worker accepts only that
  API namespace and one fixed origin,
  `https://api.healthidentitydirectory.com`; API responses are never shared-
  cached. Sessions use host-only Secure/HttpOnly cookies in production.
- AWS owns the regional API origin, ECS/Fargate services, private PostgreSQL 16,
  private versioned S3, KMS, Textract, EventBridge, SQS, notification workloads,
  audit, and operational telemetry. CloudFront and the former static-serving
  Gateway image are removed from the target. Gateway remains an API-only
  routing service behind the regional WAF-protected ALB.
- Identity is the sole human authentication and patient authority. The active
  runtime supports local imported credentials and OIDC only. Direct hosted
  legacy/Supabase password and identity proxies were removed. A safe legacy
  session exchange cannot be proven from repository evidence, so it is
  explicitly rejected; migrated accounts without compatible hashes continue
  through a six-digit verified-contact OTP without creating a second patient.
- Identity owns purpose-bound six-digit OTP challenges. Only HMAC verifiers and
  challenge evidence are durable. OTP delivery goes directly to Notification
  API: SES/Termii/Meta primary and Infobip fallback. Unknown primary outcomes do
  not trigger duplicate fallback. Authentication OTP never enters Novu.
- Ordinary minimum-necessary notifications use transactional outbox -> Event
  Dispatcher -> EventBridge -> encrypted SQS -> Notification Worker -> Novu.
  FCM is the server-side web/mobile push boundary. Notification content remains
  generic and PHI-minimal.
- Brevo is retired. Vercel is HID 1.0 hosting history only. Supabase is a
  protected, read-only HID 1.0 migration source only; none is a target runtime.
- Additive migration `0028_identity_notification_migration_state.sql` is
  justified by OTP challenge/rate-limit state, progressive assurance, legacy
  identity mapping evidence, encrypted device registrations, and delivery
  reconciliation. Applied migrations `0001` through `0027` remain immutable.
- Legacy migration staging/promotion/reconciliation is idempotent,
  checksum-aware, resumable against the same controlled snapshot, and supports
  an offline fixture dry run without a production connection. Existing patient
  UUIDs and HID codes are preserved explicitly.

External evidence remains required for Cloudflare DNS/routes/site keys/secrets
and live Siteverify; AWS account/region/certificates/secrets/deployment;
provider senders/templates/credentials and live delivery; real NIN provider;
representative migration rehearsal and reconciliation; UAT, penetration/load/
restore tests, credential rotation, and production cutover approval.

## Prior checkpoint ledger (superseded where it conflicts)

## Prior objective

Execute the HID master implementation roadmap incrementally while preserving
working Identity and EHR behavior, canonical Identity patient UUIDs, migration
history, and the consolidated `localhost:3000` browser flow.

## Prior AWS-only phase

- `AWS DEPLOYMENT ARCHITECTURE + INFRASTRUCTURE AS CODE FOUNDATION:
  IMPLEMENTED; EXTERNAL ENVIRONMENT VERIFICATION PENDING`
- Environment/artifact status: Docker `NOT AVAILABLE`; AWS account `NOT
  CONFIGURED`; AWS region `EXTERNAL / NOT SELECTED`; AWS resources mutated
  `NO`; image digests, SBOMs, image/content scans, and a completed release
  manifest `EXTERNALLY PENDING`; offline IaC synth `PASS`.
- Governing evidence: `docs/AWS_DEPLOYMENT_ARCHITECTURE.md`,
  `docs/AWS_DEPLOYMENT_RUNBOOK.md`, `docs/AWS_IAM_MATRIX.md`,
  `docs/AWS_COST_MODEL.md`, `docs/RELEASE_ARTIFACT_GATE.md`,
  `docs/RELEASE_FINDINGS.md`, and ADR-032. No AWS account, credential, region,
  domain, certificate, resource, bootstrap, push, migration, or deployment was
  used or mutated.
- `infra/aws/` is the first active IaC and uses pinned AWS CDK v2 TypeScript.
  It has typed development/staging/production profiles, optional external
  account/region inputs, a regional network/data/runtime stack, and a separate
  `us-east-1` CloudFront/WAF edge stack. Offline synth requires no AWS lookup.
- Synthesized runtime shape is nine separate private/no-public-IP ECS/Fargate
  services and ten task definitions including the separate default-plan EHR
  migration job; nine encrypted/immutable/scan-on-push ECR repositories; one
  private RDS PostgreSQL 16-major-family instance; one private versioned
  KMS-encrypted document bucket; one EventBridge bus; two bounded ALBs; one
  Gateway/CloudFront origin; and no speculative queue, rule, consumer, Lambda,
  SNS, API Gateway, Bedrock, or NIN provider.
- All ten image inputs require `repository@sha256:<64 hex>` with no default.
  Service desired-count parameters default to zero so migration and real
  secret/TLS/workload-token prerequisites precede rollout. Eight database
  secret interfaces preserve unique non-owner LOGINs; migration authority is
  separate. True secrets are ECS Secrets Manager references. Workload JWT
  issuer/JWKS/subjects are external inputs and token volume/file contracts are
  read-only; no token value or delivery implementation is fabricated.
- IaC lint/typecheck, build, 36 named assertions, offline synth, and a second
  template security verifier pass. Assertions cover private/encrypted RDS,
  deletion/snapshot behavior, bounded SG/IAM/KMS, private tasks, S3 public
  block/encryption/versioning, separate roles/workloads/migration, one Gateway
  origin, API/no-store caching, no plaintext secrets/JWTs/latest images,
  immutable digests, tags/retention, exact event bus, seven browser paths,
  WAF/TLS, monitoring, and absence of speculative consumers.
- Web's runtime `xlsx` dependency is removed rather than excepted. The trusted
  26,357-row workbook is preserved outside `public/`; Web serves a generated,
  runtime-validated JSON directory. Web has zero high/critical npm findings.
  Lab/Outreach locks were regenerated from clean graphs and contain zero stale
  Web paths; Lab audits clean. Web/Outreach retain two real moderate React
  Router findings with a formal major-upgrade disposition in
  `RELEASE_FINDINGS.md`.
- `FULL PLATFORM PRODUCTION-CONTAINER ACCEPTANCE: IMPLEMENTED; EXTERNAL
  ENVIRONMENT VERIFICATION PENDING`
- Governing evidence: `docs/PLATFORM_CONTAINER_ACCEPTANCE.md`. The accepted
  production artifact inventory is eight independent backend images, one
  shared unprivileged Gateway image containing all seven static frontend
  builds, and the EHR image's separate controlled migration target.
- Docker, Podman, Trivy, Grype, and Syft are absent and were not installed.
  Consequently no OCI image build, tag, digest, size, final-layer/UID
  inspection, container execution, or image/OS scan is claimed. All backend
  Dockerfiles are locked multi-stage Node 22 builds with non-root `node`,
  exec-form startup, appropriate readiness/process lifecycle, and SIGTERM; the
  Gateway is multi-stage unprivileged Nginx (`USER 101`) on port 3000.
- The production Gateway statically owns all seven UI roots and exact API
  prefixes, overwrites forwarded trust headers, forwards Origin/CSRF/
  correlation, excludes Dispatcher, provides scoped SPA fallbacks, and maps
  upstream failures to bounded Problem Details. Actual Nginx image execution
  remains external.
- Fresh host/database acceptance uses a disposable PostgreSQL 16.14 TLS
  cluster: all 27 immutable migrations apply, runtime role bootstrap and the
  complete schema/RLS suite pass, final plan is zero, eight temporary non-owner
  LOGINs authenticate with verify-full TLS, eight cross-domain mutations return
  42501, a wrong CA is rejected, and all temporary state is removed.
- Six built APIs pass live/ready, keep liveness process-only while readiness
  fails during a real PostgreSQL stop, recover after restart, and exit on
  SIGTERM. Two OCR Workers and two Dispatchers run concurrently against their
  non-owner roles and stop cleanly; lease/crash-window tests preserve exclusive
  claims, stale-token denial, durable retry, and at-least-once delivery. An OCR
  health/audit coupling defect exposed by outage testing was fixed and covered.
- Workload callers stat/read token files for every request/attempt and fail
  closed in tests; no actual JWT mount, rotation, issuer, or JWKS was available.
  All DB runtimes require production verified-CA TLS and reject connection-URL
  TLS overrides plus global verification disablement.
- Fresh acceptance passes root `npm test` with 311 tests, root production build,
  root verification, 1,042-file context and 764-file built-output secret scans
  with zero high-confidence findings, and a seven-app clean-profile Chrome run.
  Every app renders/refreshed from a direct route, is controlled by its exact
  worker scope, renders its cached shell and visible offline state with blocked
  transport, and has zero authenticated API Cache Storage entries. Pharmacy,
  Lab, OCR, and Admin remain fail-closed offline; Outreach retains the only
  encrypted mutation outbox.
- Live npm production audits pass with zero findings for all eight backends,
  EHR/Admin/Lab, and zero high/critical findings for Web. The former Web `xlsx`
  risk and Lab/Outreach lock attribution are resolved and recorded in
  `RELEASE_FINDINGS.md`. Web/Outreach React Router findings remain moderate and
  require the recorded tested major-version follow-up.
- Sentry/PostHog integration, PHI redaction, fail-open behavior, replay/
  feedback/autocapture/pageview disablement, and memory-only analytics pass
  locally. No safe destination configuration exists, so arrival is external.
  AWS CLI/credentials/services, production DB/LOGINs, workload mounts, real
  authenticated cross-app behavior, and representative devices remain external.
- `SEVEN-APPLICATION FRONTEND PLATFORM: IMPLEMENTED LOCALLY; EXTERNAL
  ENVIRONMENT VERIFICATION PENDING`
- Governing evidence: `docs/FRONTEND_LAYOUT_CONVERGENCE.md`, ADR-031,
  `docs/OFFLINE.md`, and the frontend addendum in
  `docs/PLATFORM_INTEGRATION_ACCEPTANCE.md`.
- Canonical browser apps are Web 3100, EHR 3101, Lab 3102, Pharmacy 3103,
  Outreach 3104, OCR 3105, and Admin 3106, gateway-routed at `/`, `/ehr/`,
  `/lab/`, `/pharmacy/`, `/outreach/`, `/ocr/`, and `/admin/`.
- Pharmacy and OCR are real Identity-session/API-backed workspaces. Pharmacy
  preserves prescribed/accepted/dispensed/administered distinctions and requires
  server acknowledgement for dispensing/reversal. OCR Operations exposes only
  implemented job/document lifecycle behavior; clinical OCR review remains EHR-
  contextual and no provider/publication success is fabricated.
- `packages/offline` and `packages/telemetry` are shared by every app. All seven
  have honest connectivity and exact-scope static-shell workers excluding
  `/api/`; only Outreach retains a persisted encrypted offline mutation outbox.
  Sentry/PostHog share strict PHI redaction/event allowlists, use memory-only
  analytics, and disable replay/autocapture/pageview recording.
- Local acceptance: aggregate root test passes 303 tests (Admin 19, Pharmacy
  36, OCR 13, plus 235 backend/worker/dispatcher tests), shared offline/telemetry
  verifiers, Outreach encrypted-outbox regression, all seven frontend builds,
  full root build, graph and bundle/source security scans, nine gateway browser
  routes, and seven clean-profile production offline reloads. Migration plan is
  zero pending through immutable `0001`–`0027`; this phase adds no migration.
- Pending evidence is explicit: authenticated external cross-app behavior,
  live Sentry/PostHog destination observation, representative real devices,
  Docker/container execution/scans, production identities/databases, and AWS.
- `SUPER ADMIN FOUNDATION: IMPLEMENTED AND VERIFIED LOCALLY; EXTERNAL
  ENVIRONMENT VERIFICATION PENDING`
- Governing evidence: `docs/SUPER_ADMIN_FOUNDATION.md` and ADR-029.
  `apps/admin` is the dedicated React/Vite application on standalone port
  3106 and the gateway path `/admin/`. It has no database client or credentials.
  `/api/v1/admin/*` is Identity-owned and backend capability-enforced; no
  redundant Admin BFF was created.
- Platform roles are explicit `auth.account_roles` assignments with separate
  `platform.*` capabilities. They never inherit clinical permissions or
  break-glass. Facility, principal, session, role, Identity-review, immutable
  audit, service-health, and event-delivery slices use real governed APIs.
- Additive migration `0027_super_admin_foundation.sql` adds facility lifecycle,
  reasoned/versioned platform assignment history, immutable command
  idempotency/status evidence, last-admin-safe commands, minimum RLS reads,
  and PHI-minimal dispatcher failures. Migrations `0001`–`0026` are unchanged.
- Local acceptance: Admin strict lint/typecheck, 19 tests and production build;
  Identity strict typecheck/build and 15 suites/49 tests; Dispatcher 5
  suites/18 tests and build; migration dry-run/apply, runtime-role bootstrap,
  catalog assertions, full rollback-only schema/RLS suite, zero-pending final
  plan, platform graph verifier, and root build. Docker/AWS/production identity,
  database, monitoring, and representative-device evidence remains external.
- `EVENT DISPATCHER DEPLOYMENT/CONTAINER ACCEPTANCE: STRUCTURALLY IMPLEMENTED
  AND HOST/DATABASE VERIFIED; EXTERNAL IMAGE/AWS VERIFICATION PENDING`
- Governing evidence: `docs/EVENT_DISPATCHER_DEPLOYMENT_ACCEPTANCE.md`.
  Docker and compatible image/scanner tooling are absent, so no image build,
  digest, size, final-layer inspection, container runtime, or image scan is
  claimed. Docker was not installed.
- Narrow deployment defects were corrected without changing event semantics:
  the container status bind is externally reachable inside its network
  namespace, production database URLs cannot override dedicated verified-CA
  TLS settings, readiness rechecks and reports database plus transport state,
  and SIGTERM permits bounded in-flight drain before forced transport abort.
- The Dockerfile remains a locked two-stage Node 22 build with explicit inputs,
  production-only runtime dependencies, non-root `node`, readiness health
  check, and `STOPSIGNAL SIGTERM`. Root `.dockerignore` now also excludes AWS
  credential locations, workload-token mounts, secret directories, temporary
  PostgreSQL data, and debug logs.
- Fresh dispatcher evidence is 5 suites/18 tests, lint/typecheck/build, full
  root production build, package
  audit with zero production dependency vulnerabilities, graph/static Docker
  and exact-bus IAM verification, real host live/ready/metrics, and actual
  SIGTERM exit 0. Image/OS scanning remains unverified.
- A disposable PostgreSQL 16.14 cluster applied all 26 migrations and passed
  role provisioning/assertions plus the complete rollback-only schema/RLS
  suite. A temporary LOGIN inheriting only `hid_event_dispatcher` delivered a
  synthetic PHI-free event, recorded its attempt, and was denied direct table
  access and mutation in all six domain schemas. Two built instances claimed
  independently. The LOGIN and entire cluster were removed afterward.
- Representative PostgreSQL TLS passed with certificate verification enabled;
  a different CA was rejected. The production RDS endpoint/CA/network and
  production LOGIN remain external. No live AWS credential source or bus is
  present, so EventBridge, IAM, ECS/Fargate, ECR, CloudWatch, and AWS deployment
  remain explicitly unverified.
- `TRANSACTIONAL EVENT DELIVERY FOUNDATION: IMPLEMENTED LOCALLY; EXTERNAL ENVIRONMENT VERIFICATION PENDING`
- Governing scope: inventory the active Identity, EHR, Lab, Pharmacy, OCR, and
  Outreach outboxes; implement a neutral independently runnable dispatcher
  with immutable envelopes, concurrency-safe leases, bounded retry, explicit
  local/test and EventBridge transports, least-privilege database commands,
  and operational status; then prove the minimum generic durable
  per-consumer inbox/dedup transaction without inventing business consumers.
- Delivery semantics are explicitly at least once. Transport acceptance is
  not consumer completion, the publish/mark-delivered crash window may cause
  redelivery, and durable consumer dedup must prevent duplicate business
  effects. Applied migrations `0001`-`0025` remain immutable; the required
  persistence change is narrow additive migration `0026`.
- Inventory result: Identity, OCR, Lab, Pharmacy, and Outreach are active
  outbox producers; EHR has no outbox producer. No asynchronous product
  consumer is active, so this stage adds no invented consumer or business
  effect. The exact matrix is `docs/EVENT_DELIVERY_ARCHITECTURE.md`.
- `services/event-dispatcher` is independently runnable on status port 3010.
  It validates the stable envelope-v1 registry and recursive PHI-minimal
  policy, claims with exclusive expiring leases, handles EventBridge partial
  success with one SDK attempt, records bounded retry/terminal evidence, and
  preserves the publish/mark crash window as explicit at-least-once delivery.
- Migration `0026` separates mutable delivery attempts from immutable domain
  outboxes, corrects the obsolete Lab aggregate foreign key, and adds a
  role-bound durable inbox keyed by `(consumer_name,event_id)`. Local
  PostgreSQL 16 migration, role, full schema/RLS, duplicate-delivery,
  consumer-crash, service test/build, IAM/Docker inspection, and graph
  acceptance pass. Live AWS/EventBridge, container execution, PostgreSQL TLS,
  and environment-specific LOGIN evidence remain external.
- `BACKEND LAYOUT CONVERGENCE: IMPLEMENTED AND VERIFIED LOCALLY; EXTERNAL ENVIRONMENT VERIFICATION PENDING`
- Governing scope: move the active EHR API from `ehr/server` to
  `services/ehr-api`, move the independent OCR worker to
  `services/ocr-worker`, preserve ports and behavior, and leave exactly one
  active executable owner for each. The single `0001`-`0025` platform
  migration ledger is classified separately from EHR runtime code and will
  not be split or rewritten during this cutover.
- Pre-cutover discovery found 183 non-generated files under `ehr/server`: 11
  worker files, 28 central migration/role/schema-test files, EHR runtime and
  compatibility source, and package/tooling infrastructure. Root launch,
  graph verification, one frontend verifier, and current docs contain the
  active path assumptions that must change atomically.
- Physical cutover is complete: `ehr/server` is absent, the EHR API is under
  `services/ehr-api`, the independent worker is under `services/ocr-worker`,
  and stray EHR/Lab worker scripts are removed. Initial EHR 23-suite/70-test
  and worker 3-suite/8-test checks, strict builds, platform graph, full root,
  database, live-stack, worker-only, and shutdown acceptance all pass.
- `PLATFORM INTEGRATION ACCEPTANCE: IMPLEMENTED LOCALLY; EXTERNAL ENVIRONMENT
  VERIFICATION PENDING`
- The authoritative acceptance evidence is
  `docs/PLATFORM_INTEGRATION_ACCEPTANCE.md`. Identity (3001), EHR (3002), Lab
  (3003), Pharmacy (3004), the physically extracted OCR API (3005), and
  Outreach (3006) have singular route, database, and mutation ownership behind
  the one-origin gateway (3000). The OCR worker remains a separate executable.
- Cross-service authorization preserves bearer or Identity session-cookie user
  evidence separately from exact workload identity. Cookie mutations propagate
  Origin and CSRF evidence; idempotent Lab/Pharmacy calls have a 10-second
  timeout, at most one transient retry, and refresh workload credentials per
  attempt. The OCR-to-EHR publication command uses the same bounded,
  idempotency-gated retry model. Inbound workload JWTs and mounted token files
  are bounded before cryptographic parsing.
- All six API suites, affected typechecks/builds, frontend contract verifiers,
  the root production build, gateway/service graph verification, migration
  plan/dry-run, runtime-role assertions, health/routing checks, correlation
  propagation, and negative failure injection are the extraction acceptance
  surface. Exact fresh results are recorded below.
- OCR controllers, services, DTOs, policies, persistence, authorization, and
  publication orchestration now run only in `services/ocr-api` on port 3005.
  EHR exposes only narrow workload-authenticated source-evidence and imported-
  note boundaries. Its old OCR module and API source are removed. The worker
  runs independently from `services/ocr-worker` and neither
  runtime imports the other.
- Production workload issuer/JWKS/token mounts, environment-specific non-owner
  LOGINs, a real NIN provider, Docker/AWS deployment, and representative-device
  Outreach lifecycle remain external evidence. No production-readiness claim
  is made from local acceptance.
- `PHASE 0: COMPLETE LOCALLY`
- `PHASE 4: PHARMACY SEPARATION IMPLEMENTED LOCALLY`
- `PHASE 6: FIRST OUTREACH OFFLINE SLICE IMPLEMENTED LOCALLY`
- Subtask: minimum Outreach temporary-registration boundary and physical service extraction.
- Status: migration `0024`, role/catalog assertions, and the full rollback-only
  schema/RLS suite pass against local PostgreSQL. `services/outreach-api` runs
  independently on port 3006 and the gateway owns `/api/v1/outreach/*`. The
  browser uses an encrypted IndexedDB command outbox; Identity remains the sole
  canonical patient/HID authority. Production workload issuer/JWKS/token
  delivery, environment-specific non-owner login, Docker execution, deployment,
  and real-device offline lifecycle evidence remain external verification items.

## Repository state

- Active browser frontends: `apps/web`, `apps/ehr`, `apps/lab`,
  `apps/pharmacy`, `apps/ocr`, `apps/outreach`, and `apps/admin`; historical
  top-level/Identity copies are reference-only.
- Active governed Admin frontend: `apps/admin/` on standalone port 3106 and
  one-origin route `/admin/`; all data comes from `/api/v1/admin/*`.
- Active Identity/Web frontend and one-origin gateway: `apps/web/`.
- Active EHR frontend/reference: `apps/ehr/`; its canonical runtime supplies
  shared offline/telemetry policy while contextual OCR review remains in EHR.
- Active authoritative Identity API: `services/identity-api/` on port 3001.
- Active EHR NestJS/PostgreSQL API: `services/ehr-api/` on port 3002.
- Active neutral event dispatcher: `services/event-dispatcher/`; its status
  listener defaults to port 3010 and root development starts it only after
  explicit enablement and transport configuration.
- Active standalone OCR NestJS/PostgreSQL API: `services/ocr-api/` on port
  3005. The separately runnable OCR worker is at `services/ocr-worker/`.
- Root `npm run dev` runs the one-origin local gateway.
- `services/lab-api/`, `services/pharmacy-api/`, and `services/outreach-api/`
  are active extracted backends with canonical browser clients where applicable.
- `packages/api-client/`, `packages/identity-browser-client/`, `packages/ui/`,
  `packages/offline/`, and `packages/telemetry/` are active shared browser
  boundaries and contain no domain persistence authority.
- The worktree contains extensive pre-existing user changes. Preserve them.
- `upstream_snapshot/` is reference-only and cannot override authoritative docs.

## Completed checkpoints

### AWS deployment architecture and IaC checkpoint (2026-08-11)

- Repository inventory found no active IaC/CI deployment framework, so the
  mandated fallback is implemented at `infra/aws/` using locked AWS CDK v2
  TypeScript. ADR-032 records the one-Gateway-origin, separate-edge-stack,
  private-runtime decision and intentional omission of redundant API Gateway
  and speculative asynchronous resources.
- Regional CDK resources cover three subnet tiers, Multi-AZ staging/production,
  bounded SGs/endpoints, nine ECR repositories, nine independent ECS services,
  ten task definitions, separate execution/task roles, private PostgreSQL 16,
  versioned KMS documents, exact Textract and EventBridge task IAM, Secrets
  Manager interfaces, private internal TLS routing, logs/metrics/alarms, and a
  controlled migration job. Edge resources cover CloudFront one-origin static/
  API cache policy, WAF managed/rate rules, viewer TLS, and Route 53 aliases.
- Release manifest JSON schema/template, digest/SBOM/scan admission policy,
  staged CI/CD design, rollback policy, IAM matrix, cost variables, account-
  through-production runbook, data-protection constraints, and external gaps
  are documented. No fake digest, domain, provider, token, account, or total
  cost is recorded.
- Local acceptance: root test passes 347 aggregate tests including 36/36 IaC
  assertions; root verify and the complete production build pass;
  infrastructure lint/typecheck/build pass; development stacks synthesize
  without AWS lookups; the synthesized
  template security scan reports 9 services, 9 repositories and 10 required
  digest inputs with no forbidden public database/task/bucket, plaintext
  secret/JWT/static key, mutable image, IAM action wildcard, or speculative
  consumer.
- Docker image/digest/layer/SBOM/scan/topology evidence, ECR push/Inspector,
  authorized account/region/bootstrap/deploy, DNS/ACM, production RDS/LOGIN/TLS,
  workload token delivery, live S3/KMS/Textract/EventBridge allow/deny, NIN,
  telemetry, devices and staging/production acceptance remain external.

### Full platform production-container acceptance checkpoint (2026-08-11)

- Evidence classifications and the complete runtime/backend/frontend/gateway,
  image, database, identity, signal, scale, browser/offline, telemetry,
  migration, and AWS matrices are in `PLATFORM_CONTAINER_ACCEPTANCE.md`.
- Docker execution was checked first and is unavailable. Host execution was
  maximized without relabeling it as container evidence: 311 tests, all package
  builds, root verification, production dependency audits, context/output
  secret scans, isolated TLS PostgreSQL with eight non-owner roles/denials, six
  API outage/recovery/SIGTERM checks, OCR Worker x2, Dispatcher x2, and seven
  production preview browser/offline checks pass.
- Packaging is complete structurally: eight backend Dockerfiles; one shared
  unprivileged Nginx Gateway image for seven static apps; and a separate EHR
  migration target. `.dockerignore`, locked installs, Node 22 compatibility,
  narrow final copies, non-root declarations, health tooling, base paths,
  routing, forwarded trust headers, no-store worker policy, and bounded gateway
  errors pass `verify:containers`.
- Docker images, digests, sizes, runtime UIDs, final layers, SBOM/image scans,
  full container networking/restarts, live token mounts, production RDS/AWS,
  authenticated deployment, external telemetry destinations, and physical
  devices remain explicitly external.

### Seven-application frontend platform checkpoint (2026-08-11)

- Inventory classified all seven canonical apps as active, shared transport/
  UI/offline/telemetry infrastructure as reusable, the exact EHR reference and
  residual Web convergence as transitional, old top-level/upstream copies as
  legacy/reference, and missing Pharmacy/OCR placeholders as superseded/dead.
- `apps/pharmacy` implements truthful dashboard/list views from real work items,
  incoming/accepted/history distinctions, live exact-version dispensing and
  reversal, imported historical medication evidence, governed patient lookup,
  and operational activity. It does not invent inventory, refills,
  administration, unsupported global metrics, or offline success.
- `apps/ocr` implements exact job/document lookup, job creation/retry,
  extraction metadata, validation state, and publication state. It exposes no
  raw OCR text/general queue/provider readiness claim and does not replace EHR's
  contextual clinical review.
- Both apps use the shared Identity cookie/CSRF session and permission gates for
  UX while owning APIs remain authoritative. Production browser code uses only
  same-origin typed clients and sends no token in URLs.
- `packages/offline` owns connectivity, sync statuses, durable command envelope,
  stable UUID idempotency, retry/conflict classification, non-extractable
  AES-GCM helpers, and scoped worker registration. Outreach's existing encrypted
  IndexedDB database/key/idempotency/cleanup behavior remains intact and is the
  only persisted mutation outbox.
- `packages/telemetry` owns all seven app identities, Sentry/PostHog init,
  safe-event/property allowlists, request/context/breadcrumb/exception
  redaction, replay/feedback/autocapture/pageview disablement, memory-only
  analytics, and the safe application error boundary. Tests prove PHI-shaped
  fields are removed and telemetry failures are non-critical.
- Every app has a manifest and scoped worker; five independent modules own
  scoped SVG icons, Web owns `/`, and no worker caches `/api/`. The canonical
  EHR build now includes a dedicated platform runtime so exact-reference mode
  actually initializes shared telemetry, connectivity, and `/ehr/` PWA behavior.
- Root orchestration uses frontend ports 3100–3106, supports grouped subsets,
  starts all seven when requested, routes Pharmacy/OCR UI separately from API,
  and includes all apps/packages/services/worker/dispatcher in root build.
- Local tests pass through root `npm test`: 303 total, including Admin 19,
  Pharmacy 36, OCR 13, and 235 service/worker/dispatcher tests; shared offline and telemetry static
  verifiers; Outreach encrypted outbox regression; platform graph; frontend
  source/bundle security scan; and individual/root builds. Browser evidence
  covers nine development gateway routes and seven production preview origins,
  including direct nested Pharmacy/OCR refresh, safe auth-entry states, exact
  service-worker scopes, offline shell/status, and no cached API response.
- No database requirement was found. Applied migrations `0001`–`0027` remain
  unchanged and the final read-only migration plan reports zero pending.

### Super Admin foundation checkpoint (2026-08-11)

- Inventory classified the current Identity auth/session/membership/audit and
  registration-review foundations as preservable, the active-flag and missing
  platform-context resolution as needing hardening, the Supabase-era dashboard
  as retired/reference only, and arbitrary dispatcher retry/OCR-worker status
  as intentionally unavailable rather than faked.
- Authorization uses `platform_super_admin`, `platform_operations_admin`,
  `identity_review_admin`, `facility_review_admin`, `security_auditor`, and
  `support_admin`, mapped only to purpose-specific `platform.*` capabilities.
  Browser navigation reflects capabilities, while controllers and database
  commands independently enforce them. Platform role alone cannot perform EHR,
  Lab, Pharmacy, OCR, Outreach, audit mutation, or break-glass actions.
- The one-time `admin:bootstrap` command requires `DATABASE_ADMIN_URL`, one
  exact eligible account UUID, and an explicit reason; it serializes, audits,
  and refuses to create a second active Super Admin. Runtime authorization
  never reads a bootstrap email or environment flag.
- Facilities have `pending`, `verified`, `rejected`, and `suspended` lifecycle
  state. Suspension makes `active=false`, so existing membership/authorization
  checks fail while history remains. Commands require reason, idempotency, and
  expected version; exact replay is stable and two-admin stale writes conflict.
- Principal search is mandatory and bounded. Authentication accounts, facility
  memberships, and platform roles are displayed separately. Account suspension
  increments token version and revokes sessions; session revoke is authoritative;
  platform role grants are allowlisted and last-admin safe.
- Identity review is read-only and displays only masked NIN/provider/status.
  The Audit Center is cursor-paginated and immutable and omits patient IDs and
  free-form detail payloads. Duplicate candidates are not merged and no new HID
  is issued through Admin.
- Service operations concurrently represents Identity, EHR, Lab, Pharmacy,
  OCR, Outreach, Dispatcher, and honest `not_observable` OCR Worker state with
  bounded timeout and correlation. Event delivery exposes whitelisted metrics
  and terminal failure fields without payload/PHI. Retry remains read-only
  future work because the dispatcher has no governed retry command.
- Admin UI routes are overview, facilities/list/detail, users/memberships,
  Identity review, audit, services, and events. Tests cover unauthenticated,
  unauthorized, authorized/capability navigation, facility list/detail/mutation,
  destructive confirmation/conflict, user search/membership distinction, audit
  cursor, partial service failure, safe terminal events/errors, and session expiry.
- Live gateway smoke serves `/admin/` with HTTP 200, returns structured Problem
  Details 401 for an unauthenticated `/api/v1/admin/session`, and renders the
  Administrator sign-in shell in headless Chrome. The graph verifier protects
  the linked shared-client prebundle required by Vite development.
- Migration `0027` checksum is
  `59a74a198d9b773d6a80e87b55556e569f18a47a633d6ba4107d5bb68101839f`.
  Roles remain NOLOGIN, non-owner, non-superuser, and non-BYPASSRLS. Schema
  negatives cover role escalation, last-admin suspension/revocation, last-
  reachable-admin facility suspension, stale version, digest conflict, replay,
  and absence of clinical permissions. Every command that can remove the final
  usable Super Admin path shares one advisory transaction lock, closing cross-
  account and cross-facility races.
- No generic admin SQL/record writer, Admin BFF, database login, direct browser
  database access, automatic merge, event retry, clinical mutation, or
  break-glass grant was added.

### Event dispatcher deployment/container acceptance checkpoint (2026-08-11)

- The authoritative report is
  `docs/EVENT_DISPATCHER_DEPLOYMENT_ACCEPTANCE.md`. The dispatcher is
  structurally ready for an immutable root-context image build and ECS/Fargate
  task definition, but this environment has no Docker-compatible runtime or
  image scanner. No build, image digest/size, layer inspection, container UID,
  container health/signal/restart, two-container, or image-scan evidence is
  claimed.
- The final stage is configured as non-root `node`, exposes port 3010 from
  `0.0.0.0` inside the container, checks truthful readiness, receives SIGTERM,
  installs production dependencies from the lockfile, and contains only
  package inputs plus compiled output. Static secret-pattern and build-context
  checks pass; final image inspection remains external.
- Production config fails closed on disabled/deterministic transport, missing
  database/bus/TLS inputs, malformed CA, unsafe bounds, static AWS keys,
  plaintext custom AWS endpoints, global TLS-verification bypass, and
  database-URL TLS overrides. The AWS SDK
  uses its workload credential chain; no HID workload JWT mount applies to
  this dispatcher.
- Fresh service evidence is 5 suites/18 tests plus lint/typecheck/build and the
  full root production build. Host
  liveness/readiness/metrics pass with explicit ready database and transport
  states. Actual SIGTERM logged drain/stopped and exited 0. Safe event logs now
  include transport and duration without payload content.
- Fresh disposable PostgreSQL acceptance applied `0001`-`0026`, passed
  runtime-role bootstrap/assertions and the full rollback-only schema/RLS
  suite, exercised a representative non-owner LOGIN, and proved six domain
  mutation denials plus no direct outbox/delivery-state access or BYPASSRLS.
  Two app instances each claimed one distinct event. Verified TLS succeeded
  and an unrelated CA failed. The temporary LOGIN and cluster were removed.
- `npm audit --omit=dev` reports zero production-package vulnerabilities. This
  is not an image scan. EventBridge partial behavior remains unit-tested only;
  no live AWS environment, exact-bus task role, ECR, ECS/Fargate, CloudWatch,
  or deployment evidence exists here.
- Migration `0026` remains byte-for-byte unchanged with checksum
  `1a2c2f5269397fb54e6df5bf3ae08bf373b62f68cec3f2104994faa2d8a32f3f`;
  no migration `0027` was added.

### Transactional event delivery checkpoint (2026-08-11)

- `services/event-dispatcher` is the single neutral dispatcher executable. It
  references only `integration` SQL, imports no owning service, has explicit
  disabled/deterministic/EventBridge modes, a non-root Docker contract, and an
  exact-bus least-privilege IAM example.
- The `EventTransport` boundary has an explicit non-production deterministic
  adapter and a real EventBridge `PutEvents` adapter with ten-entry batches,
  caller-owned timeout, `maxAttempts: 1`, and independent partial-result
  handling. The runtime exposes live/ready/metrics on port 3010 and drains on
  SIGTERM/SIGINT.
- Claims use `FOR UPDATE SKIP LOCKED`, expiring leases and unique tokens;
  retry is bounded exponential equal-jitter with a configured attempt cap;
  exhausted, non-retryable, mutated, or unsupported-contract events retain
  safe terminal evidence. Event IDs, correlation, and immutable payload
  digests survive reclaim.
- Migration `0026` and corrective runtime grants passed from a clean local
  PostgreSQL 16 database. The full rollback-only schema/RLS suite exercised 20
  events across all five producers and proved exclusive leases, stable
  redelivery after publish/mark failure, bounded terminal attempts, per-
  consumer deduplication, and effect/marker rollback and retry.
- Migration checksum:
  `1a2c2f5269397fb54e6df5bf3ae08bf373b62f68cec3f2104994faa2d8a32f3f`.
  `hid_event_dispatcher` is function-only; its never-inherited technical owner
  reads only the five RLS-protected outboxes and mutates only `integration`
  delivery/inbox state. No RLS bypass or domain mutation grant was added.
- No active consumer was discovered. The generic inbox is keyed by
  `(consumer_name,event_id)`, binds names to provisioned database roles, and
  requires business effect plus processed marker in one transaction. Failure
  injection proves duplicate suppression, independent consumers, and
  rollback/retry after a simulated consumer crash.
- Dispatcher tests, typecheck/build, root graph and port verification, runtime
  role/catalog assertions, and migration execution pass. Exact results: 4
  dispatcher suites/11 tests, dispatcher typecheck/build, full root production
  build, live deterministic readiness/metrics/drain smoke, all 26 migrations,
  role assertions, and full schema/RLS completion through intentional
  `ROLLBACK`. No product consumer or EHR producer was invented.
- External evidence remains: live EventBridge partial-result execution,
  workload IAM and exact bus, environment-specific non-owner database LOGIN,
  PostgreSQL TLS/CA, built-container execution/health/drain, and production
  metrics/alert integration.
- Exact next action: deployment/container acceptance for the dispatcher,
  including its non-owner LOGIN over PostgreSQL TLS, exact EventBridge bus/IAM,
  built-image health/drain, and production metrics/alerts. A real consumer is
  integrated only after its business effect is approved.

### Backend layout convergence checkpoint (2026-08-11)

- The authoritative evidence is `docs/BACKEND_LAYOUT_CONVERGENCE.md`; ADR-027
  records the placement and migration-ledger decisions.
- `services/ehr-api` is the only EHR API package and port-3002 runtime.
  `services/ocr-worker` is the only OCR worker package and production command.
  The former `ehr/server` path is absent and statically rejected.
- The one checksum-governed `0001`-`0025` migration ledger, runtime grants,
  runner, role bootstrap, and schema tests moved intact with the EHR package.
  They are classified as platform-owned and temporarily co-located to avoid
  mixing migration-tooling risk into runtime relocation. No migration changed
  and no ledger fork was created.
- Root orchestration, builds, frontend verifiers, graph ownership checks,
  Docker static checks, local env scoping, and the independently locked shared
  client all use the new paths. Backend root startup uses compile-once local
  processes so child runtime failures surface and drain siblings; standalone
  service development commands retain watch mode.
- Final test total is unchanged at 72 suites/207 tests: Identity 13/39, EHR
  23/70, worker 3/8, OCR 8/27, Lab 11/31, Pharmacy 7/17, Outreach 7/15. Every
  backend lint/build, the shared client typecheck/build, frontend contract
  verifiers, full root build, platform graph, and `git diff --check` pass.
- Database acceptance from `services/ehr-api` reports zero pending migrations,
  successful rollback-only dry run, idempotent role provisioning, separate
  role assertion pass, and full schema/RLS completion through intentional
  `ROLLBACK`.
- The ordinary graph ran one listener per port 3000-3006 and 3101. Every API
  live/ready endpoint returned 200; gateway root/EHR returned 200; OCR gateway
  ownership returned the expected 401 with correlation preservation; retired
  EHR OCR and Identity routes returned 404. SIGINT left no listeners.
- With all APIs stopped, the worker reached database/test-provider readiness
  from `services/ocr-worker`, failed claims closed with local PostgreSQL
  `42501` because no worker principal/LOGIN exists, and drained cleanly without
  changing a job. An injected invalid child config exited root 1 and left no
  orphan listeners.
- Docker execution, environment-specific non-owner LOGINs, production
  issuer/JWKS/token mounts, PostgreSQL TLS, AWS/IAM/KMS/S3/Textract, deployed
  observability, real NIN, and representative-device Outreach evidence remain
  external; no production-readiness claim is made.

### OCR physical extraction checkpoint (2026-08-11)

- The authoritative inventory is `docs/OCR_EXTRACTION_INVENTORY.md`. It records
  every active OCR API, worker, UI, EHR document/note boundary, shared client,
  migration, role, and historical/reference disposition. No active
  Outreach-to-OCR command exists, so no speculative caller, route, workload
  credential, or client use was invented.
- `services/ocr-api` is a standalone NestJS API on port 3005. It owns OCR job
  commands/reads, immutable extraction reads, validation, canonical-patient
  confirmation, durable publication orchestration, OCR/audit persistence,
  transactional outbox writes, configuration, health, tests, and Dockerfile.
  It requires PostgreSQL for readiness but not Textract, S3, the worker, or
  downstream service availability.
- The worker now runs from `services/ocr-worker`, retaining exact object
  version and SHA-256 verification, provider execution, `SKIP LOCKED` claims,
  expiring leases, attempt-token protection, bounded retry, immutable
  completion, and command-only database authority. It imports no OCR API or
  EHR application module and can start without either HTTP API.
- `packages/api-client/src/ocr.ts` owns browser-facing typed OCR transport and
  contracts. `packages/api-client/src/ehr.ts` owns the two narrow OCR-to-EHR
  contracts: exact source evidence and idempotent imported-draft-note
  publication. OCR also uses the existing typed Identity, Lab, and Pharmacy
  clients; it imports no owning-service implementation source.
- The OCR API independently authenticates the human actor through Identity
  with an `ocr-api` workload identity. Its EHR/Lab/Pharmacy calls preserve
  bearer or cookie/CSRF/Origin user evidence, facility, purpose, correlation,
  stable publication idempotency, and distinct target-audience workload
  credentials. Production rejects local secrets and requires bounded rotating
  asymmetric JWT files with HTTPS issuer/JWKS, exact audience, signature,
  expiry, and subject checks.
- EHR now owns only narrow `/api/v1/ehr/internal/ocr/...` source and imported-
  note endpoints guarded by exact OCR workload identity plus the propagated
  human actor. Source lookup and every OCR job command are reauthorized through
  Identity. Clinical-note creation remains delegated to EHR's existing
  provenance- and idempotency-preserving service.
- The gateway routes `/api/v1/ocr/*` to 3005 before the generic EHR fallback.
  EHR `AppModule` no longer registers `OcrModule`; verified-dead
  former `ehr/server/src/ocr/*` API source was removed only after the standalone API
  and replacement EHR boundary compiled. The platform graph verifier enforces
  this single-writer state and rejects direct foreign-domain OCR SQL.
- `hid_ocr_api_runtime` now composes `hid_ocr_runtime` and
  `hid_audit_writer` only. `hid_ehr_api_runtime` no longer inherits OCR.
  `hid_ocr_worker` remains command-only with no table grants. The OCR API has no
  Identity, EHR, Lab, Pharmacy, or Outreach persistence authority; publication
  uses typed HTTP clients. Existing migrations `0001` through `0025` are
  unchanged and no `0026` migration was required.
- Document-only publication remains an OCR-owned terminal publication state
  and does not create foreign clinical truth. EHR publication creates an
  imported draft note; Lab publication creates imported evidence; Pharmacy
  publication creates historical medication evidence only. `UNCLASSIFIED`,
  unresolved patient, stale validation, invalid candidate, wrong-patient,
  and break-glass mutation paths remain fail-closed.
- Initial replacement verification completed before old source removal:
  shared-client build, standalone OCR strict typecheck/build and 6 suites/22
  tests, then-current EHR strict build and 25 suites/76 tests (including the
  independent worker), and platform graph verification all passed. The final
  post-removal consolidated results are recorded in the next section.
- Docker execution, production issuer/JWKS/token mounts, environment-specific
  non-owner LOGINs, PostgreSQL TLS, AWS private networking/S3/IAM/KMS/Textract,
  deployment observability, authenticated end-to-end publication, real NIN,
  and representative-device Outreach behavior remain external evidence. No
  production-readiness claim is made.

### OCR extraction final verification (2026-08-11)

- All six backend suites pass: Identity 13 suites/39 tests; EHR and the OCR
  worker 26/78; OCR API 8/27; Lab 11/31; Pharmacy 7/17; Outreach 7/15. Total:
  72 suites and 207 tests. The EHR total includes exact OCR local caller/token,
  JWT issuer/audience/subject, and oversized-token-before-JOSE guard coverage.
  OCR includes shared browser/EHR transport tests for exact routes, propagated
  user/workload separation, correlation/idempotency, refreshed workload tokens,
  bounded retry, preserved Problem Details, and strict malformed-response
  rejection.
- Shared client typecheck/build and every backend strict lint/typecheck/build
  pass. The root production build passes for both frontends, shared client, and
  all six APIs. Identity and Outreach frontend contract verifiers pass. The EHR
  frontend compiles against the shared OCR client. `git diff --check` passes.
- `npm run verify:platform-graph` passes with unique ports 3000 through 3006,
  `/api/v1/ocr` owned by `ports.ocrApi`, EHR mutation ownership limited to
  `ehr`/`audit`, OCR limited to `ocr`/`audit`, and a static denial of direct
  foreign-domain OCR SQL.
- The ordinary local stack started Identity 3001, EHR 3002, Lab 3003, Pharmacy
  3004, OCR 3005, Outreach 3006, the gateway 3000, and EHR UI 3101 together.
  Every API live and ready endpoint returned 200. Direct and gateway OCR job
  reads both returned OCR-owned 401 Problem Details without credentials; the
  gateway preserved the supplied `ocr-extraction-smoke-20260811` correlation
  ID. Direct EHR `/api/v1/ocr/jobs` returned exact 404. The new EHR internal OCR
  boundary returned 401 without the human actor and is not publicly open.
- The OCR API reached live/ready while no worker was running. With all HTTP
  APIs stopped, the worker-only executable independently reached database and
  deterministic-provider readiness and drained cleanly on SIGINT. Its claim
  loop failed closed with PostgreSQL `42501` because this checkout contains
  zero active `ocr_worker` principals and no dedicated worker LOGIN. No jobs
  were claimable, and no job state was changed. A deployment-specific worker
  principal/login remains external verification. The root launcher starts the
  worker only when `OCR_WORKER_DATABASE_URL` and a non-disabled
  `OCR_PROVIDER` are explicitly configured; otherwise it reports disabled.
- PostgreSQL reports zero pending migrations and the migration dry-run passes.
  Idempotent local role provisioning plus assertion-only catalog verification
  pass for the EHR/OCR API split and command-only worker. The complete
  `schema.integration.sql` suite executed successfully through its intentional
  `ROLLBACK`; the earlier approval-timeout caveat is resolved. Applied
  migrations `0001` through `0025` remain byte-for-byte untouched.
- Docker is not installed. Static OCR Dockerfile review confirms the established
  root build context, `npm ci`, shared-client and API production builds,
  production-only install, non-root runtime, port 3005, and no copied local env,
  key, certificate, or JWT material. Image build/scan/runtime remains external.

### Earlier completed checkpoint history

- Platform integration acceptance confirms the extracted Identity, Lab,
  Pharmacy, and Outreach processes can run concurrently with EHR/OCR behind
  the gateway. The static graph verifier enforces exact gateway ownership,
  unique ports, active-module retirement, and per-executable mutation schemas.
- Runtime route probes confirmed extracted-owner Problem Details, exact 404s
  for retired and wrong-service routes, and correlation-ID preservation across
  the gateway. Direct live/readiness returned 200 for every current API.
- Fresh negative coverage proves bounded two-attempt failure on repeated 503 or
  malformed dependency output, per-attempt workload-token refresh, oversized
  credential rejection before JOSE/file parsing, and concealment of unreleased
  Lab results from ordinary readers.

- The authoritative Outreach scan is
  `docs/OUTREACH_EXTRACTION_INVENTORY.md`. Active code had a demographic form,
  missing `outreach-data` calls, public onboarding screens, and a fake in-memory
  “sync”; it had no active patient/HID creation, direct Identity/EHR writes,
  IndexedDB, document/OCR, NIN, screening authority, or clinical persistence.
  Historical Supabase campaigns/workers/encounters and permissive policies were
  not restored.
- The implemented scope is facility-authorized temporary registration only.
  `tmp_<uuid-v4>` is random, non-patient-derived, never a UUID/HID claim, and is
  preserved when a separate command links an authorized exact existing Identity
  patient. Ambiguity and unresolved work remain
  `identity_resolution_pending`; there is no new-patient command.
- Migration `0024_outreach_registration_foundation.sql`
  (`65d30c48853c39188694ce95ed0c5cb489b37ec4b5d131eb955af0b43513d5f9`)
  adds forced-RLS cases, append-only mappings/history/idempotency, and minimum
  outbox evidence. Actor/facility/membership/direct-care context, immutable
  provenance, optimistic versions, exact deferred mapping consistency, semantic
  audit, and break-glass denial are database-tested.
- `hid_outreach_runtime` is NOLOGIN, non-owner, and non-BYPASSRLS with Outreach
  persistence only. `hid_outreach_api_runtime` adds append-only audit. EHR,
  Identity, Lab, Pharmacy, and OCR roles cannot mutate Outreach; Outreach cannot
  insert Identity patients/identifiers or mutate EHR/Lab/Pharmacy/OCR.
- The standalone NestJS service owns controllers, DTOs, transactions, Identity
  authorization, configuration, liveness/readiness, and Dockerfile. Identity
  authenticates the user and facility plus independent `outreach-api` workload
  evidence. Production accepts only asymmetric workload JWT mode with a rotating
  mounted token; local orchestration generates one separate ephemeral secret.
- `packages/api-client` exports the typed Outreach client. The Vite gateway
  routes `/api/v1/outreach/*` to port 3006 and EHR no longer registers its empty
  Outreach module, leaving no active duplicate writer.
- Browser commands use IndexedDB with AES-GCM and a non-extractable Web Crypto
  key. Stable command, temporary, and idempotency IDs survive reload. Commands
  sync individually, classify retryable/terminal failures, never fake success,
  delete encrypted PHI after acknowledgement, retain only minimum receipt
  metadata, and clear on sign-out. The service worker excludes all `/api/`
  responses; Outreach PHI is not stored in `localStorage`.
- Campaigns, visits, screenings, vaccinations, referrals, specimens, documents,
  OCR, NIN, public signup/OTP, new Identity persons, and EHR clinical ingestion
  remain fail-closed because active product evidence did not justify them.
- Final local evidence: Outreach lint/typecheck/build and 6 suites/13 tests;
  EHR lint/build and 27 suites/89 tests; shared-client typecheck/build; Identity
  contract verification, typecheck, and production build; complete root build;
  independent Outreach live/ready 200; one-origin gateway forwarding confirmed
  by the Outreach-owned `FACILITY_REQUIRED` Problem Details response; runtime
  role/catalog verification; full rollback-only schema/RLS suite; migration
  checksum and zero-pending final plan; and `git diff --check`. Docker is not
  available, so its build is statically reviewed only. The frontend has no
  browser test runner; actual reload/reconnect/device and storage-quota behavior
  remains explicit external device acceptance, not claimed local evidence.

- Pharmacy inventory found EHR-owned versioned prescription intent, an empty
  EHR Pharmacy stub, no Pharmacy persistence or authoritative dispensing, no
  inventory/stock/refill lifecycle, an unavailable UI placeholder, and a
  fail-closed OCR historical-medication classification. The authoritative
  classification is in `docs/PHARMACY_EXTRACTION_INVENTORY.md`.
- Migration `0023_pharmacy_domain_foundation.sql`
  (`f05f66c9d28ff571b1e88290ba39fb54c1cbf7f52ef100a801d605c5e246c654`)
  adds forced-RLS Pharmacy work items with immutable exact active EHR
  prescription snapshots, acceptance events, one explicit full dispensing per
  item in this slice, append-only reversal, provenance-complete imported
  medication evidence with activity `unknown`, and minimum outbox events.
  Acceptance is not dispensing; imported evidence is not a prescription or
  dispensing; dispensing is not administration.
- `hid_pharmacy_runtime` is a NOLOGIN/non-owner/non-BYPASSRLS Pharmacy-only
  role. `hid_pharmacy_api_runtime` composes it with append-only audit.
  `hid_api_runtime`, EHR, OCR, OCR-worker and Lab cannot mutate Pharmacy;
  Pharmacy cannot create Identity patients or mutate EHR/Lab/OCR. The local
  role bootstrap and assertions pass.
- `services/pharmacy-api` owns Pharmacy controllers, DTOs, domain/application
  service, independent Identity authorization, workload verification,
  persistence, semantic audit/outbox transactions, tests, configuration,
  health/readiness, and a Lab-consistent Dockerfile. EHR's old empty Pharmacy
  module is removed, leaving no double writer.
- `packages/api-client` now exports the bounded Pharmacy client. EHR exact
  prescription handoff and OCR medication import propagate bearer or session
  cookie user evidence, facility, purpose, correlation and idempotency context
  while using a separate Pharmacy workload credential. Cookie mutations also
  propagate Origin and CSRF evidence. Production requires HTTPS issuer/JWKS,
  audience and exact EHR/OCR subjects with rotating mounted token files;
  development uses a distinct process-generated ephemeral secret.
- OCR `create_imported_medication_evidence` is enabled only after governed
  validation and canonical-patient confirmation. The Pharmacy import can never
  create active intent, work, dispensing, refills, stock mutation or
  administration. The review UI now maps the validated Pharmacy candidate to
  this exact operation; no Pharmacy operations UI was invented.
- The gateway routes `/api/v1/pharmacy/*` to port 3004. Local service tests
  cover production config, workload subjects, DTO separation, break-glass
  mutation denial, accepted-versus-dispensed state and idempotent replay. EHR
  tests cover stale/draft handoff rejection and the exact active snapshot.
  Database acceptance covers duplicates, exact snapshots, explicit dispensing,
  preserved reversal, OCR separation, RLS tenant denial, break-glass denial,
  cross-domain grants, audit and atomic outbox.
- Final local evidence: Pharmacy lint/typecheck/build and 7 suites/15 tests;
  EHR lint/build and 26 suites/87 tests; shared-client typecheck/build; EHR
  frontend and complete root production build; Pharmacy live/ready 200;
  gateway forwarding confirmed by the Pharmacy-owned RFC 7807 401 response;
  role verification and full rollback-only schema/RLS suite pass; final plan is
  `0 pending migration(s)`; `git diff --check` passes. Docker is unavailable,
  so only static Dockerfile/input/secret-copy validation was possible. No
  production deployment claim is made.

- Lab physical extraction is implemented at `services/lab-api` on port 3003. Lab controllers, services, DTOs, and tests moved out of EHR; EHR laboratory-order intent remains EHR-owned. `packages/api-client` provides the bounded typed Lab client used by EHR exact-version acceptance and OCR publication. Production workload identity is now implemented as a separate asymmetric JWT from the user bearer: callers read rotating mounted token files per request, and Lab validates configured HTTPS issuer/JWKS, audience, expiry/signature, and distinct exact EHR/OCR subjects. Local orchestration retains its process-generated ephemeral credential; production rejects local-secret mode. Lab configuration was narrowed to actual Lab dependencies and no longer requires copied scanner, NIN, storage, or workload-database settings. `hid_lab_api_runtime` remains Lab plus append-only audit only; migrations `0001`–`0022` remain unchanged with zero pending. Lab 10/10 suites (25 tests), EHR 25/25 suites (83 tests), both typecheck/build paths, shared-client build, isolated simultaneous startup, Lab live/ready 200, and gateway routing pass. Previously accepted database/RLS evidence was unaffected and not rerun. External evidence remains pending for a live workload issuer/JWKS/token mount, environment-specific `hid_lab_api_runtime` login, Docker build, and deployment; no production-readiness claim is made. Transitional Lab UI remains in EHR.

- Governed Lab manual-result lifecycle is locally accepted through additive migrations `0021` (`b85b587ce59aaafd7818d5ccbccdd33a874b4d68094a02dce85d1ebda8d7d5f2`) and `0022` (`03442b7281f7c56381f4fe8b817c588926da1df1da278f8f8b33defc88c77d35`). Exact-version independent verification, separate release, immutable evidence, released-history reads, and post-release unverified revisions are implemented. Runtime role verification, catalog assertions, the rollback-only schema/RLS suite, 28/28 server suites (94 tests), and server/EHR production builds pass; final migration plan is zero pending.

- Identity is the only canonical patient authority in the active backend.
- No active first-party frontend Supabase/database SDK path was found in the
  initial runtime scan.
- PostgreSQL migrations `0001` through `0017` exist for platform control,
  identity/authentication, consent/audit, EHR records, authorization, least
  privilege, integrity, document binding, and governed consent/audit commands.
- Host-terminal `db:plan` evidence reports `0 pending migration(s)` through
  `0012`; the ledger records checksum
  `8fef1dedd4c3e4b47b49353d9f5264fcf7f38746070a20effc71e716bce732e5`
  for the applied break-glass correction.
- Additive migration `0011_governed_nin_registration.sql` now adds encrypted
  keyed NIN bindings, facility-scoped registration cases, duplicate candidates,
  append-only registration events, RLS policies, and explicit review
  idempotency. Host migration-ledger evidence now confirms it is applied in the
  current local development database; production execution remains separate.
- Additive migration `0012_narrow_break_glass_authorization.sql`, together with
  the explicit post-creation evaluation time in the rollback-only test, makes
  break-glass authorization read-only, emergency-purpose-only, reasoned,
  exact-actor/membership/patient/facility, active, time-bounded, and revocable.
  Normal consent remains directive-aware and unchanged.
- The NestJS correlation middleware now uses the NestJS 11-compatible named
  wildcard `forRoutes('{*path}')`; no deprecated wildcard remains in active API
  source.
- Local ports are centralized and conflict-checked in `scripts/ports.mjs`:
  gateway 3000; APIs 3001-3006; direct UIs 3100-3104.
- The root gateway passes EHR UI port 3101 and EHR API port 3002 explicitly,
  while users continue to browse only `localhost:3000`.
- Verified NIN resolution is body-based and provider-abstracted. Unmatched
  verified NINs create `pending_new_identity_approval` or `review_required`
  cases; only `approved_new_identity` may issue a new canonical patient UUID
  and HID. Existing UUIDs remain unchanged.
- The first consumed shared technical package is now
  `packages/api-client/`, used by the EHR client for normalized API URLs,
  bounded abortable no-store requests, timeout handling, and JSON decoding;
  Identity now consumes its shared timeout/abort primitive for REST, admin,
  presigned uploads, and migration capture while retaining Identity-owned auth
  and domain semantics.
  Domain/auth parsing remains application-owned.

## Files changed in earlier implementation phases (historical ledger)

- `scripts/ports.mjs` - central validated development port registry.
- `scripts/dev.mjs` - registry-backed gateway, EHR UI, and API startup.
- `identity/hid-unified-package/vite.config.ts` - registry-backed proxy targets.
- `ehr/vite.config.ts` - registry-backed direct UI port.
- `services/ehr-api/src/config/environment.ts` - EHR API default port 3002.
- `services/ehr-api/.env.example` - documented EHR API port 3002.
- `ehr/README.md`, `ehr/ARCHITECTURE.md` - current local topology.
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` - authoritative port allocation.
- `docs/TASK.md` - persistent execution state.
- `packages/api-client/src/index.ts` - shared raw timeout/abort transport plus
  JSON request behavior.
- `identity/hid-unified-package/src/lib/identityClient.ts` - Identity-owned
  session/CSRF client using the shared transport timeout primitive.
- `identity/hid-unified-package/src/lib/hidApi.ts`,
  `identity/hid-unified-package/src/services/adminDashboard.ts`, and
  `identity/hid-unified-package/src/features/migrate/api/migrationCapture.ts` -
  shared transport consumption without moving domain semantics.
- `ehr/src/api/client.ts` - shared transport for API and presigned document
  uploads.
- `scripts/local-environment.mjs` and `scripts/dev.mjs` - deterministic local
  env-file precedence with server secrets isolated to the API child process.
- `services/ehr-api/scripts/apply-migrations.mjs` - local env-file loading for
  non-production migration commands only.
- `services/ehr-api/src/health.controller.spec.ts` - negative readiness coverage for
  PostgreSQL and object-storage dependency failures.
- `services/ehr-api/database/runtime-grants.sql` - corrected Identity, EHR,
  transitional API, append-only audit, scanner, migration, and schema-test
  role boundaries, including only the exact EHR authorization function and
  read-only scanner evidence needed by the rollback-only schema test.
- `services/ehr-api/database/tests/runtime-roles.integration.sql` - catalog
  assertions for role attributes, ownership, cross-domain access, and audit
  append-only privileges.
- `services/ehr-api/database/tests/schema.integration.sql` - deterministic use of a
  provisioned NOLOGIN schema-test role instead of creating roles in the data
  transaction, with positive and negative break-glass authorization cases.
- `services/ehr-api/scripts/bootstrap-database-roles.mjs` and package scripts -
  idempotent administrator-only role provisioning and verification.
- Former `ehr/server/src/ocr/ocr.types.ts` and `ocr-lifecycle.ts` - provider-neutral
  OCR contracts and an explicit provisional extraction/validation/publication
  state boundary.
- Former `ehr/server/src/ocr/ocr-lifecycle.spec.ts` - negative lifecycle and immutable
  clean-source eligibility coverage.
- Former `ehr/server/src/ocr/ocr.service.ts`, `ocr.controller.ts`, and `ocr.module.ts` -
  authenticated OCR job creation/read/retry/extraction-list/validation API with
  source-patient reauthorization and atomic audit persistence.
- Former `ehr/server/src/ocr/dto/` - validated provider-neutral creation, retry, and
  human-validation contracts.
- `services/ehr-api/database/runtime-grants.sql` - separate `hid_ocr_runtime` and
  command-only `hid_ocr_worker` boundaries; the transitional API aggregate
  inherits OCR persistence without granting EHR or Identity mutation to OCR.
- `services/ocr-worker/` - independently runnable worker, isolated
  PostgreSQL command repository, exact S3 version/digest reader, provider-neutral
  adapter boundary, real synchronous/async Amazon Textract adapter, bounded
  polling/backoff, lease renewal, safe structured logging, and graceful drain.
- Former `ehr/server/src/ocr/ocr-publication-policy.ts`, expanded OCR DTO/service/
  controllers, and `ehr/src/api` contracts - explicit review disposition,
  patient confirmation, publication routing, typed client calls, and negative
  target/retry policy.
- `services/ehr-api/src/ehr/clinical-notes/clinical-notes.service.ts` - EHR-owned
  imported-note command that atomically creates a draft note, first revision,
  clinical idempotency result, semantic audit, and immutable OCR provenance.
- Former `ehr/server/src/lab/` - Lab-owned imported external evidence API/service,
  immutable observation ingestion, canonical-patient authorization, semantic
  audit, idempotency, and extractable OCR publication command boundary.

## Migrations created in this phase

- `services/ehr-api/database/migrations/0011_governed_nin_registration.sql` -
  protected identifier and registration-case schema.
- `services/ehr-api/database/migrations/0012_narrow_break_glass_authorization.sql` -
  additive, least-privilege emergency read authorization correction.
- `services/ehr-api/database/migrations/0013_durable_ocr_persistence.sql` - durable
  OCR jobs, immutable extractions/validations/events, bounded retry, atomic
  worker claims, constrained workload commands, RLS, and transactional outbox.
- `services/ehr-api/database/migrations/0014_ocr_worker_leases.sql` - immutable-source
  claim payload, expiring lease/token ownership, stale-claim recovery, guarded
  renew/complete/fail commands, and atomic workload audit evidence.
- `services/ehr-api/database/migrations/0015_ocr_claim_column_resolution.sql` -
  additive PostgreSQL output-column resolution correction; applied `0014`
  remains unchanged.
- `services/ehr-api/database/migrations/0016_governed_ocr_validation_publication.sql`
  - reviewer disposition/canonical candidates, append-only patient confirmation,
  durable lease-protected publication commands, RLS, and EHR import provenance.
- `services/ehr-api/database/migrations/0017_lab_imported_evidence.sql` - Lab-owned
  imported evidence/observation persistence, exact OCR provenance constraints,
  forced facility/patient RLS, immutable evidence, and Lab outbox state.
- `services/ehr-api/database/migrations/0018_lab_work_items.sql` - exact-version EHR
  order acceptance into immutable Lab-owned operational work.
- `services/ehr-api/database/migrations/0019_lab_accessions_specimens.sql` - governed
  Lab accession, specimen requirement, physical specimen custody, lifecycle
  history, idempotency, optimistic concurrency, RLS, and outbox foundation.
- `services/ehr-api/database/migrations/0020_lab_test_execution_results.sql` - exact
  received-specimen/requested-test execution and immutable manual unverified
  result revisions with RLS, concurrency, audit, and outbox.

## Verification state from earlier implementation phases (historical ledger)

- Identity `npm run build`: passed after shared transport consolidation,
  including identity contract verification; non-fatal large-chunk/plugin
  timing warnings remain.
- Identity `npm run verify:api`: passed after asserting shared transport use.
- Identity `npm run verify:migrate`: passed after shared transport
  consolidation.
- EHR `npm run build`: passed after moving presigned document upload timeout
  handling to the shared transport.
- EHR API `npm run lint`: passed.
- EHR API `npm test`: 16 suites and 55 tests passed, including negative health
  dependency checks before host acceptance; after the first OCR slice, 17
  suites and 60 tests passed; after durable OCR persistence, 18 suites and 63
  tests pass. Focused worker tests add 3 suites and 8 passing tests for
  fail-closed configuration, test-provider restriction, exact-version digest
  enforcement, provider ordering, success/failure persistence, and PHI-safe logs.
  Governed validation/publication and owning-EHR provenance coverage bring the
  API total to 23 suites and 78 tests.
- EHR API `npm run build`: passed after the break-glass authorization slice.
- PostgreSQL 16.14 isolated compile of migration `0012`: passed, and a minimal
  authorization matrix passed for valid emergency read, expiry, revocation,
  actor/patient/facility mismatch, write/arbitrary denial, purpose/reason
  requirements, normal consent, deny precedence, and emergency override. This
  is focused SQL evidence, not a replacement for the full host migration and
  schema/RLS test. Reapplying the migration over the same signature also
  preserved an existing exact execute grant in the isolated PostgreSQL check.
- Port registry default and duplicate-port rejection checks: passed.
- Root `npm run dev` startup: passed for the gateway on 3000, EHR UI on 3101,
  and API on 3002 using the server-local environment file. No deprecated
  wildcard warning appeared.
- Direct `GET /api/v1/health/live`: HTTP 200, `{"status":"ok"}`.
- Direct `GET /api/v1/health/ready`: HTTP 200, `{"status":"ready"}`. This
  proves the API's configured PostgreSQL connection and explicitly disabled
  local storage adapter passed their readiness checks; it is not migration
  or least-privilege evidence.
- Gateway `GET /api/v1/health/live`: HTTP 200.
- Host `db:dry-run` and `db:migrate` passed for migration `0012` against the
  actual local PostgreSQL 16.14 `hid` database.
- Host `db:bootstrap`, `db:verify-roles`, and
  `runtime-roles.integration.sql` passed. Runtime and test roles remain
  NOLOGIN, non-superuser, non-`CREATEROLE`, non-`CREATEDB`, and non-BYPASSRLS.
- The full host `schema.integration.sql` completed through its intentional
  `ROLLBACK`. Coverage passed for active, expired, revoked, wrong-patient,
  wrong-actor, wrong-membership/facility, invalid-reason, invalid-purpose,
  write, and administrative break-glass cases; normal consent, deny
  precedence, RLS, audit, NIN registration, and exact scanner evidence also
  remained valid.
- Final host `db:plan` reports `0 pending migration(s)`.
- Host `db:plan` identified only migration `0013` with checksum
  `dcda6ef782248722ae3440f104d89fdeb747bf674b0e5347368f8c745239a20d`;
  `db:dry-run`, `db:migrate`, role bootstrap/verification, catalog assertions,
  and the full rollback-only schema/RLS suite passed. Final plan remains zero
  pending migrations.
- Host `db:dry-run` and `db:migrate` passed for additive migrations `0014`
  (checksum `d6d7495ef8a35750c999e38d06bfda8477c60fb2e27c95d558774a8a5f17bc7b`)
  and `0015` (checksum `718b455dfc9b9667bf82b403884e613bb08eefb145501c340d377e873822215f`).
  Role bootstrap/verification and the updated rollback-only full schema suite
  pass locally through their intentional `ROLLBACK`.
- Host `db:dry-run` and `db:migrate` passed for additive migration `0016`
  (checksum `e4bb1e57131cab2bc31a17a14d7ea5a59fc270aa3e7880c9e876810a05687d4e`).
  Role provisioning/verification and the expanded rollback-only schema suite
  pass, including wrong-patient confirmation rejection and explicit
  validation-version-bound document-only publication.
- Host `db:dry-run` and `db:migrate` passed for additive migration `0017`
  (checksum `d16c010051c0656c5920416f463c6f877132a3b60202cc0122eec48bce35f7fb`).
  `hid_lab_runtime` provisioning and catalog verification pass. The expanded
  full rollback-only schema/RLS suite passes with imported-evidence
  immutability, atomic observation/outbox creation, and Facility B denial.
  Final `db:plan` reports `0 pending migration(s)`.
- OCR database coverage proves nullable patient association, wrong-patient
  rejection, database idempotency conflicts, cross-facility denial, exclusive
  `SKIP LOCKED` processing claims, provider callback replay, safe failure,
  bounded retry/attempt increments, immutable extraction, preserved human
  correction evidence, and atomic lifecycle outbox rows.
- `git diff --check`: passed.
- Docker CLI/Compose discovery: unavailable (`docker: command not found`), and
  Docker was not installed as instructed.

## Known blockers and external dependencies

- PostgreSQL is installed as PostgreSQL 16.14 with cluster `16/main`, port
  5432, and the host log shows loopback listening on `127.0.0.1` plus the
  `/var/run/postgresql` socket. The sandbox cannot inspect the real service
  manager or connect directly: `systemctl` and `pg_isready` are namespace or
  permission limited, and the unsandboxed inspection request was rejected by
  the managed reviewer with external HTTP 403.
- Sanitized local API configuration is `host=localhost`, `port=5432`,
  `database=hid`, `user=postgres`, `DATABASE_SSL=false`, and
  `STORAGE_MODE=disabled`. The current API readiness and host migration plan
  confirm PostgreSQL access, but the application still uses an administrator
  credential until environment-specific runtime login membership is
  provisioned.
- The ordinary sandbox still cannot connect directly to loopback PostgreSQL,
  but approved host execution supplied the required local acceptance evidence.
- Production NIN/KYC credentials are unavailable. Provider abstraction, safe
  unavailable behavior, test adapters, protected storage, and
  registration-case logic are implemented; a real provider remains required
  for production use.
- Production AWS resources, deployment, migration cutover, and legal/clinical
  approvals are outside current repository authority.
- No live AWS Textract/S3 credentials are available in this checkout. Adapter
  construction and deterministic local behavior are verified; a real provider
  request, IAM/KMS policy validation, and production deployment evidence remain
  explicitly pending.
- Lab owns its extracted workflow and evidence boundary. Pharmacy now owns its
  extracted minimum work/dispensing/reversal/import boundary. OCR Pharmacy
  publication creates only historical medication evidence and has no
  dispensing path. The governed OCR review UI remains integrated into the EHR
  encounter workspace.

## Lab imported-evidence checkpoint

- Current ownership map: EHR retains `ehr.lab_requests` as clinical order
  intent; there was no active Lab result authority, API, repository, or table.
  The frontend Lab module remains an explicit unavailable placeholder. The new
  `LabModule` is the first real Lab-owned clinical evidence boundary.
- `POST /api/v1/lab/imports` and `GET /api/v1/lab/imports/:importId` create/read
  authorized, facility-scoped imported external evidence using canonical
  Identity patient UUIDs. The command is idempotent and requires an authorized
  source document and bounded observations.
- `lab.imported_evidence` is always `IMPORTED_EXTERNAL`; immutable
  `lab.imported_observations` never imply HID accession, specimen collection,
  instrument execution, QC, or Lab-staff verification. No second patient store
  or mutable EHR result copy was introduced.
- OCR LAB publication now supports `create_imported_lab_evidence` only after
  governed validation and current patient confirmation. OCR calls the exported
  Lab service, which atomically creates Lab evidence, observations, semantic
  audit, and `LabImportedEvidenceCreated` outbox evidence. The Lab row preserves
  document, OCR job, extraction, validation ID/version, publication, reviewer,
  publishing actor, patient, facility, and correlation references. Retrying the
  publication resolves to the same publication-unique Lab resource.
- `hid_lab_runtime` is NOLOGIN, non-superuser, non-BYPASSRLS and owns only Lab
  import/observation/outbox persistence. EHR and OCR roles cannot write Lab
  tables; Lab cannot create Identity patients or mutate EHR/OCR tables. The
  transitional `hid_api_runtime` explicitly aggregates the Lab role.
- Forced Lab RLS binds reads/writes to server transaction facility and current
  canonical-patient consent. Break-glass is rejected for imports. Stable
  imported evidence and observations are append-only; amendment workflow is
  intentionally deferred rather than overwriting history.
- Backend strict lint, 26 suites/86 tests, and production build pass. The EHR
  production build passes with LAB publication enabled and Pharmacy remaining
  unavailable. Migration dry-run/apply, role bootstrap/verification, the full
  rollback-only schema/RLS suite, final zero-pending plan, and `git diff
  --check` pass.
- Remaining Lab functionality: EHR-order acceptance, accessioning, specimens
  and custody, native execution, QC, preliminary/final verification,
  amendments/corrections, critical-result workflow, dedicated Lab UI/service
  deployment, and authorized Lab read integration beyond the stable import
  reference shown by OCR publication.

## Governed OCR review UI checkpoint

- `ehr/src/components/clinical/OcrReviewWorkspace.tsx` is the permission-aware
  OCR Review tab beside the existing encounter forms and document upload.
- It lists server-authorized encounter documents and requests a short-lived
  download URL only while the selected source preview is open. No URL, source
  text, correction, or other PHI is written to browser persistence.
- Wide layouts compare the source preview and extracted candidate side by side;
  the existing responsive grid stacks them on smaller screens. Original OCR
  text and per-field values remain read-only while corrections are displayed
  and submitted separately with explicit ACCEPT/CORRECT/REJECT dispositions.
- Reviewers deliberately confirm the displayed canonical patient, select an
  actual backend classification, provide a reason, and create a validation.
  Validation and publication are separate actions. EHR publication creates an
  imported draft note; document-only publication retains governed evidence.
- Lab and Pharmacy classifications were initially selectable while publication
  remained unavailable; both now use their owning import boundaries. Pharmacy
  creates only activity-unknown historical medication evidence. UNCLASSIFIED
  cannot publish.
  Retry is offered only
  for backend-declared transient publication failures; terminal failures do
  not loop or retry automatically.
- Stale job/validation conflicts reload current evidence and require a fresh
  review. Loading guards and stable per-command idempotency keys prevent
  duplicate submits. Safe Problem Details messages are used. Server RBAC,
  facility isolation, canonical patient checks, and version gates remain
  authoritative. Break-glass context is propagated as read-only and exposes
  no confirmation, correction, validation, or publication actions.
- Minimal missing read contracts were added without a migration: authorized
  encounter document metadata and latest authorized OCR job by document. The
  typed EHR client now parses documents, short-lived downloads, jobs,
  extractions, validations, confirmations, and publications.
- The frontend has no configured test runner, so no framework was introduced
  solely for this slice. Its TypeScript production build passes. Backend lint,
  all 24 suites/80 tests (including the new read-query DTO contract checks),
  and the Nest production build pass; no regression was found. `git diff
  --check` passed for that UI checkpoint. Applied migrations `0001`-`0016`
  remained unchanged during the UI work; the later Lab slice added `0017`.
- Remaining OCR work: live AWS/IAM/KMS execution evidence, transactional outbox
  delivery, broader governed patient-match candidates, and Bedrock if approved.

## Architecture decisions encountered

- Preserve canonical Identity patient UUIDs and existing HID relationships.
- Never create a patient solely because a verified NIN is unmatched; use a
  registration case, duplicate search, review, and approved-new-person state.
- Preserve the one-origin browser experience while services use independent
  loopback ports.
- Do not move applications or create target directories before real code uses
  them.
- Do not restore retired Supabase/browser database access or duplicate systems.
- Historical modular-pool placement was superseded by extracted service pools
  and per-service aggregate roles; no active runtime uses `hid_api_runtime`.

## Phase 0 scan classification

- The active EHR frontend uses `ehr/src/api/client.ts` as its typed API/domain
  boundary; its transport primitives now come from `packages/api-client/`.
- Identity retains separate domain clients (`identityClient`, `hidApi`, and
  focused admin/service clients), but their raw timeout/abort transport is now
  consolidated through `packages/api-client/`. Cookie/CSRF behavior, auth
  state, endpoint semantics, caching, and domain response validation remain in
  their owning modules. The only remaining direct Identity `fetch` loads the
  public static facility-directory workbook.
- Remaining browser persistence is limited to an opaque auth-session hint,
  opaque migration client UUIDs, the migration workspace handle, and the
  opaque Outreach OTP challenge. Facility setup and Outreach contact/profile
  data no longer persist in browser storage.
- Lab, Pharmacy, OCR, and most Outreach code in the active tree are bounded
  context/reference modules. Upstream material is primarily retired hosted
  identity backend logic or reference UI and is not an authority to restore.
- No active first-party Supabase runtime path was found, and no Docker/Compose
  implementation is currently consumed. Creating empty target directories or
  restoring retired provider infrastructure remains out of scope.

## Phase 0 repository and upstream disposition

| Area | Current repository | Upstream snapshot | Decision |
|---|---|---|---|
| Identity/auth/consent/audit | Active NestJS/PostgreSQL implementation with governed NIN cases, idempotency, RLS, and audit commands | Hosted Supabase functions and migrations | Keep the active implementation; do not restore or duplicate Supabase authority |
| EHR | Active React client and bounded NestJS clinical/document modules | Static/reference EHR and legacy hosted handlers | Keep the active API boundary and reference UI only where it improves presentation |
| Lab/Pharmacy | EHR lab-request and prescription contracts plus bounded module stubs | No independent deployable service implementation | Defer extraction until service contracts and persistence ownership are approved |
| OCR/storage | Document scan events, object binding, and disabled/S3 provider abstraction | Migration OCR/storage SQL and hosted adapters | Keep provider-neutral storage and scan contracts; defer provider workers and infrastructure |
| Docker/Compose | No Docker executable or consumed Compose environment is available locally | No authoritative replacement | Remains an external environment gate, not an empty directory scaffold |

The only reusable technical extraction made at this checkpoint is
`packages/api-client/`. No upstream item was copied blindly, and no second
patient, auth, consent, or audit system was introduced.

## Break-glass diagnostic and correction

The failing schema assertion creates a grant inside one transaction and then
calls `identity.has_active_consent_grant` without an explicit `at_time`.
`identity.activate_break_glass` records `starts_at` with `clock_timestamp()`;
the function default is transaction-start `current_timestamp`, so the fresh
grant can compare as not-yet-started. The test now evaluates at an explicit
post-creation `clock_timestamp()` without weakening authorization.

The same authorization predicate previously let any `scope = 'break_glass'`
grant satisfy any action. Migration `0012` separates normal consent from the
emergency exception: normal read/write grants remain subject to active deny
directives, while an exact active, unheld, reasoned emergency break-glass grant
can authorize `read_records` only. Wrong actor, membership, facility, patient,
expired, revoked, missing-purpose, inadequate-reason, write, and arbitrary
actions are covered by rollback-only integration assertions.

## Identity extraction checkpoint

- Inventory: `docs/IDENTITY_EXTRACTION_INVENTORY.md` records every owned,
  shared, consumer, transitional, historical, and direct-database path. The
  retired hosted/Supabase implementation remains historical only.
- Canonical continuity: `identity.patients.id` UUIDs and existing `hid_code`
  assignments are unchanged. Authentication account/subject, patient UUID,
  HID, secondary identifier, and Outreach temporary ID remain distinct.
- Registration/NIN: raw NIN remains POST-body-only, HMAC-searchable,
  AES-GCM-encrypted, provider-abstracted, and absent from logs/audit/outbox.
  Resolution never creates a patient; ambiguity remains review-required;
  explicit approval/link and HID issuance retain version and idempotency gates.
- Authorization/consent: current consent stays inside Identity without redesign.
  Facility, actor membership, permission, purpose, patient, and break-glass are
  revalidated. Break-glass remains emergency read-only and cannot mutate
  patient, HID, identifier, NIN, registration, consent, or merge state.
- Physical boundary: `services/identity-api` is independently runnable on 3001
  with only Identity dependencies. Its live endpoint is process-only and ready
  probes PostgreSQL. EHR's active composition no longer imports Auth, Identity,
  Consent, or Audit controllers; inert compatibility source is not registered.
- Consumers: EHR, Lab, Pharmacy, and Outreach use
  `packages/api-client/src/identity.ts`; OCR uses the same EHR adapter. User and
  workload credentials, facility, purpose, correlation, CSRF/Origin, timeout,
  and Problem Details survive the boundary. No active consumer raw-fetch path
  or direct Identity table mutation remains.
- Workload identity: local orchestration generates separate per-caller secrets.
  Production requires issuer/JWKS, the Identity audience, signature/expiry,
  exact EHR/Lab/Pharmacy/OCR/Outreach subjects, and rotating mounted tokens;
  local secrets fail configuration in production.
- Database: applied migrations `0001`-`0024` were not modified in this phase.
  Additive applied `0025_identity_transactional_outbox.sql` adds forced-RLS,
  minimum-necessary registration events. Identity domain state, semantic audit,
  and outbox writes are atomic and raw identifier/HID payload keys are rejected.
- Roles/RLS: `hid_identity_api_runtime` is Identity plus append-only audit;
  `hid_ehr_api_runtime` is EHR plus audit with no OCR or Identity mutation. Retired
  `hid_api_runtime` is privilege-free. All runtime roles are NOLOGIN,
  non-owner, non-BYPASSRLS. Consumer mutation and wrong/missing context remain
  denied in catalog and rollback-only schema tests.
- Gateway: `/api/v1/auth/*`, `/api/v1/identity/*`, and `/api/v1/audit/*` route
  to 3001 before the EHR fallback. The old EHR Identity route is 404; gateway
  and direct extracted routes return Identity-owned Problem Details.
- Evidence: Identity typecheck/build and 13/13 suites (39 tests); EHR
  lint/build and 29/29 suites (94 tests); Lab 11/11 (31), Pharmacy 7/7 (17),
  Outreach 7/7 (15); shared client typecheck/build; all affected service builds;
  applied migration and zero-pending plan; role/catalog verification; full
  rollback-only schema/RLS suite; independent Identity and EHR live/readiness;
  gateway cutover; and diff whitespace validation.
- External only: real workload issuer/JWKS/token mounts, environment-specific
  non-owner Identity/EHR LOGINs, external NIN provider, Docker execution,
  deployment/AWS, and representative-device Outreach acceptance. No production
  readiness claim is made from local evidence.

## Immediate pending work

1. On a Docker-capable release host, build every accepted backend and Gateway
   target, record application/base digests and sizes, generate an SBOM, run an
   image/OS scanner, inspect final layers and UIDs, and execute the full
   production-mode topology including Gateway routing, health, signals,
   restarts, and read-only token mounts.
2. After the immutable release manifest exists, complete authorized AWS account/
   region/governance design, CDK bootstrap, DNS/ACM/prefix-list/secret inputs,
   and reviewed `cdk diff`; deploy the foundation first with all desired counts
   zero.
3. Provision and deny-test eight non-owner LOGINs over verified RDS TLS, execute
   plan/dry-run/approved `0001`-`0027` migration and zero-pending/RLS acceptance,
   then prove workload issuer/JWKS/rotating token delivery, exact S3/KMS/
   Textract/EventBridge IAM, and only then raise staging desired counts.
4. Observe sanitized Sentry and PostHog events at configured external
   destinations and confirm replay remains disabled; do not use production PHI
   as test data.
5. Run install/reload/offline/reconnect/cleanup and mutation safety on
   representative real devices/browsers, including Outreach quota/key-loss/
   blocked-database cases. Desktop headless Chrome is not device evidence.
6. Keep Pharmacy inventory/refills/controlled-drug/POS/administration, OCR
   provider dashboards, broader Outreach products, and Admin clinical behavior
   out of scope until separately governed contracts exist.

## Exact next action

AWS Deployment Architecture + Infrastructure as Code is implemented and
locally synthesized without AWS access. The exact next prerequisite is a
**Docker-capable release host** executing every image/digest/layer/SBOM/scan/
runtime gate and finalizing the ten-component release manifest. After that, an
authorized platform/security review must select the AWS account/region and
approve bootstrap, domains/certificates, workload issuer/token delivery,
Secrets Manager inputs and deployment roles. Follow
`AWS_DEPLOYMENT_RUNBOOK.md`: deploy with desired counts zero, provision/verify
RDS LOGINs and migrations, prove IAM/TLS/provider prerequisites in staging,
then progressively enable workloads and edge. Authenticated sessions,
production identity/data, telemetry destinations and representative-device
offline behavior remain separate external evidence.

## Lab accession and specimen checkpoint

- Repository inspection found no current production accession/specimen logic,
  tables, API, or operational UI to reuse. Historical UI contained only an
  unsafe status string; upstream contained no LIS authority. EHR's
  `specimen_type_code` remains clinical intent, not collection evidence.
- Migration `0019` adds one immutable Lab accession per accepted work item,
  separate immutable specimen requirements, versioned physical specimens,
  accession/specimen lifecycle events, command idempotency, forced RLS, and
  minimum-necessary outbox event support.
- Lab generates globally unique non-patient identifiers from protected
  sequences: `LAB-YYYYMMDD-NNNNNNNNNN` and `SPC-YYYYMMDD-NNNNNNNNNN`. Neither
  accepts browser identifiers nor embeds HID, NIN, name, diagnosis, or other
  patient-derived PHI.
- Lifecycle states are `required`, `collected`, `received`, `rejected`, plus
  reserved history-preserving `cancelled` and `entered_in_error`. The only
  normal transitions are `required -> collected -> received` and `required ->
  collected -> rejected`. Receipt cannot skip collection; received/rejected
  states are terminal in this slice.
- Collection, receipt, and rejection are distinct Lab-owned commands. They use
  expected versions, actor/facility membership, canonical patient authorization,
  idempotency keys, immutable events, semantic audit, and atomic Lab outbox
  events. Mutation through break-glass is rejected.
- The current same-facility rule is preserved across work item, accession,
  requirement, and specimen. EHR/OCR/OCR-worker roles have no accession/specimen
  mutation grants; Lab cannot insert Identity patients.
- The transitional Lab operations UI lists actual accepted work, creates/views
  accessions, shows server-issued specimen identifiers and real states, and
  exposes collection, receipt, and reasoned rejection only when legal.
- Migration `0019` checksum is
  `cf2c9ba1097bda3e47b742191b6fa4c36c587f9430c4425a678a32e882ff285a`.
  PostgreSQL dry-run/apply, role bootstrap/verification, catalog assertions,
  the full rollback-only schema/RLS suite, and final zero-pending plan pass.
- Backend strict lint/build and 27 suites/90 tests pass. The EHR production
  build passes. No execution, analyzer, reagent, calibration, QC, preliminary
  result, final result, verification, or attestation state was created.
- Remaining Lab work includes recollection UX/command, richer catalog mapping,
  label printing, custody transfer/aliquot lineage, governed execution, result
  entry, QC, verification/amendment, critical-result handling, and independent
  Lab deployment.

## Lab test execution and result-entry checkpoint

- No active native execution/result authority was found; imported observations
  remain separate external evidence.
- Migration `0020` adds stable test executions, immutable execution events,
  stable result heads, immutable typed revisions, and result events.
- Execution starts explicitly as `in_progress` only from the expected received
  specimen version and exact accepted requested-test row, then transitions only
  to `completed`. Completion is not verification.
- Numeric/text results are source `manual`, status `entered`, and permanently
  `unverified` in this slice. Contradictory value representations fail.
- Corrections require expected result versions and reasons, append revisions,
  and never overwrite prior values. Start/completion/entry/correction use
  idempotency, canonical-patient/same-facility non-break-glass authorization,
  semantic audit, immutable events, and minimum outbox payloads without values.
- `hid_lab_runtime` owns execution/result mutation. EHR, OCR, and OCR-worker
  roles cannot mutate it; Lab cannot create Identity patients.
- The transitional Lab UI exposes received-specimen execution, completion, and
  visibly labeled manual unverified entry/history. It has no Verified, Final,
  Released, analyzer, or QC controls.
- Migration checksum:
  `f0197b82912a8d3653e3f88cddc20b18452dd6d5bab0ba64ab4bd6bedbddc932`.
  Dry-run/apply, role provisioning/verification, catalog assertions, full
  rollback-only schema/RLS integration, and final zero-pending plan pass.
- Backend strict lint/build and 28 suites/94 tests passed at this checkpoint;
  EHR production build passed. Migrations `0021` and `0022` subsequently added
  governed exact-version verification, separate release, and immutable
  released history. Remaining Lab work includes explicit failure/rerun,
  broader amendment policy, QC/instrument/reagent evidence, critical-result
  communication, and independent UI/deployment.
