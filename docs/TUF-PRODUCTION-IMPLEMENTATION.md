# TUF Production Implementation Record

This is the canonical, continuously maintained implementation record for the
HID trusted release/update pipeline. It records only evidence that has actually
been produced. A local test, source implementation, or dry run is never a
staging or production deployment claim.

## STATUS

Date: 2026-09-07

Classification: **PHASE C LOCALLY VERIFIED AND COMMITTED — STAGING NOT ACCEPTED**.
The subsequent 730-day retention correction is locally verified and remains
uncommitted pending separate authorization. Object Lock remains **UNAPPROVED / NOT CREATED**; production is locked.

Working branch: `tuf-production-release`

Audited baseline: `abc77af52f1c09831e1fcdb9c3ba1aaafd0f60b0`

The baseline worktree was clean before this branch was created. No AWS,
Cloudflare, DNS, Hostinger, Vercel, ECR, external database, staging, or
production resource was accessed or changed during the initial audit. No signing key
was generated, imported, printed, or stored.

The mandatory order is unchanged:

1. implement and verify locally;
2. deploy and validate staging;
3. complete the migration dry-run and staging-copy migration test;
4. prove backup restore and forward-version rollback;
5. obtain the required production key-custody and irreversible-action
   approvals;
6. only then consider production deployment.

Production deployment is forbidden until every preceding gate has recorded
evidence in this document.

## LOCAL COMMIT AND RETENTION CORRECTION — 2026-09-07

| Evidence | Verified value |
| --- | --- |
| Previous SHA | `abc77af52f1c09831e1fcdb9c3ba1aaafd0f60b0` |
| New immutable local SHA | `46e76cecf9e846061203c8fd68a0fcfd0c2825a5` |
| Commit message | `Implement TUF release trust and prepare protected staging gates` |
| Commit timestamp | `2026-09-07T04:11:04+01:00` |
| Commit tree | `689609263c58d9c002ad656ced78e402a072edcc` |
| Scope | 193 exact reviewed files; 46,165 insertions and 1,375 deletions |
| Reviewed inventory SHA-256 | `11dc85ec4dbbaeecbb63ba72ce8127e85026499a44a7ea39a1eb36e85503c0d1` |
| Parent/history verification | Exactly one new commit with the stated parent; no amend or history rewrite |
| Commit integrity | Commit object hash recomputed; every committed blob matched the reviewed inventory |
| Exclusion | `docs/SECURITY.md` absent from the commit diff and unchanged in the working tree |
| Security review | Independent proposed-file scan and repository secret-readiness scan reported zero findings; no secrets/private signing material or unintended artifacts found |

Pre-commit status, full worktree/index diffs, exact file inventory, tracked and
untracked whitespace checks, evidence JSON integrity and cached blob hashes
passed. Immediately after the commit, `git status --short` contained only the
untouched `docs/SECURITY.md` edit and the index was empty. The immutable file
list is recoverable with `git diff-tree --no-commit-id --name-only -r 46e76cecf9e846061203c8fd68a0fcfd0c2825a5`.
The [reviewed inventory](evidence/tuf-phase-c/files.json) is a snapshot of that
commit, not an authorization for subsequent edits; resolve its original blobs
from this exact SHA when comparing later working-tree corrections.

The user corrected retention immediately after the authorized commit completed.
That commit retains the erroneous proposal as immutable history. This correction
changes the working tree only; no new commit, amendment or push is authorized.
Post-commit canonical documentation updates also remain uncommitted so the
single-commit authorization is preserved.

> HID immutable journal/evidence retention requirement is 2 years (730 days). Any previous reference to 36,500 days was an erroneous proposal and must not be implemented.

The correction covers fixed Go journal/state/archive/evidence retention and
input bounds, AWS broker configuration/IAM limits, non-secret templates,
source-model plans, tests and runbooks. Existing staging/production bucket
defaults of 90/180 days are separate from the explicit 730-day object policy.
It does not grant creation authority or authorize shortening an existing object
lock, deletion, key creation, credential changes or a live migration.

Correction validation passed: 58 AWS tests and typecheck, all 13 Go packages
under normal/race tests with the independent Cloudflare validator required, Go
vet/module verification, 24 release tests, release/schema/template validation,
secret-readiness and whitespace checks. Tests assert literal 730-day retention
on state, publication journal, archive and evidence writes, reject 729/731-day
fixed runtime settings and shortened still-active retention, and verify IAM
limits. IAM uses 729–730 remaining days only for request-transit rounding;
writers and original-lifetime readback still require the exact 730-day duration.
No bypass, deletion, signing or cross-environment authority was added.

Both synthetic source-model plans were regenerated with 730-day policy and
verified locally: foundation SHA-256
`ac4dab2869c07fd62cb9a9417eee8067a0939f933059fd518b0eb69101ed5888`;
broker SHA-256
`e52aadcc4f685869107408709b910b288f8479c4db3843189ffccf7166d3b601`.
Their 32/86 resources remain uncreated; these are not actual account diffs.
All five corrected Go tools reproduce across separate build caches.
The old committed binaries/templates are superseded for execution. The
[retention correction evidence](evidence/tuf-phase-c/retention-correction.json)
records current hashes, changed files, commands and scoped results. Prior full
workspace/migration evidence remains historical; unrelated suites were not
rerun for this retention-only change.

The repository-wide source/documentation search found no active obsolete
retention configuration, including the former one-day IAM floor equivalent.
The required erratum above intentionally preserves the incorrect duration as
a rejected historical proposal. Two matches in an unrelated public facility
name dataset refer to business names, not retention, and remain untouched.

**No push occurred. No protected CI run exists.** GitHub protections remain
pending owner configuration; the last read-only snapshot is 2026-09-06 and was
not refreshed by any external call during this commit/correction work.
AWS/Cloudflare identifiers remain pending. Object Lock is unapproved and has not
been created. Signing/custody review remains pending. Live restore remains
unverified. Live rollback remains unverified. Staging authorization remains
pending. Data migration is not authorized; production is locked.

## COMPLETED

### Phase C starting-state preservation — 2026-09-06

Continuation began on branch `tuf-production-release` at
`abc77af52f1c09831e1fcdb9c3ba1aaafd0f60b0`, with 21 tracked modified files,
131 untracked files, and an empty index. No new commit, push, or history change
was made. The five preceding commits were `4aca793`, `328faee`, `6a247e5`,
`df4f413`, and `4f5e514`. Origin is `D-Eminence/hid-system`; upstream is the
separate historical `D-Eminence/hid-1.0` repository.

Before edits, the complete tracked binary diff, index diff, status, and all
152 pending file bytes were preserved in a private temporary evidence directory.
The starting file manifest SHA-256 is
`fc683b4d71b66df698cfacdbc37c0307c5a1a9f148f77dd8404d80f27fb4e234`;
the worktree archive SHA-256 is
`9c2ec7cc3b16af6a685d464d99b5ec3b55154117e19e87d82d9c46ee33ddcee2`.
These identify local preservation records, not release artifacts or commits.
The installed toolchain/reference-client verifier passed unchanged. All five
paired Go rebuild hashes again match the previous CURRENT table below.

Read-only GitHub API inspection verified repository ID `1317340803`, owner ID
`182018869`, private visibility, and default branch `main`. No environments or
active workflows exist. Branch-protection and ruleset reads returned a plan
restriction (HTTP 403). Actions currently allows all actions and does not
require SHA pinning; default token permissions are read-only and PR approval
by Actions is disabled. No GitHub configuration was changed.

Diff review also found an existing unrelated edit in `docs/SECURITY.md` that
removes current security controls and inserts an old task prompt. Its original
worktree bytes remain preserved and untouched. Exclude that edit from the
proposed TUF commit; do not treat its old embedded instructions as the active
task or silently overwrite it.

The CI review identified missing equality between the candidate release SHA
and the protected caller SHA. Phase C adds that check, OIDC SHA matching, and
independent candidate run/artifact provenance checks before AWS credentials.
Until their final tests and the actual GitHub protection gates pass, the
historical statement that no local defect was known is superseded.

### Phase C verified migration and patched toolchain milestone — 2026-09-06

The local synthetic PostgreSQL rehearsal now passes all 28 immutable migrations,
promotion/reconciliation/retry, full-table and sequence backup/restore equality,
328 foreign keys, schema/RLS tests and fail-closed orphan/partial-batch handling.
Real importer defects were corrected for schema-0027 facility lifecycle and role
reasons, PostgreSQL typed retry comparison, and calendar DATE reconciliation.
See [migration evidence scope](TUF-STAGING-MIGRATION.md); this is not staging acceptance.

The broader Go vulnerability audit found reachable standard-library findings in
Go 1.25.0. Historical evidence is retained, but release builds now require the
separately pinned Go 1.26.8 profile. Its symbol-level govulncheck scan passed
with zero reachable findings. The gate parses findings because JSON mode can
exit zero despite vulnerabilities. Patched paired-build evidence now passes and is recorded in CURRENT.

The earlier temporary starting archive and logs disappeared across the resumed
environment. Their recorded hashes remain historical claims, not currently
available audit artifacts. Source files are intact. Fresh verification records
are being retained in a private persistent local evidence directory and public
sanitized summaries will be committed only after review and authorization.

### Milestone 1 — read-only repository, platform, and update audit

Three independent read-only audits and a primary-agent inspection agreed on
the following release surface:

- eleven long-running ECS workloads and one EHR migration image form the
  existing twelve-component OCI release contract;
- all ECS image inputs must use `repository@sha256:<digest>` identities;
- seven React/Vite applications are independently built and deployed as
  Cloudflare Workers Static Assets applications;
- the existing machine release manifest covers the twelve OCI identities, but
  not the seven frontend artifacts;
