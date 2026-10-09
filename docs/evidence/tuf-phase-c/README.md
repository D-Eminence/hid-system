# Phase C local evidence and commit proposal

Decision: **NOT READY FOR PROTECTED STAGING EXECUTION; STAGING NOT ACCEPTED**.
Production remains locked. The reviewed 193-file scope was committed locally as
`46e76cecf9e846061203c8fd68a0fcfd0c2825a5` at `2026-09-07T04:11:04+01:00`,
with parent `abc77af52f1c09831e1fcdb9c3ba1aaafd0f60b0`. No push or external
mutation occurred. The subsequent **730-day (2-year)** retention correction and
canonical commit records remain uncommitted and require new commit authorization.

`files.json` and the original verification/migration/GitHub records remain the
reviewed historical snapshot. Their exact committed bytes are available at the
SHA above; later correction files do not silently inherit that verification.
Updated source-model plans and corrected build/test evidence are identified in
[retention-correction.json](retention-correction.json). The original retention
proposal must not be implemented. Object Lock remains **UNAPPROVED / NOT CREATED**.

## Reviewed commit — created locally

Commit message: `Implement TUF release trust and prepare protected staging gates`

The single logical commit includes the Phase A/B TUF verifier,
threshold metadata construction, pinned AWS broker, immutable publication
journal/recovery/evidence, protected publication workflow, Cloudflare gates,
release-bound EHR service worker, required dependency updates, Admin test
cleanup, and Phase C source/CI identity hardening, patched build profile,
identifier/infrastructure planning, migration fixes/rehearsal and evidence.

[files.json](files.json) lists every proposed path, byte size and SHA-256, plus
the one exclusion. The pre-existing `docs/SECURITY.md` edit removes current
security text and inserts an old task prompt; it remains untouched and must
not enter this commit. The inventory does not hash itself; preserve its final
hash independently with the review decision. No generated binary, database
backup, operational journal request, private key or credential belongs in Git.

For any separately authorized correction commit, review the new correction
scope; the original inventory is historical. Compare actual files to the
newly approved inventory and stage
only its proposed paths, inspect the complete cached diff and secret/artifact
exclusions, and run `git diff --cached --check`. Record the resulting SHA.
Commit authorization does not imply push or workflow dispatch authorization;
verify the exact remote SHA after a separately authorized push.

Expected trust boundary: immutable source can be independently reviewed and
reproduced by credential-free CI. It does not itself confer cloud authority or
prove the absent protected environments, candidate/signing/canary execution,
key custody, publication, migration or staging acceptance.

## Verification records

Original full-workspace records below are the committed pre-correction evidence.
The current 730-day correction passed 58 AWS tests/typecheck, Go normal/race/
vet/modules, 24 release tests, configuration/security checks, offline plans and
all five paired builds. `offline-plans.json` and `reproducibility.json` now record
that corrected uncommitted state; the originals remain available in Git.
The changed scope and exact current results are in `retention-correction.json`.

| Record | Evidence and scope |
| --- | --- |
| [verification.json](verification.json) | Exact command records, timestamps, exit codes and SHA-256 of retained private logs; dirty local worktree only |
| [reproducibility.json](reproducibility.json) | Five Go 1.26.8 Linux/amd64 binaries, sizes, SHA-256 and identical A/B bytes from separate caches |
| [go-vulnerabilities.json](go-vulnerabilities.json) | Pinned govulncheck v1.1.4, database timestamp and zero reachable symbol findings for Go 1.26.8 |
| [historical-go-vulnerabilities.json](historical-go-vulnerabilities.json) | Expected rejection of Go 1.25.0: 73 reachable symbol findings across 30 advisories; historical reference only |
| [migration.json](migration.json) | Actual PostgreSQL 16.15 synthetic schema/import/retry/integrity/backup/restore and negative cases; no live staging HTTP validation |
| [migration-regression.json](migration-regression.json) | Inactive-membership failure reproduced before fixing immutable-0027 provenance compatibility |
| [offline-plans.json](offline-plans.json) | Foundation (32 resources) and broker (86 resources) source-model plan hashes/actions using explicitly synthetic identifiers; not an actual AWS account diff |
| [unfilled-plan-denial.json](unfilled-plan-denial.json) | Missing actual identifiers rejected before an output assembly is created |
| [GitHub repository](github/repository.json), [environments](github/environments.json), [workflows](github/workflows.json), [rulesets](github/rulesets.json) | Fresh public-repository readback, unchanged numeric IDs and absent protection/workflow configuration |
| [main protection](github/main-protection.json), [release protection](github/release-protection.json) | Main unprotected and remote release branch absent |
| [Actions policy](github/actions-permissions.json), [token policy](github/workflow-permissions.json), [action pins](github/action-pins.json) | Allowed-actions policy, read-only default token and six resolving immutable action commits |