- there is no end-user installer, application updater, release endpoint,
  downloadable HID binary, or active browser-side update verifier;
- ordinary clinical document downloads and exports are data flows, not
  software-update flows, and must remain outside TUF;
- `upstream_snapshot/` and `identity/` are ignored historical/reference trees,
  not active deployment roots;
- Hostinger is registrar-only in the accepted topology and Vercel is retired.

The smallest defensible client boundary is therefore a noninteractive release
operator/deployer. It will verify approved release targets before deriving ECS
digest parameters or frontend deployment inputs. Browsers and ECS workloads
will not receive signing capability or private-key access.

### Existing controls retained

- ECR repositories use immutable tags, scan-on-push, encryption, and bounded
  retention.
- Runtime ECS parameters reject tag-only images and accept digest-qualified
  images.
- Root verification checks digest-pinned runtime bases and the immutable
  migration ledger through migration `0028`.
- All tracked npm lockfiles use lockfile version 3 and the audited registry
  entries contain integrity values.
- The release policy already requires builds, SBOMs, vulnerability scans,
  digest comparison, staging, rollback, and evidence retention.
- Production RDS policy includes Multi-AZ, deletion protection, final snapshot
  retention, and 35-day automated backup retention; these configured controls
  are not evidence of a completed restore test.
- ECS deployment circuit-breaker rollback exists; it is not a substitute for
  a TUF forward-version rollback exercise.

### Gaps confirmed

1. No TUF root, metadata, repository generator, publisher, verifier, durable
   client state, signing adapter, or attack test exists in the audited source.
2. No repository-root GitHub Actions workflow exists. The nested workflow at
   `apps/web/.github/workflows/ci.yml` is not an active repository workflow.
3. The current release artifact gate is documentary. There is no complete
   twelve-image manifest generator/publisher, SBOM generator, scanner
   orchestrator, attestation generator, or signature verification path.
4. Frontend `dist/` trees are deployed directly. They lack deterministic
   archives, release content manifests, verified hashes, and a recorded
   rollback identity.
5. The existing `release-evidence/` prefix is inside the clinical document
   bucket. EHR can write all object keys and OCR can read all object keys, so
   that bucket cannot be a trusted TUF metadata or release-evidence boundary.
6. Staging currently accepts arbitrary digest-qualified CDK image parameters;
   it does not derive them exclusively from a verified release target.
7. Reproducibility is incomplete: some Docker build inputs are mutable, Node
   and npm patch versions are not fixed by the repository, and no provenance
   attestation is produced.
8. Package versions are inconsistent. The accepted release identity is the
   exact forty-character Git SHA plus immutable artifact digests, not npm
   package versions or the old unsigned `v1.0.0` tag.
9. ECR lifecycle retention is not yet coordinated with the supported TUF
   rollback window.
10. No TUF expiry/freshness monitor, signing anomaly alarm, repository mutation
    alarm, or verified publication canary exists.
11. No live staging deployment, migration dry-run, staging-copy migration,
    backup restore drill, TUF archive restore, or rollback drill has occurred.
12. The EHR service worker can cache the stable
    `assets/canonical-platform-runtime.js` URL cache-first. TUF does not repair
    this browser cache-generation risk; the frontend release path must do so.

### Verified reference TUF client and toolchain evidence

The supplied binary was independently rechecked and is retained only as an
interoperability/attack-test oracle. It is the upstream go-tuf example CLI, not
an HID production updater.

| Evidence | Verified value |
| --- | --- |
| go-tuf version | `v2.4.2` |
| go-tuf source commit | `f5edbde31e5507f46db2069402dc38903fe6d9d4` |
| source tree SHA-256 | `6ceb2d9979e910310c37243d27040c310c279748c57142301f980b29c2b25ebd` |
| pinned Go version | `go1.25.0 linux/amd64` |
| Go binary | `/opt/hid-release-tools/go/1.25.0/bin/go` |
| Go distribution SHA-256 | `2852af0cb20a13139b3448992e69b868e50ed0f8a1e5940ee1de9e19a123b613` (`go1.25.0.linux-amd64.tar.gz`, `59659213` bytes) |
| Go binary SHA-256 | `b93cdfdbc72f1afc3f21498c80bf3d155a44a9b95e2d690c940511051574bc25` |
| go-tuf `go.mod` SHA-256 | `d0e895542701e1bb30a3a4bbcbaddc889777968ee8d4b49bd971152d04c9e947` |
| go-tuf `go.sum` SHA-256 | `153125c407a41dfbab9b1b27b1b3c854475103c5077f3a0fa06f847f73b4f436` |
| reproducible build A SHA-256 | `6933984fa57625a361896db52b9eb8fdd9658f98327b7bd44d806096114fb351` |
| reproducible build B SHA-256 | `6933984fa57625a361896db52b9eb8fdd9658f98327b7bd44d806096114fb351` |
| installed client | `/opt/hid-release-tools/tuf-client/2.4.2/tuf-client` |
| installed client size | `12857047` bytes |
| installed client SHA-256 | `6933984fa57625a361896db52b9eb8fdd9658f98327b7bd44d806096114fb351` |

`go version -m` identifies the main package as
`github.com/theupdateframework/go-tuf/v2/examples/cli/tuf-client`. The binary
is a statically linked Linux/amd64 ELF and exposes generic `init`, `get`, and
`reset` commands. The permanent, repository-owned evidence manifest is
`tools/tuf-release/toolchain/verified-upstream-build.json`; its verifier also
checks the installed toolchain when invoked with `--require-installed`.

Audit/evidence commands included:

```text
git status --short --branch
git rev-parse HEAD
git ls-files '.github/workflows/*'
rg -n '\bTUF\b|go-tuf|tuf-client|root\.json|targets\.json' .
git verify-tag v1.0.0
git merge-base --is-ancestor v1.0.0 HEAD
sha256sum /opt/hid-release-tools/go/1.25.0/bin/go
/opt/hid-release-tools/go/1.25.0/bin/go version
sha256sum /opt/hid-release-tools/tuf-client/2.4.2/tuf-client
stat --format='%s' /opt/hid-release-tools/tuf-client/2.4.2/tuf-client
file /opt/hid-release-tools/tuf-client/2.4.2/tuf-client
/opt/hid-release-tools/tuf-client/2.4.2/tuf-client --help
```

### Milestone 2 — trust, repository, release, and recovery architecture

ADR-035 records the accepted source architecture. This is an implementation
decision, not approval to provision keys or deploy either environment.

#### Protection boundary and target namespace

TUF is release-admission control for operators and automation. It does not
replace ECR content-addressed storage, browser TLS, application authorization,
clinical document authorization, or database migration controls.

Staging and production use unrelated roots, role keys, metadata sequences,
repositories, client-state directories, archives, publisher credentials, and
hostnames. Defense-in-depth environment prefixes remain inside each repository:

```text
environments/{staging|production}/
  channels/current.json
  releases/{release-id}/
    release-bundle.json
    edge/frontend-worker.mjs
    edge/apex-redirect-worker.mjs
    frontends/{web|ehr|lab|pharmacy|ocr|outreach|admin}/
      assets.tar
      content-manifest.json
      sbom.spdx.json
      scan-summary.json
      provenance.intoto.jsonl
    oci/{component}/
      sbom.spdx.json
      scan-summary.json
      provenance.intoto.jsonl
    migrations/
      ledger.json
      verification.json
    promotion/
      staging-acceptance.json
      migration-dry-run.json
      staging-copy-migration.json
      backup-restore.json
      rollback-drill.json
      approval.json
```

Release IDs are immutable and signer allocated:
`^r[0-9]{10}-g[a-f0-9]{40}$`. A production command requires an explicit
release ID. `channels/current.json` is discovery only and cannot select a
production deployment implicitly.

OCI blobs remain in ECR. The release target binds the exact expected repository
and digest for all twelve governed image identities. The seven frontend trees
become deterministic uncompressed USTAR targets. Raw scan detail and sensitive
build evidence remain in the private archive; public TUF evidence is bounded,
PHI-free, secret-scanned summaries and cryptographic hashes.

The primary strict Draft 2020-12 release-bundle contract contains:

- schema version, monotonic release sequence, exact Git SHA, creation time, and
  source repository;
- a canonical `artifact_set_sha256` over the Git SHA, ordered twelve OCI
  digests, ordered seven frontend archive/content/worker hashes, and migration
  ledger identity;
- the environment/repository/account/region identity;
- exactly twelve ordered OCI records, including SBOM, scan-summary, provenance,
  platform, size, and immutable digest evidence;
- exactly seven ordered frontend records, including deterministic archive,
  file manifest, worker, host, API origin, cache generation, SBOM, scan, and
  provenance evidence;
- the exact migration range `0001` through `0028` and ledger hash;
- candidate or staging-validated promotion evidence.

Production promotion reuses the exact staging-validated artifact-set hash and
target bytes. Rebuilding production artifacts is forbidden. Schema validation
is supplemented by code checks for target containment, TUF length/hash equality,
component order, ECR repository/account/region allowlists, hostname/origin
allowlists, migration identity, artifact-set equality, and promotion evidence.

#### Repository hosting and publication

Two dedicated Cloudflare Workers Static Assets services expose only public,
read-only TUF content:

- `https://updates.staging.healthidentitydirectory.com`;
- `https://updates.healthidentitydirectory.com`.

A Worker version captures the serving code and all static assets as one unit.
The publication pipeline uploads a complete version, validates its versioned
preview URL with a pinned root and disposable client state, and only then makes
that exact version a 100% deployment. Gradual or split TUF deployments are
forbidden. There is no remote write API and no runtime signing binding.

The repository uses consistent snapshots. Every released root version remains
available permanently; targets use hash-prefixed physical names; targets and
snapshot metadata use versioned physical names; `timestamp.json` is the only
unversioned metadata path. Logical target names never include physical hash
prefixes. `timestamp.json` is served `no-store`; versioned metadata and hashed
targets are immutable; all other unversioned metadata must revalidate.

Every complete generation and publication journal is written before public
promotion to a dedicated private, TLS-only, KMS-encrypted, versioned AWS release
archive. The archive is not the clinical document bucket, is inaccessible to
ECS tasks, and uses Object Lock plus CloudTrail data events. Staging and
production use separate buckets and encryption keys. Enabling Object Lock is
an irreversible bucket decision and therefore remains a deployment approval
gate even though its source definition can be tested locally.

Production artifacts are retained for at least ten accepted releases and 180
days, whichever is greater; staging retains at least five releases and 90 days.
All root versions are permanent. Cleanup must prove that no accepted or rollback
release references an artifact before deletion. ECR retention is governed by
the same rule, not merely by an independent count-based lifecycle policy.

#### Keys, thresholds, expiry, and rotation

| Role | Production custody | Threshold | Maximum lifetime | Renewal/alert contract |
| --- | --- | ---: | ---: | --- |
| root | three offline hardware-backed custodians, geographically/recovery separated | 2 of 3 | 365 days | ceremony begins 90 days before expiry |
| targets | three offline hardware-backed release/security custodians | 2 of 3 | 90 days | renew or release by 30 days before expiry |
| snapshot | two independent non-exportable AWS KMS keys; signer role may use one | 1 of 2 | 7 days | refresh at most every 72 hours; alert at 72/24 hours |
| timestamp | two independent non-exportable AWS KMS keys; signer role may use one | 1 of 2 | 24 hours | renew at most every 12 hours; alert at 8/4 hours |

Staging exercises the same thresholds with completely separate keys. Local
tests generate only disposable ephemeral keys in private temporary directories.

The implementation baseline for KMS-backed online roles is
`ECC_NIST_P256`/`ECDSA_SHA_256`, which directly matches go-tuf v2.4.2's
`ecdsa-sha2-nistp256` path and KMS DER signatures. The adapter hashes the
canonical signed payload once with SHA-256 and calls KMS with
`MessageType=DIGEST`; IAM constrains `kms:SigningAlgorithm`. RSA-PSS SHA-256 can
be supported only if policy requires RSA. P-384/P-521, secp256k1, ML-DSA, SM2,
and KMS Ed25519 are not production choices for this pinned implementation
without a new interoperability gate.

The exact production hardware provider, custodians, recovery holders, and the
final P-256 policy choice require explicit approval before key creation. No
private root or targets key may enter AWS, Cloudflare, Git, GitHub secrets,
environment variables, logs, markdown, or a networked build runner.

Root rotation is sequential. A new `N+1.root.json` must satisfy both the old and
new root thresholds before publication. Clients never skip a root version.
Targets/snapshot/timestamp key changes are authorized by a new root version;
the new metadata is proven before the old key is removed. Every root version
and ceremony record is retained. Compromise response revokes the key through a
higher root version and publishes fresh higher-version metadata; it never edits
history.

#### Separation of duties and CI

| Capability | May build | May sign targets | May sign freshness | May publish | May deploy workloads |
| --- | ---: | ---: | ---: | ---: | ---: |
| unprivileged CI builder | yes | no | no | no | no |
| offline root/targets custodian | no | assigned role only | no | no | no |
| protected freshness-request job | no | no | request only; no KMS permission | no | no |
| fixed AWS freshness broker | no | no | one configured snapshot/timestamp candidate | no | no |
| environment publisher | no | no | no | exact Worker/archive only | no |
| release verifier/deployer | no | no | no | no | verified plan only |
| independent canary/auditor | no | no | no | no | no |

Repository-root CI runs dependency, unit, attack, schema, reproducibility,
Worker, IaC, and clean-checkout checks without cloud credentials. A build job
creates immutable targets and unsigned metadata input. Protected environment
jobs use GitHub OIDC only to submit exact role-specific requests to the fixed
AWS broker; they never receive `kms:Sign`. Static AWS keys are forbidden.
Cloudflare uses separate least-privilege staging/production publisher tokens,
which are publisher credentials rather than signing keys. A signer cannot
publish, a publisher cannot sign, and the workload deployer cannot do either.

Staging upload, preview verification, full staging deployment, adversarial
checks, migration and recovery evidence precede production promotion. The
production job accepts the exact staging artifact set and collected offline
targets signatures; it cannot rebuild or replace an input. GitHub protected
environment approval does not replace the required signing threshold.

#### Client and deployment admission

The repository-owned noninteractive Go client is built against pinned
`go-tuf/v2` v2.4.2. It has no signer interface. It requires:

- an explicit environment trust configuration and locally supplied trusted
  `root.json` with an out-of-band pinned SHA-256; trust-on-first-use is forbidden;
- an exact HTTPS metadata and targets origin with cross-origin redirects
  rejected;
- a durable, private, environment-specific state directory with a state marker
  binding repository ID, root hash, and environment;
- an exclusive process lock so concurrent refreshes cannot corrupt rollback
  state;
- bounded HTTP timeouts, metadata sizes, target sizes, redirect behavior,
  retries, and structured PHI-free logs;
- exact allowlisted target paths and release/environment/Git/account/region
  inputs;
- temporary downloads, complete TUF verification, safe parsing/extraction, and
  atomic output rename.

The client downloads the explicit release bundle, verifies every referenced
target, recomputes the artifact set, and emits a sealed deployment plan. The
plan maps exactly twelve repository-plus-digest values to the twelve CDK image
parameters and seven verified extracted directories to exact Worker names,
hosts, and API origins. Staging/production operations reject caller-supplied
image overrides and unverified frontend directories.

Frontend archives contain sorted regular files only, use USTAR with normalized
UID/GID/mode/times, and exclude links, devices, sockets, executable bits, PAX,
GNU extensions, xattrs, ACLs, sparse files, and empty-directory entries. Safe
extraction enforces path, case-collision, duplicate, count, per-file, total-size,
manifest, required-file, and target hash/length constraints before atomic
rename. `tar -xf` is never used on an unverified archive.

#### Recovery, rollback, and monitoring

Application rollback is a newly authorized, higher-sequence release whose new
targets/snapshot/timestamp metadata selects retained old OCI digests and
frontend targets. Restoring an old Worker deployment or stale metadata after a
client may have observed a higher version is forbidden.

Repository recovery restores an archived generation into an isolated Worker
preview, then publishes newly signed higher-version metadata. A staging drill
must prove archive checksum verification, pinned-root client refresh, target
download, and forward-version rollback. Production archive copies require an
approved recovery account/region; the source must not invent those identifiers.

An independent durable-state canary refreshes at least every five minutes,
downloads a small target, checks repository/environment/release identity, and
records metadata versions and time-to-expiry without target contents. Alerts
cover timestamp/snapshot/targets/root expiry, refresh or target failure,
unexpected Worker version/deployment, KMS signing anomalies, archive writes or
deletes, CloudTrail loss, and endpoint error rate. Alert delivery itself must be
proven in staging.

### Milestone 3a — pinned client, deterministic frontend format, and contract baseline

The following local implementation is present and verified; it is not a cloud
deployment or a completed end-to-end release pipeline:

- `tools/tuf-release` pins go-tuf v2.4.2 and provides an HID verifier with an
  out-of-band bootstrap-root hash, exact repository/environment/origin marker,
  private durable metadata state, exclusive process lock, bounded invocation,
  redirect rejection, lowercase portable target allowlist, target size bound,
  and no trust-on-first-use or signing interface;
- the client reloads the latest locally trusted root across invocations and
  durably checkpoints its version/hash. A disposable test rotates the
  timestamp key through root version 2 and proves that a replay signed by the
  revoked key is rejected;
- verified downloads are staged inside private client state and committed with
  an exclusive hard link, avoiding the earlier output-directory symlink race;
- security-sensitive Go JSON parsing rejects duplicate object names, unknown
  fields, trailing values, special files, and oversized inputs;
- frontend packaging produces sorted uncompressed USTAR with normalized
  ownership, mode, and epoch time. Packing opens every path beneath an anchored
  no-follow directory descriptor. Extraction rejects non-USTAR headers, links,
  traversal, case collisions, extended metadata, hash/length mismatch, data
  after the two-block end marker, and destination replacement using an atomic
  no-replace rename;
- the frontend content-manifest emitted by Go is the same `1.0.0` contract
  compiled from `release/schemas/frontend-content-manifest.schema.json`;
- all public TUF target references and frontend archives are capped at
  `26214400` bytes to stay inside the selected Cloudflare Static Assets
  publication boundary;
- strict Draft 2020-12 release-bundle, channel, frontend-manifest, and
  promotion-evidence schemas plus machine configuration compile under AJV
  strict mode. The configuration checks all 28 migration names and SHA-256
  values against disk.

The permanent supply-chain evidence manifest is
`tools/tuf-release/toolchain/verified-upstream-build.json`. The supplied source
evidence was corrected back to the authoritative v2.4.2 tag commit
`f5edbde31e5507f46db2069402dc38903fe6d9d4` and source-tree SHA-256
`6ceb2d9979e910310c37243d27040c310c279748c57142301f980b29c2b25ebd`.
The installed Go binary was byte-compared with the official distribution
archive before its pin was recorded.

At this milestone, adversarial review recorded four unresolved gates:
Cloudflare preview/exact-version promotion, AWS OIDC identity separation,
immutable release-archive enforcement, and downloaded production-evidence
binding. Milestones 3b through 3d close the first, second, and fourth local
source gaps; live archive and deployment proof remains external work. None is
treated as an exception.

### Milestone 3b — context-bound release and promotion admission