Passed minimum suite: root `npm run build`, `npm test`, `npm run verify`;
release tests (24/24) and contracts; Go normal/race tests with the independent
Cloudflare validator required, vet and module verification; actionlint 1.7.7;
four scoped npm audits (release/AWS/Cloudflare/EHR, zero vulnerabilities);
symbol-level Go vulnerability audit; paired reproducibility; secret readiness
and whitespace checks. The full workspace tests include 57 AWS and 52
Cloudflare tests. The separate EHR release suite passes 5/5.

Root gates preceded the final inactive-membership script fix. The final real
PostgreSQL rehearsal and `npm --prefix services/ehr-api run migration:verify`
passed after that fix. The ledger was not edited. A release-only dependency
isolation check also passes the three candidate identity tests with no
Cloudflare installation; the repository validator loads only when needed.
Syntax checks cover the new CI collectors and workspace runner. Their full
GitHub execution remains unverified.

One local Dockerfile invocation failed because it omitted mandatory image
arguments. The corrected immutable-image invocation passed; both records are
retained. The historical vulnerable Go scan must fail and is not a waiver.
Local Node is 24.13.1; the committed CI Node 22.23.2 run remains outstanding.

## Reproduction commands

Use the hash-verified Go 1.26.8 distribution in
`tools/tuf-release/toolchain/production-build.json`; put its `bin` directory on
PATH. `HID_TUF_BUILD_GO` can select it for the Node verification scripts.
Installed historical reference checks use their separately governed manifest.

```sh
npm run build
npm test
npm run verify
npm --prefix release test
npm --prefix release run verify
node tools/tuf-release/scripts/verify-production-toolchain.mjs
node release/scripts/go-vulnerability-gate.mjs
HID_REQUIRE_CLOUDFLARE_VALIDATOR=1 GOTOOLCHAIN=local go -C tools/tuf-release test -count=1 ./...
HID_REQUIRE_CLOUDFLARE_VALIDATOR=1 GOTOOLCHAIN=local go -C tools/tuf-release test -count=1 -race ./...
GOTOOLCHAIN=local go -C tools/tuf-release vet ./...
GOTOOLCHAIN=local go -C tools/tuf-release mod verify
actionlint .github/workflows/tuf-local-gates.yml .github/workflows/tuf-publish.yml
npm --prefix release audit --audit-level=moderate
npm --prefix infra/aws audit --audit-level=moderate
npm --prefix infra/cloudflare audit --audit-level=moderate
npm --prefix apps/ehr audit --audit-level=moderate
node tools/tuf-release/scripts/verify-toolchain.mjs --require-installed
node scripts/tuf-staging-migration-rehearsal.mjs --evidence-dir /tmp/NEW_SYNTHETIC_REHEARSAL
npm --prefix services/ehr-api run migration:verify
node scripts/verify-secret-readiness.mjs
git diff --check
```

For paired command builds, use the exact workflow's readonly/trimpath/no-VCS/
empty-build-ID flags, Linux/amd64/v1, CGO disabled, epoch zero, UTC/C locale,
and independent `GOCACHE` and output directories for A/B. Run `cmp` and hash
each result. Dockerfile validation uses both immutable image arguments from
the workflow; missing arguments must fail. Offline synthesis commands and
post-authorization readback are in the infrastructure document.

The earlier temporary starting archive/logs are no longer available after
environment resumption. Their historical recorded hashes are preserved in the
canonical record, without reconstructing purported originals. Current raw
logs and synthetic backups reside in a private persistent local directory;
this public package retains their hashes and bounded summaries. Backups,
raw SQL logs and failed-run dumps are intentionally excluded from this package.

## Execution blockers and next action

The [execution package](../../TUF-STAGING-EXECUTION.md) contains all 23 ordered
steps and binary acceptance criteria. No protected run IDs, signed staging
targets/digests/versions, deployed identifiers or approval receipts exist.
Actual owner protections, the execution/custody arrangement, non-secret
AWS/Cloudflare identifiers, a concrete Object Lock plan/approval and explicit
staging authority remain required. The corrected 730-day journal/evidence
retention requirement does not authorize Object Lock creation. Production planning starts only after staging acceptance.

Retention validation passed; next obtain separate correction-commit
authorization. Push requires its own exact SHA/repository/branch authorization,
then owner-installed GitHub protections and protected CI readiness. No external
step is executed automatically.