The local release contract now implements the admission boundary described in
ADR-035. `release/scripts/verify-release-contract.mjs` requires a bundle caller
to supply all six expected values—environment, AWS account, AWS region, release
ID, forty-character Git SHA, and whole-second admission time—and rejects a
partial or unbound bundle command. Bundle content is bound to the configured
repository, exact twelve ordered OCI records, exact seven ordered frontend
records, migration ledger, public evidence hashes, and an independently
recomputed artifact-set hash. The derived deployment plan contains only
digest-qualified ECS image values and verified frontend target references.

Production admission now requires all five staging gates plus production
approval. Each evidence object is bound to the expected evidence type,
environment, staging or production subject release, and the exact promoted
artifact-set hash. Required checks are explicit per gate; future evidence,
expired approval, approval before the last staging gate, missing checks, and
wrong subjects fail closed. This is executable evidence validation, not proof
that a live gate has run.

Local JSON inputs are bounded regular files opened without following symbolic
links and parsed with duplicate-key rejection. The adversarial Node suite
covers caller/bundle identity confusion, artifact mutation, order/path/media
and 25 MiB violations, duplicate target-path conflicts, unsafe/colliding
frontend paths, promotion evidence substitution/omission/expiry/order,
duplicate JSON, symlinked JSON, and the unbound CLI path.

`release/scripts/admit-release.mjs` now executes that contract across the
repository-owned client boundary. It verifies the exact executable SHA-256,
performs a durable TUF refresh, requests the explicit immutable bundle path,
resolves the complete post-bundle target set before writing through one strict
bounded `get-batch` request, and independently rechecks each regular file's
length and SHA-256. It validates each frontend content manifest, invokes the
hardened extractor into a new directory, validates downloaded production
evidence when applicable, and writes a new `0600`, fsynced admission record
containing the TUF role state and deterministic plan hashes. The command accepts
no raw image URI or unverified frontend override. Partial batch failure stays
inside a disposable workspace and cannot seal an admission record.

Verified commands on 2026-08-31:

```text
npm --prefix release test
# 9 tests, 9 passed, 0 failed (including end-to-end admission orchestration)
npm --prefix release run verify
# strict schemas, machine configuration, and semantic contracts verified
```

### Milestone 3c — release-trust IaC and EHR cache-generation safety

The source-only AWS release-trust stack now rejects ambiguous account, region,
repository, audience, protected-environment subject, retention, and Object Lock
inputs. Eight distinct GitHub OIDC subjects separate build, publication,
evidence, audit, two snapshot signers, and two timestamp signers. Staging and
production repository, evidence, and audit buckets are private, versioned,
retained, KMS-encrypted, and Object-Locked with respective minimum default
retention of 90 and 180 days. Bucket upload policies require each exact KMS key;
KMS use is constrained by caller account, regional S3 service, and exact bucket
encryption context. CloudTrail delivery is source-bound to the named trail.
Four non-exportable P-256 KMS signer candidates and four isolated
signing-request identities are defined. A later adversarial review found that
the original direct `kms:Sign` grants made the GitHub workflow identity a
role-shaped signing oracle: modified workflow code could bypass the local plan
checks and ask KMS to sign bytes relative to caller-selected trust state. On
2026-09-01 those grants were removed. Each GitHub identity can now inspect only
its one assigned public key, and the synthesized template contains no
GitHub-assumable `kms:Sign` permission. It deliberately fails closed until a
fixed AWS-side signing broker independently pins environment, root history,
candidate ARN/SPKI, wall clock, and the last accepted generation. The stack
enables termination protection but is deliberately not instantiated by the CDK
application: account/region, OIDC provider, Object Lock mode, retention,
monitoring destination, and irreversible creation approval remain external
gates. No AWS API was called and no KMS key or bucket exists as a result of this
source implementation.

The EHR service worker is now generated for an exact `HID_RELEASE_SHA`. It
preloads the complete sorted release shell before activation, deletes only
prior EHR generations, uses network-first behavior for navigation and the
stable canonical runtime URL, keeps immutable hashed assets cache-first, and
does not cache API/query traffic. Registration validates the SHA-qualified
worker URL, forces an update check, and performs one controlled reload on
controller change. The checked-in public worker is an intentionally
non-deployable template; only the postprocessed `dist/service-worker.js` may be
packaged. This closes the previously recorded stable-URL cache risk without
claiming a browser deployment.

Verified locally:

```text
npm --prefix infra/aws run typecheck
npm --prefix infra/aws test
# 49 tests passed, 0 failed
npm --prefix apps/ehr test
# 5 tests passed, 0 failed
npx tsc --noEmit (apps/ehr)
HID_PUBLIC_BASE=/ HID_RELEASE_SHA=abc77af52f1c09831e1fcdb9c3ba1aaafd0f60b0 npm run build (apps/ehr)
node scripts/verify-frontend-platform.mjs
# generated worker contained the exact SHA and all six emitted assets; no template tokens
```

### Milestone 3d — cryptographic Worker publication and credential-free CI source

The two TUF Worker configurations are now isolated by name, hostname,
environment variables, asset directory, preview identity, and route. Their
read-only Worker admits only `GET`/`HEAD`, the exact canonical hostname or the
exact version-prefixed preview hostname, versioned root/targets/snapshot,
unversioned `timestamp.json`, and hash-prefixed targets in the selected
environment. It rejects cross-environment paths, queries, ranges, redirects,
directory fallback, arbitrary preview hosts, and asset-binding failures before
content can be cached. Timestamp is `no-store`; versioned metadata and hashed
targets are immutable.

Before Wrangler sees a directory, the repository validator performs bounded
no-follow duplicate-free parsing, enforces the exact 2-of-3 root/targets and
1-of-2 snapshot/timestamp P-256 policy across ten distinct cryptographic keys,
verifies OLPC canonical JSON signatures and go-tuf-compatible key IDs, validates
sequential root rotation, complete SHA-256/length metadata references, expiry
windows, retained-metadata closure, immutable release target identity, physical
target hashes, file count, and the 25 MiB per-file limit. A golden P-256 key-ID
vector generated independently by pinned go-tuf v2.4.2 catches canonicalization
drift; this corrected an earlier PEM-newline escaping incompatibility.

The publication wrapper creates an inaccessible parent Worker without
overwrite, uploads one validated whole generation as a new version, seals the
exact version/preview/repository receipt, admits that versioned preview through
the pinned HID client with a fresh disposable state directory, and deploys only
that version at 100 percent after an exact confirmation. Route activation is a
separate exact-host confirmation against a strict deployment receipt. The
wrapper uses only the locally installed Wrangler 4.127.1 and verifies its
audited executable bytes before a real invocation. No upload, deployment,
route, DNS, account, or credential operation was performed locally.

Credential-free repository CI source is present in
`.github/workflows/tuf-local-gates.yml`. It has read-only permissions, disables
persisted checkout credentials, pins official actions by commit, and separates
release contracts, Go race/vet/reproducibility, AWS source policy, Cloudflare
Worker compilation, and EHR exact-SHA cache gates. It contains no OIDC, secret,
artifact publication, cloud upload, or deploy job. The workflow was linted and
its component commands were run locally; a real clean GitHub checkout run is
still required before this gate can pass.

Verified locally on 2026-09-01:

```text
npm --prefix infra/cloudflare test
# 43 tests passed, 0 failed
npm --prefix infra/cloudflare run verify
# TUF/frontend configurations and audited local Wrangler toolchain verified
npm --prefix release test && npm --prefix release run verify
# 9 tests passed; strict schemas and semantic contracts verified
go test -race -count=1 ./... && go vet ./...  # tools/tuf-release
# every package passed; deterministic/toolchain checks also passed
```

### Milestone 3e — pinned KMS signer boundary and dependency remediation

`tools/tuf-release/internal/kmssigner` now adapts one immutable AWS KMS key ARN
to the exact signer interface used by pinned go-tuf v2.4.2. Construction pins
the SHA-256 of the returned canonical SubjectPublicKeyInfo and rejects aliases,
bare IDs, the wrong ARN, non-P-256 keys, non-`SIGN_VERIFY` use, algorithm
ambiguity, and noncanonical key bytes. Signing hashes the canonical metadata
payload exactly once, requests only `MessageType=DIGEST` with
`ECDSA_SHA_256`, validates the returned ARN/algorithm/DER scalars, and verifies
every signature locally before returning it. The signer exports no private key,
key creation, key import, or standalone arbitrary-signing command. Fake-client
tests prove go-tuf sign/verify interoperability, context cancellation,
configuration/RPC ambiguity rejection, malformed or wrong-key signatures,
defensive public-key copies, and concurrent use without contacting AWS.

The AWS CDK library was updated from 2.264.0 to 2.267.0, clearing its reported
high advisory while retaining all 49 infrastructure tests. EHR's build-only
Vite/plugin toolchain was updated to 8.2.2/6.1.1, the config was moved from
legacy `__dirname` to `import.meta.dirname`, and its audit is now clean. The EHR
5-test cache gate and exact-SHA production build still pass. These are local
dependency and source verifications, not deployed runtime changes.

Verified locally on 2026-09-01:

```text
go test -race -count=1 ./... && go vet ./...  # tools/tuf-release
# KMS signer and every existing package passed
node tools/tuf-release/scripts/verify-toolchain.mjs --require-installed
# pinned source, module, Go, and reference-client evidence passed
# two deterministic hid-tuf builds were byte-identical:
# ec7409fa9d89964b6ac73e770f21792c376ba3edf38ac92470ff883475cf86c7
npm --prefix infra/aws audit --audit-level=moderate
# 0 vulnerabilities; typecheck and 49/49 tests passed
npm --prefix apps/ehr audit --audit-level=moderate
# 0 vulnerabilities; 5/5 tests and the exact-SHA Vite 8.2.2 build passed
```

### Milestone 3f — provider-neutral threshold metadata construction

`tools/tuf-release/internal/repository` now enforces the repository-generation
trust boundary before publication. It accepts only bounded no-follow inputs,
exact member names, duplicate-free JSON, canonical whole-second UTC times, the
exact four top-level roles, ten distinct canonical P-256 public keys, 2-of-3
root/targets and 1-of-2 snapshot/timestamp policy, consistent snapshots, and a
valid current self-signed root. Sequential root validation requires exactly the
next version and authenticates it under both old and new root authorities.

Targets preparation rechecks every source target's declared length and SHA-256
and produces one deterministic OLPC-canonical signed payload. Assembly imports
exactly two distinct detached signatures whose environment, repository,
release, root version, targets version, payload hash, signer key ID, and signing
time all match that payload. It rejects unauthorized, repeated, malformed,
wrong-key, or context-substituted evidence before verifying the complete
targets threshold. No offline provider, hardware token, private-key encoding,
or generic arbitrary-signing command is embedded in this boundary.

Snapshot and timestamp constructors bind exact input metadata bytes by version,
length, and SHA-256. Each checks the proposed public key against its separate
root role before invoking the signer, then validates the returned canonical DER
signature locally through go-tuf. Their 72-hour-through-7-day and
6-hour-through-24-hour lifetimes, respectively, are fail-closed. Test-only
ephemeral keys exercise the full chain and attacks; they are not staging or
production keys and never leave test process memory.

Verified locally on 2026-09-01:

```text
go mod tidy && go mod verify  # tools/tuf-release
# all modules verified; go-securesystemslib is now a direct dependency
go test -race -count=1 ./... && go vet ./...  # tools/tuf-release
# all packages passed, including repository threshold/context/root-chain attacks
npm --prefix release audit --audit-level=moderate
npm --prefix infra/aws audit --audit-level=moderate
npm --prefix infra/cloudflare audit --audit-level=moderate
npm --prefix apps/ehr audit --audit-level=moderate
# all four current lockfiles reported 0 vulnerabilities
```

At this point the create-only whole-generation materializer and role-specific
operator command were implemented, but their later adversarial review findings
and corrections are recorded in Milestone 3g. The private archive journal and
monitoring controls remained open; this milestone did not claim a cloud
deployment.

### Milestone 3g — authenticated generation continuity and signing-oracle correction

The role-specific `hid-tuf-repo` operator now covers targets preparation,
2-of-3 targets assembly, snapshot/timestamp construction, and create-only whole
generation materialization without adding a key-generation, key-import, or raw
generic signing command. The generation plan binds all four expected versions
and all metadata hashes. Genesis is permitted only when every role is version
1; every successor requires the exact prior repository path and repository
SHA-256. The materializer copies and hashes those exact bytes before using any
predecessor state, validates the complete retained root chain, exact role
signatures, metadata references, sequential root/targets continuity, strict
ordinary snapshot/timestamp successor transitions, immutable release targets,
physical target closure, and current authority/freshness, then commits one
private directory without replacement. TUF permits missing unpublished online
role versions, so retained-directory validators enforce non-rollback snapshot
continuity and strictly advancing timestamp continuity rather than inventing
the missing bytes; a state-authenticated broker publication boundary is still
required before any such recovered gap can be uploaded.
The independent Node validator accepts the resulting byte tree and computes
the same repository hash and role versions.

Online plans now require a fresh whole-second `created_at` no more than five
minutes old or one minute in the future before AWS configuration is loaded.
Metadata versions are bounded to JavaScript's exact integer range. Genesis
selects input version 1; successors authenticate the exact previous same-role
metadata and previous root, permit only an unchanged or sequentially rotated
root, advance the output exactly one version, and allow selected input metadata
to stay byte-identical or advance exactly one version. This supports a real
online-key root rotation while rejecting rollback, skipped versions,
same-version substitution, and version poisoning before a remote signer call.

Detached offline targets evidence now contains two same-custodian signatures:
the normal TUF signature over the canonical targets payload and a required
domain-separated attestation over the full canonical signing request, key ID,
TUF signature, and signing time. Assembly verifies both under the same
authorized targets key, so the audit context and `signed_at` can no longer be
rewritten around an otherwise valid TUF signature. All repository reads now
resolve every pathname component through held no-follow directory descriptors;
an ancestor symlink cannot redirect a target, plan, evidence, or metadata read.

Adversarial review also found that the original GitHub OIDC signer-role grants
could bypass every local check by calling KMS directly. The source IaC now
contains no GitHub-assumable `kms:Sign` permission; each of the four protected
request identities may inspect only its assigned public key. This closes the
deployed signing-oracle path fail-closed. The fixed, independently stateful AWS
broker subsequently implemented in Milestones 3h and 3i is the only production
freshness-signing path. Caller-pinned predecessor hashes in a local plan remain
defense in depth and are not a substitute for that broker's independently held
live checkpoint and online-role high-water marks.

Verified locally on 2026-09-01:

```text
HID_REQUIRE_CLOUDFLARE_VALIDATOR=1 go test -race -count=1 ./...  # tools/tuf-release
# every package passed; the Go generation passed the Node repository validator
go vet ./... && go mod verify  # tools/tuf-release
# vet passed; all modules verified
npm --prefix infra/aws run typecheck && npm --prefix infra/aws test
# typecheck passed; 49 tests passed, including absence of GitHub KMS Sign grants
npm --prefix infra/cloudflare test && npm --prefix infra/cloudflare run verify
# 45 tests passed; exact read-only validator CLI and configuration passed
npm --prefix release test && npm --prefix release run verify
# 9 tests passed; strict release schemas/contracts passed
npm --prefix release audit --audit-level=moderate
npm --prefix infra/cloudflare audit --audit-level=moderate
npm --prefix apps/ehr audit --audit-level=moderate
# each reported 0 vulnerabilities
```

### Milestone 3h — fixed signing runtime and committed-decision journal

The provider-neutral broker now has a production-shaped AWS runtime instead of
leaving freshness signing fail-closed at the adapter boundary. Four isolated
candidate functions and one non-signing checkpoint function use one immutable
image digest and exact published Lambda versions. Signing functions accept only
canonical bytes loaded from one exact versioned, retained request object in
their candidate namespace. They independently authenticate the durable
checkpoint, root history, request creation time, release context, predecessor
metadata, output increment, KMS ARN, P-256 SPKI pin, message type, and signing
algorithm before exposing output.

The state store uses a conditionally advanced DynamoDB head whose exact
manifest bytes and predecessor reference are chained through 730-day
Object-Locked, checksum-verified, KMS-encrypted S3 journal versions. A completed
decision record is only an index: replay walks the exact journal-version chain
from the authenticated head and requires the original manifest to contain the
same role, candidate, request hash and S3 provenance, release/time context, and
root/input/output blob references. This permits byte-identical replay after
publication without another KMS call while rejecting a forged index, a valid
but unreachable S3 version, altered output, expired historical retention, or a
decision load without an authenticated state head. A missing post-commit index
is reconstructed from the predecessor journal before pending state can be
cleared. The journal proves membership in the chain selected by the protected
DynamoDB head; an external append-only witness would still be required if
privileged replacement of that head is included in the threat model.

The synthesized trust boundary gives no GitHub role `kms:Sign`. Candidate KMS
use is identity-allowed only from its exact Lambda function with
`MessageType=DIGEST` and `ECDSA_SHA_256`; the key policies deny every other
principal, algorithm, and message type. State, request, bootstrap, and storage
KMS grants carry exact `lambda:SourceFunctionArn` conditions. ECR image
retrieval has an exact-account/exact-five-function allow plus explicit denies
that constrain CDK's broader Lambda service allow. CloudTrail selects exactly
those five functions and the state table, and all eighteen broker alarms send
to the exact pre-existing environment alert topic. Production additionally
requires COMPLIANCE Object Lock and an explicit key-custody acknowledgment
before the stack can synthesize signing keys.

Verified locally on 2026-09-03 without AWS credentials, API calls, key
creation, image push, or deployment:

```text
go test -count=1 ./internal/awsbroker ./internal/signingbroker
# both focused packages passed, including snapshot/timestamp journal replay and tamper cases
npm --prefix infra/aws run typecheck
# passed
npm --prefix infra/aws test
# 53/53 passed, including exact ECR, Lambda, KMS, journal-storage, CloudTrail, and alarm boundaries
```

### Milestone 3i — fail-closed pending recovery and online-version high-water

The provider-neutral checkpoint schema is now `2.0.0`, and the AWS immutable
state-manifest schema is `v3`. Both persist separate snapshot and timestamp
version high-water marks in addition to the current published versions. One
signing CAS may advance exactly one high-water by exactly one and must create
the matching pending role output; it cannot change published state. A
publication CAS must consume the exact pending timestamp and any exact pending
snapshot/root/targets, clear both pending records, and bring both published
online versions up to their high-water marks. Rollback, a jump, simultaneous
role advances, same-version substitution, or an orphaned high-water is rejected
before any new S3 state object is written.

Exact pending and completed-decision retries still return the original bytes
without KMS, including after a later recovery decision supersedes them. A
different request remains blocked while its role's pending generation meets
the hard publication floor. Only when authenticated metadata has less than 72
hours of snapshot freshness or six hours of timestamp freshness may a
different request supersede it. Snapshot recovery clears any dependent stale
timestamp but preserves its consumed timestamp high-water; the next timestamp
therefore also advances past the burned version. Excessive metadata lifetime,
clock rollback, malformed state, or a signature/reference failure is not
classified as recoverable expiry.

New requests reserve a further 30-minute operational margin above every hard
publication floor. The broker validates candidate root/targets or the complete
authorized snapshot context at that future reference before KMS. After signing,
it rechecks the request age and the complete output at the same margin
immediately before CAS. This prevents minimum-lifetime requests, signing delay,
or near-floor offline inputs from committing an immediately unusable pending
generation.

Root and targets remain sequential offline roles. Recovery may keep an
unpublished next root/targets byte-identical, or move from the currently
published value to one authenticated direct successor; it never skips an
unpublished offline version. Consequently this is not universal offline
metadata recovery: if an already-unpublished next root or targets itself falls
below its publication floor, the broker intentionally fails closed. Retained
intermediate offline lineage and a separately approved manual transition are
not yet implemented.

The ordinary `GenerationPlan`, `ValidateOnlineSigningInputs`, and
`materialize-generation` paths remain strict predecessor/`+1` interfaces.
Repository layout validators permit TUF-valid gaps in snapshot version numbers,
but caller-supplied high-water flags are not accepted. A recovered gapped
generation must remain private until the publisher can reload and exact-match
the durable current and pending checkpoint immediately before Worker upload,
bind that authorization to the upload/preview evidence, and reauthorize before
deploy. That hook is still open, so gapped recovery publication is not yet an
end-to-end accepted gate and staging remains blocked.

The `v3` state reader deliberately does not reinterpret a `v2` manifest. This
is safe only because the broker stack has never been instantiated. Initial
staging must assert empty state and bootstrap directly at `v3`; any future
populated-state upgrade must use a journal-authenticated migration preserving
ancestry and both high-water marks, never reset or overwrite state.

Verified locally on 2026-09-04 without AWS credentials, API calls, key
creation, image push, upload, or deployment:

```text
HID_REQUIRE_CLOUDFLARE_VALIDATOR=1 go test -count=1 ./...  # tools/tuf-release
# all 11 packages passed (9 tested; 2 had no tests)
go test -race -count=1 ./... && go vet ./... && go mod verify
# all packages passed; vet was clean; all modules verified
```

## COMPLETED CONTINUATION HISTORY

### Durable journal and protected workflow continuation

Continuation verification on 2026-09-06 now covers the actual Phase A/B
boundaries. The Object-Locked S3/DynamoDB adapter, strict operator CLI,
whole-generation archive, structured evidence archive, storage IAM, reusable
protected workflow, live pipeline adapter, and wrapper-boundary integration are
implemented in source. Evidence writes now re-read both exact bytes and the
original 730-day retention deadline rather than relying only on the
requested Object Lock headers. No cloud API, secret value, key, protected
environment, staging system, or production system was used.

Focused results after integration are: 52/52 Cloudflare tests, 18/18 release
tests plus contract verification, 57/57 AWS infrastructure tests plus
typechecking, all 13 Go packages under the race detector plus vet and module
verification, and actionlint 1.7.7 acceptance of both repository-root
workflows. The real wrapper regression executes the bootstrap parent, upload,
preview, deploy, initial route, and confirmation adapters with fake process
and storage boundaries; lost responses at every recorded intent/result remain
unpromoted. This is local evidence only. Final whole-workspace, deterministic
five-command rebuild, and pristine GitHub-run evidence remain current work.

The implemented Go durable adapter reuses the existing Object-Locked evidence bucket and
DynamoDB table under a separate publication partition/prefix. Each revision
occupies a fixed create-only S3 slot and links the exact predecessor object
version/hash. Readback validates every transition from genesis, compares the
strongly consistent head, and checks the next immutable slot. A missing head
with an occupied first slot, an old head with an occupied successor, or an
orphan slot from interrupted commit fails closed for reconciliation; none is
treated as permission to repeat an external action. Retention follows the
existing 730-day signing-state journal policy. No signing checkpoint write is
granted to the publisher.

The policy explicitly binds release Git SHA, artifact target/digest and
artifact-set digest, workflow/repository/actor identity, bounded status/failure
codes and resume disposition. Intent transitions require fresh matching
publication authorization, and attempts have a bounded active lifetime without
automatic expiry/removal or claim takeover. Exact active and approved historical
workflow pins are separate: historical pins preserve audit readback without
authorizing new claims or continued effects after a workflow upgrade.

The targeted race-enabled AWS adapter tests passed on 2026-09-06:
`go test -race -count=1 ./internal/awsbroker -run 'PublicationJournal|ImmutableSlot'`.
They verify full-chain readback, account/KMS/checksum/retention checks, one winner
among 16 competing writers, missing/tampered middle entries, duplicate versions,
delete markers, old/deleted heads, cross-environment state, and both S3 and
DynamoDB lost-response outcomes. An occupied orphan slot remains frozen; a lost
response never returns permission for an external action. Expanded policy
regressions and the combined race/vet gates now pass.

Workflow trust source now requires immutable workflow refs plus exact repository
IDs, ref, environment, audience and subject for every capability. The publisher
has a distinct DynamoDB publication partition grant, no broker checkpoint write,
conditional S3 journal/evidence/archive grants, deletion/bypass denies and an
optional exact-version existing Secrets Manager credential reference. A new
resource-policy self-reference initially caused a CloudFormation dependency
cycle; this was corrected using the fixed table ARN. Fourteen focused
release-trust groups now pass, including negative identity, storage, journal,
secret-version and signing-authority cases.
AWS's current [OIDC condition-key documentation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html)
supports these GitHub trust-time claims. The Cloudflare publishing credential
must be available only to that protected publisher, not ordinary build jobs.
The new `hid-tuf-journal` command supports bounded claims, transitions, evidence
archival, full readback and failure records; no reset/steal/resume action exists.
The expanded journal policy and AWS packages pass targeted race tests. Five Node
pipeline test groups pass, including ambiguous intent/result commits, per-effect
fresh authorization, changed evidence/identity, cancellation and confirmation
timeout. `tuf-publish.yml` and its live runner adapter are now in source, with a
credential-free reproducible tooling job, protected publisher identity checks,
independently approved tooling/config hashes, candidate-as-data downloads,
immutable archive readback, per-effect intent callbacks and retained references.
Their static, adapter and real-wrapper integration checks pass locally. A
pristine reusable-workflow run and every staging gate remain external. No cloud
resource, protected environment or credential has been accessed.

### 2026-09-05 continuation — publication authorization

The read-only `PublicationController.AuthorizePendingPublication` policy
primitive is implemented and its focused signing-broker tests pass. It loads
and authenticates current state, compares exact predecessor/pending candidate
bytes, enforces freshness at a 30-minute future reference, and reloads state
before issuing five-minute revision/hash-bound evidence. It rejects concurrent
state changes, same-revision substitution, missing state, canceled requests,
slow validation and clock rollback. The recovery test proves version 3 can be
authorized over the expired published version 1 while superseded version 2
remains rejected. No signer or state write is used for authorization.

The evidence is not a bearer token or a cross-cloud transaction lock. The
operator must perform a fresh read before each external boundary, preserve
the predecessor's full immutable file closure, isolate the candidate files
from edits during Wrangler execution, and serialize per-environment
publication. The protected `hid-tuf-publication` command and wrapper integration
now pass focused tests. The operator validates complete predecessor/candidate
repositories before AWS initialization, and preserves the predecessor's
immutable file closure. A separately protected predecessor SHA-256 must come
from retained previous publication evidence, not the candidate's inputs or a
new hash of an untrusted local copy. The regression proves that removing an old
snapshot from both predecessor and candidate remains locally TUF-valid but
fails this protected pin before AWS initialization. Its AWS adapter exposes
only read methods; attempted
bootstrap/CAS/S3 writes fail locally. All-version-one bootstrap requires the
configured root pin and absent state on both reads.

The wrapper requires separately pinned executable/configuration files and the
previously published whole-repository hash, uses
fresh process output for authorization, and copies the candidate into a
private validated directory for upload. Upload and deployment receipts are now
schema `2.0.0`, binding the decision, revision, predecessor/candidate hashes,
and operator pins. Preview admission binds the exact bootstrap root, release
and role versions. Deploy and initial-route activation reauthorize and require
the same decision binding as upload. Commands are time-bounded; failed,
malformed or overlong responses cannot seal success receipts and require
external-outcome reconciliation before retry.
All mutation commands preflight absent canonical receipt destinations outside
the repository and reject symlinked ancestors before authorization or Wrangler.
Preview artifact-set hashes are validated before deployment; deployment receipt
release IDs must equal the broker authorization. Input opens are nonblocking
and reject non-regular files, avoiding a FIFO stall before type inspection.

Verification on 2026-09-05: root `npm test` and `npm run verify` passed before
the latest wrapper/IaC edits; release tests passed 9/9 plus contract verification,
and EHR tests passed 5/5. The updated wrapper passed all 12 focused
publication/config/preview tests. AWS typechecking and all 54 infrastructure
tests passed after adding exact publisher state reads and S3-context-bound
decryption. No publisher state-write or signing grant was added. This uses
AWS's documented [DynamoDB partition conditions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html)
and [S3 KMS encryption-context boundary](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html).

The specialized materializer now passes the actual expired-pending recovery
path: strict ordinary materialization rejects version 1 to 3, while live-state
authorization permits exact pending version 3, preserves published version 1,
and excludes superseded private version 2. It reauthorizes before the atomic
directory commit; failure leaves neither destination nor temporary generation.
The independent Node validator agrees on the complete repository SHA-256.

Further verification on 2026-09-05:

- validator-backed `go test -race -count=1 ./...`, `go vet ./...`, and
  `go mod verify` passed across all 12 Go packages (10 tested, 2 without tests);
  the subsequent predecessor-pin CLI change also passed focused normal/race
  tests and vet;
- root `npm run build` passed for shared packages, all seven applications, ten
  backend runtimes and AWS infrastructure; existing bundle-size/Browserslist
  warnings are not production performance evidence;
- Cloudflare tests passed 51/51, including receipt preflight, pinned live-process
  invocation, preview rejection, and authorization/deployment binding;
- the direct Cloudflare config check after a normal subpath frontend build
  rejected non-root artifact paths as intended; the complete root verify run
  with its declared root-host build prerequisites subsequently passed;
- actionlint v1.7.7 accepted the updated five-job credential-free workflow;
- all four TUF commands produced identical paired Linux/amd64 static binaries
  using Go 1.25.0, `GOENV=off`, `GOTOOLCHAIN=local`, `-mod=readonly`, `-trimpath`,
  `-buildvcs=false`, and an empty build ID. The final paired builds after
  predecessor pinning and confirmation produced these hashes (`cmp` exit 0
  for every pair):

| Command | SHA-256 (both builds) |
| --- | --- |
| `hid-tuf` | `7978eacbec01af07a7d01c665c58f8cf211804f840f309d860f6dd3eadb99419` |
| `hid-tuf-repo` | `48f28f7a7566a177380e7700db35174291f55af219e8a1ac0691c5c620f74bc0` |
| `hid-tuf-publication` | `614e14e394aff1a0d0c570911bde7b795cd3b1b7eebfb4474f7ecbe3d946d2bd` |
| `hid-tuf-signing-broker` | `d5e146e1f919a5fdc02f086ac19444f1be9506f2e25c43dbf375e139a3c3f4ea` |

These are local working-tree binaries, not installed/deployed release artifacts.
The unrelated supplied upstream reference binary remains unchanged at its
previously recorded hash. `--require-installed` toolchain verification passes.

The next full root test run exposed a preexisting Admin test isolation defect:
Vitest globals are disabled, so Testing Library had not registered cleanup.
All 19 assertions passed, but a queued React commit outlived jsdom and raised
`window is not defined`; that run failed. Explicit `afterEach(cleanup)` in
`apps/admin/src/test-setup.ts` and an empty-DOM regression assertion in
`App.spec.tsx` now pass typechecking and five consecutive full 19/19 Admin runs.
No Admin production component or domain API was changed. The full root
`npm test` subsequently passed, including all 54 AWS infrastructure tests.

The read-only `hid-tuf-publication confirm` operation now observes the public
canary's durable result without invoking the canary or writing state. It binds
the exact candidate repository/role hashes and a newer published checkpoint
revision; pending-only metadata cannot satisfy it. Double reads and final-time
freshness checks reject concurrent mutation, cancellation, clock rollback and
crossing the publication floors. Focused command/broker tests pass, including
all-version-one bootstrap, substituted bytes, invalid prior revisions and
local hash rejection before AWS initialization. Confirmation is evidence, not
permission to publish or a claim of cross-cloud atomicity.

The storage-independent `internal/publicationjournal` policy is now implemented
and passes seven race-enabled test groups. It remains separate from broker
trust state. One conditional claim per environment must
precede mutation; intent records precede upload/deploy/route effects and receipt
records follow validated results. Owner/revision checks prevent concurrent
transitions. The completed record retains the whole generation hash as the next
attempt's predecessor authority. Only exact fresh post-canary confirmation may
close the normal path. There is no automatic expiration, claim stealing,
checkpoint write, or crash-resume path: ambiguous attempts remain blocked for
independently governed reconciliation. This policy alone does not implement
durable storage or a protected live workflow; their integration and failure
tests remain gates.

Its tested sequence is:

```text
claimed -> archive-verified -> [parent-started -> parent-created]
        -> upload-started -> uploaded -> preview-verified
        -> deploy-started -> deployed -> [route-started -> route-activated]
        -> confirmed
```

Parent creation is permitted only for bootstrap. Tests prove one winner among
32 competing claims or intent writes, unresolved blocking after interruption
at each of the 11 pre-completion phases, no replay of an existing intent, and
fail-closed behavior when a storage write fails or its successful response is
lost. Cancellation after commit leaves the durable claim unresolved. The
normal completion path rejects mismatched role/release/prior-state evidence,
stale/future confirmation and wrong owners/revisions. A later attempt must
select the exact confirmed predecessor hash and metadata. Store revisions are
required to remain in audit history; the test adapter records them, but it is
memory-only and is not a live durability implementation.

The validator-backed full Go race run now passes all 13 packages (11 tested,
2 without tests), together with vet and module verification. Parent-stage
refinements also pass focused race tests. Release tests remain 9/9 plus contract
verification; EHR tests remain 5/5. No additional cloud grant, resource, key,
signing operation, deployment, service API, clinical schema or migration was
introduced by the confirmation/journal policy work.

Per-environment publication serialization, final combined gates, and
pristine-checkout evidence remain open. No upload or deployment has occurred.

### Milestone 3 — local implementation

Context-bound release admission, deterministic deployment-plan derivation,
the fixed freshness-signing/checkpoint broker, immutable state and decision
journals, fail-closed expired-online pending recovery, durable version
high-water marks, AWS identity/archive/monitoring policy, EHR cache-generation
safety, Cloudflare cryptographic publication gates, and credential-free CI
source are implemented locally, including state-authenticated recovery
materialization and fresh pre-upload/re-deploy authorization. Remaining local
work is the durable publication-journal adapter and protected serialized
orchestrator, their failure-injection coverage, and
pristine-checkout CI evidence. All live staging and later gates remain external
and unperformed.

No architecture choice in this document authorizes production key creation or
cloud deployment.

## CURRENT

**PHASE C LOCALLY VERIFIED AND COMMITTED — STAGING NOT ACCEPTED.**
HEAD is `46e76cecf9e846061203c8fd68a0fcfd0c2825a5`. The 193-file reviewed scope was committed
once under explicit local-only authorization; no remote publication, protected
workflow run, signed candidate or deployment exists. The current retention
correction and post-commit records remain unstaged/uncommitted; the unrelated
SECURITY edit remains untouched. Local validation of the correction passed; no further commit is authorized.

The Phase C changes strengthen protected source/OIDC/candidate-run SHA binding
before credentials, collect auditable CI evidence, separate the patched Go
release toolchain from the historical reference, define non-secret staging
identifiers and offline plans, and implement a real synthetic PostgreSQL
migration/restore rehearsal. Import fixes preserve the immutable 0027 rules for
facility lifecycle and grant/revocation provenance, normalize typed retry
comparison and preserve calendar DOB in reconciliation. Exact retries pass;
changed target content, orphan associations and blocked partial retries fail.

Fresh GitHub metadata at 21:45 UTC reports **public** visibility, unchanged
repository/owner IDs, no environments/workflows/rulesets, unprotected `main`,
and no remote release branch. This supersedes the earlier private/plan-blocked
observation; no visibility change was made by this agent. All six full action
commit pins resolve upstream. See [actual protection checklist](TUF-CI-PROTECTION.md).

The committed pre-correction root build/test/verify suite passed. Its focused
release tests passed 24/24;
Go 1.26.8 normal/race tests cover all 13 packages with the Cloudflare validator
required, and vet/module verification pass. Four scoped npm audits report zero
vulnerabilities; Go's symbol scan reports zero reachable findings on 1.26.8.
The old 1.25.0 profile reproducibly fails with 73 symbol findings across 30
advisories and is excluded from release builds. Both workflows pass actionlint
1.7.7; Dockerfile checks pass with the required immutable image arguments.

The final PostgreSQL 16.15 rehearsal passed 28 migration hashes, dry-run rollback,
zero-pending retry, promotion/reconciliation, per-table/sequence restore equality,
328 foreign keys, runtime grants/RLS, unique/null/FK/check denials, active and
inactive lifecycle/role cases, changed-target refusal and orphan/partial-failure
rejection. Final migration evidence SHA-256:
`22b18bca65aabb216783df65572467064cae46696b635ba542ae3e034b9ec984`.
Root checks preceded the last inactive-membership script fix; the final real
PostgreSQL rehearsal and migration static verifier cover that change. No HTTP
application, live backup, TUF operational rollback or staging acceptance is inferred.

The offline planner synthesized the foundation and broker with clearly
synthetic identifiers (32 and 86 logical resources respectively), and rejects
unfilled identifiers before producing an assembly. These are source-model tests,
not the unavailable account-specific plan or irreversible-action approval.

Exact commands, timestamps, log hashes, public GitHub reads, migration summary
and paired builds are retained in [Phase C evidence](evidence/tuf-phase-c/README.md).
The public summaries contain no operational backups, raw SQL logs, tokens,
private journal requests or key material. Earlier temporary logs/starting
archive disappeared across the resumed environment; their historical hashes
remain recorded, but those original artifacts cannot presently be audited.
Fresh raw logs and synthetic backups are retained privately outside the repository.

The corrected Go 1.26.8 Linux/amd64 builds below use 730-day retention and
independent A/B caches. Each pair is byte-identical:

| Command | Bytes | SHA-256 (both builds) |
| --- | --- | --- |
| `hid-tuf` | 15050352 | `7b4424f4d86201977fb537059ce8b16ec128f5c405defef438d499d9df167165` |
| `hid-tuf-repo` | 22352759 | `45f775be8eca9200c660616f8b446fc4afdc332fa1af29b34bb3c56e1568e527` |
| `hid-tuf-publication` | 30827305 | `4a3538b7feda8b37f09e7e089c0a43c1e7c13ebd1a3549d2d22b1b014031d881` |
| `hid-tuf-journal` | 30467324 | `d6f22b046339659eb6b6d176cf01486158fa15574b9aaa69ddccc3a4600c7eba` |
| `hid-tuf-signing-broker` | 34288881 | `706b30c877cc769370a120b6830c95889844d89658ce184eb5b60b7c876c77d6` |

These remain uncommitted-worktree tooling hashes, not an admitted release or
approved tooling archive. The correction needs separate commit authorization
and protected CI verification. The original pre-correction hashes are preserved
in Git at `46e76cecf9e846061203c8fd68a0fcfd0c2825a5`; they must not be used
for execution.

### Historical Phase A/B Go 1.25.0 hashes — no release authorization

The preceding hashes are preserved as historical comparison evidence only:

| Command | SHA-256 (both builds) |
| --- | --- |
| `hid-tuf` | `7978eacbec01af07a7d01c665c58f8cf211804f840f309d860f6dd3eadb99419` |
| `hid-tuf-repo` | `48f28f7a7566a177380e7700db35174291f55af219e8a1ac0691c5c620f74bc0` |
| `hid-tuf-publication` | `8d28594ab39c527c5b38a33213c468e55e0ffdfa113505b03494c654f19bfb4e` |
| `hid-tuf-journal` | `4754438bd357717a623ce0272b16b32e3dadb3095ba74904ce4dc08b943ed1b2` |
| `hid-tuf-signing-broker` | `65ae9412d5ac27b73572153a0644cea83b77504c5b704a2026e41a3f8ed21a14` |

## BLOCKED

- Separate authorization for the retention-correction commit and any push/CI
  execution; the original local-only commit authorization has been consumed.
- Actual branch/ruleset/status-check/CODEOWNERS and environment protections,
  exact protected caller ref, reviewer identities and environment variables.
- Concrete independently governed candidate generation, signer/evidence/auditor
  capability workflows, canary execution and immutable caller arrangement. The
  publisher and IAM contracts do not themselves supply those missing executors;
  the custody/administration separation decision materially affects security.
- Exact AWS account/region/resource/role/KMS and Cloudflare account/zone pins,
  existing credential ARN/version references, public root/SPKI custody evidence,
  immutable candidate images/archives/metadata and reviewed tooling/config hashes.
- A concrete account-specific infrastructure diff and explicit Object Lock/key
  authorization: COMPLIANCE 90-day defaults plus **730-day journal/evidence**
  retention have no approval. No irreversible mutation has been requested.
- Explicit staging publication/application/migration execution authority and
  authorized source inventory/dataset; live restore, rollback, monitoring and
  acceptance proof. Production planning/action remains locked until acceptance
  and a new explicit production boundary.

No private key or credential value should be supplied in chat, Git, logs or
artifacts. The non-secret template lists required references only.

## NEXT

Local retention validation is complete. Review the recorded changed scope and
obtain separate authorization before any new commit. Once the correction is independently reviewed/committed under new
authorization, the next external package is separate push authorization naming
the exact source SHA, `origin` repository and destination branch, followed by
owner-installed GitHub branch/ruleset/CODEOWNERS/status-check/environment
protections and protected CI readiness. No push or CI is performed automatically.
The original commit with superseded retention must not be used for execution.

Follow [the complete 23-step execution package](TUF-STAGING-EXECUTION.md).
The sequence places infrastructure readiness before protected publication,
then application deployment/tests, migration/integrity/restore/rollback and
binary acceptance. Production preparation starts only after staging acceptance;
production infrastructure/publication/migration/deployment/cutover require new
explicit authorization.

## VERIFICATION

### Gate ledger

| Gate | State | Evidence |
| --- | --- | --- |
| Clean baseline and branch isolation | PASS | clean `abc77af...` baseline; `tuf-production-release` created |
| Repository/release-surface audit | PASS | findings above; no external mutation |
| Pinned example-client hash/identity | PASS | exact hashes and binary identity above |
| Trust architecture reviewed | PASS | ADR-035 and Milestone 2 contracts above |
| Local TUF implementation | PASS (LOCAL ONLY) | client, batch, KMS adapter, threshold construction, state-authorized recovery materialization, fixed AWS broker, immutable signing/publication journals, archive/evidence adapters, and serialized protected publication driver are implemented |
| Adversarial TUF test suite | PASS (LOCAL ONLY) | all 13 Go packages pass race-enabled tests plus vet/module verification; expiry, rollback, clock, replay, high-water, chain tamper/truncation, ambiguous commit, stale attempt, historical workflow, authorization and external-boundary cases are covered |
| Strict release schemas/config | PASS | `npm --prefix release run verify`; four schemas compile under AJV strict Draft 2020-12 and 28 migration hashes match |
| Context-bound release admission | PASS | `npm --prefix release test`: 24/24 adversarial/admission/workflow tests; exact environment/account/region/release/Git/admission binding, target rechecks, deterministic plan and protected-workflow attacks |
| Production promotion evidence validator | PASS (LOCAL ONLY) | six evidence types, mandatory checks, exact subject/artifact binding, chronology, and approval validity tested; no live gate evidence exists |
| AWS release-trust IaC | PASS (SOURCE/LOCAL ONLY) | corrected retention typecheck and 58/58 tests; exact immutable OIDC identities, fixed five-function broker, separate publisher secret version, conditional publication journal/storage policy and no publisher signing/checkpoint writes; stack not instantiated |
| EHR release cache generation | PASS (LOCAL ONLY) | `npm --prefix apps/ehr test`: 5/5; TypeScript/build/platform verification; exact-SHA generated worker with complete shell; no deployment |
| KMS freshness signer | PARTIAL PASS (LOCAL ONLY) | low-level pinned ARN/SPKI/P-256 adapter and independently stateful broker pass normal/race tests; completed and superseded outputs replay from reachable immutable journal evidence without re-signing; online versions advance from durable high-water with a 30-minute commit margin; live AWS proof remains; no AWS call or key creation |
| Focused npm dependency audits | PASS | `npm audit --audit-level=moderate` reports zero vulnerabilities for release, AWS, Cloudflare, and EHR lockfiles; all focused tests/builds pass |
| Cloudflare TUF repository/publication source | PASS (LOCAL ONLY) | 52/52 tests; direct bootstrap is journal-gated and the real wrapper integration covers parent/upload/preview/100%-deploy/route/confirm plus lost responses; no Cloudflare API call |
| Publication coordination and durability | PASS (LOCAL ONLY) | fixed-slot Object-Locked S3 chain plus strongly consistent DynamoDB CAS head; exact byte/checksum/KMS/original-retention readback; strict CLI and wrapper integration; no reset/steal/resume or ambiguous retry path |
| Whole-workspace checks | PASS (LOCAL ONLY) | final root build, test and verify/synth/policy suites pass after Phase A/B integration; no external acceptance inferred |
| Credential-free TUF CI definition | PASS (SOURCE ONLY) | seven isolated read-only jobs; actionlint/YAML/local command validation; allowlisted evidence upload, no cloud credentials or deployment |
| Protected publication workflow | PASS (SOURCE/LOCAL ONLY) | reusable-only two-job workflow, exact action/workflow pins, protected staging/production environments, live GitHub identity-rule execution tests, independently approved tooling/config hashes, OIDC only in publisher, retained references; no live run |
| Historical reference toolchain manifest | PASS (REFERENCE ONLY) | `node tools/tuf-release/scripts/verify-toolchain.mjs --require-installed`; official Go distribution/binary and reference-client pins checked |
| Five-command reproducibility | PASS (LOCAL ONLY) | paired isolated Linux/amd64 builds were byte-identical; exact hashes are recorded in CURRENT |
| Clean-checkout full verification | BLOCKED | original reviewed scope is committed, but retention correction is not; no GitHub workflow was invoked |
| Staging repository deployment | BLOCKED | credentials/account/key setup not supplied |
| Staging application deployment | BLOCKED | TUF staging gate must pass first |
| Synthetic migration and restore | PASS (LOCAL ONLY) | final actual PostgreSQL rehearsal and 328-FK integrity/restore checks; external source/schema and staging HTTP validation remain unavailable |
| Staging-copy migration test | BLOCKED | restored/sanitized source copy unavailable |
| Backup/archive restore drill | BLOCKED | staging infrastructure not deployed |
| Forward-version rollback drill | BLOCKED | staging repository not deployed |
| Monitoring/alert delivery proof | BLOCKED | staging infrastructure not deployed |
| Production key ceremony | BLOCKED | explicit custody decision and approval required |
| Production deployment | FORBIDDEN | every mandatory predecessor remains incomplete |

## STAGING

Not deployed or authorized. Local release/security source gates pass; staging
publication now needs the exact reviewed commit/configuration, protected
environment approval, irreversible storage/key approval, and scoped
AWS/Cloudflare access.
Infrastructure readiness precedes repository publication and application deployment,
smoke/integration/security validation and full staging acceptance. No local
mock, synth, build or test is staging evidence.

## DATA MIGRATION

Local synthetic schema/import/retry/restore and denial checks pass; see
[TUF-STAGING-MIGRATION.md](TUF-STAGING-MIGRATION.md) for exact evidence and limits.
Hard live gate: source inventory, ordered/idempotent schema and data migrations,
sanitized staging copy or approved representative dataset, migration rehearsal,
row/entity counts and critical invariants, application compatibility,
backup/restore and rollback proof, measured RTO/RPO and explicit migration
acceptance evidence are still required. Local migration-ledger checks do not
prove migration of a staging copy or production data. No source dataset or
production database has been accessed or changed.

## CUTOVER

Not planned for execution or authorized. Required order after full staging
acceptance: production migration preparation, reviewed cutover plan, explicit
production approval, separately authorized production migration, production
deployment, post-cutover verification, monitoring/hypercare and final acceptance.
Do not infer any of these approvals from this implementation request.

## PRODUCTION

Production status: **NOT READY; NOT AUTHORIZED; NOT DEPLOYED**.

No production metadata, repository, bucket, key, signature, release, database,
application, DNS record, or credential has been created or changed. Local
implementation and tests will not change this status. Production can be
considered only after successful staging deployment and validation, migration
dry-run and staging-copy testing, validated backup/archive restore and
forward-version rollback, working monitoring/alerts, approved production key
custody, and explicit authorization for the production action.
