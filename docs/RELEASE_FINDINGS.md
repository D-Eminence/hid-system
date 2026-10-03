# HID Release Dependency Findings

Review date: 2026-08-11. Scope: active Web, Lab, and Outreach packages. This record closes the release findings carried from `PLATFORM_CONTAINER_ACCEPTANCE.md`; it is not a claim about an image scanner or AWS Inspector.

## Finding RF-001: Web SheetJS runtime parser

| Field | Record |
|---|---|
| Original issue | `apps/web` depended on `xlsx@0.18.5`, for which npm reported high-severity advisories with no supported patched release on that line. |
| Reachability | The parser read one immutable bundled facilities workbook. It did not parse a user upload. Reachability was bounded, but the vulnerable parser still shipped in the browser bundle. |
| Impact | A compromised or incorrectly replaced release asset could reach parser code; retaining an unpatched parser also prevented a clean high/critical release gate. |
| Decision | Remediate; no production exception. |
| Change | The 26,357 trusted facility rows were converted once to a static JSON asset. `FacilityPicker` now fetches JSON, validates every row's three string fields, and filters blank names. `xlsx` was removed from source, manifest, lock, installed tree, and production bundle. The source workbook moved to `apps/web/data/` and is no longer published by Vite. |
| Provenance | Source workbook SHA-256 `246e7a0786464ef0c85814095172ae83f559211598e12c02315bb99761355e21`; generated JSON SHA-256 `bd8c3dbd1b74e213363a437aaca86dafc71ed2e6a8a76639b264dde98a2a4a9d`; exact row count `26357`. |
| Verification | Web lock contains zero `xlsx` entries; Web build and the root frontend/container verification must pass. A fresh `npm audit --audit-level=high` no longer reports SheetJS. |
| Residual risk | The generated directory is a release asset and must remain checksum-reviewed when regenerated. It contains facility directory data, not patient or clinical data. |
| Status | **RESOLVED** |

## Finding RF-002: Lab and Outreach lock attribution

| Field | Record |
|---|---|
| Original issue | Both app lockfiles contained 206 `../web/node_modules/*` package entries inherited from a dirty linked-package graph. Audit output attributed Web dependencies and advisories to apps that did not depend on them. |
| Impact | False ownership obscured each deployable app's real dependency and vulnerability surface; a release reviewer could neither approve nor reject the correct component. |
| Decision | Regenerate from a clean graph; no exception. |
| Change | Each lockfile was regenerated in an isolated repository-shaped temporary tree containing only package manifests and no sibling `node_modules`, then copied back unchanged by hand editing. |
| Verification | Lab now has 62 lock package entries, zero Web-attributed paths, and zero npm advisories. Outreach has 65 entries and zero Web-attributed paths. |
| Residual risk | Local `file:` dependencies can reproduce bad attribution if a lock is refreshed against a dirty linked tree. Future lock updates must use a clean checkout or clean package graph. |
| Status | **RESOLVED** |

## Finding RF-003: React Router 6 advisories

| Field | Record |
|---|---|
| Current issue | Web and Outreach each report two moderate React Router advisories. npm's current remediation crosses a major-version boundary. |
| Reachability | HID uses client-side routing, not React Router's server-side hydration/deserialization. Navigation targets are application-defined, but backslash/open-redirect behavior still requires regression coverage during upgrade. |
| Decision | Record as a moderate residual dependency risk; do not force a blind major upgrade in the AWS foundation change. |
| Release treatment | This is not a high/critical blocker under `RELEASE_ARTIFACT_GATE.md`, but the release manifest must link a tracked disposition until a tested Router major upgrade closes it. No exception may be used to ignore a future severity escalation. |
| Required follow-up | Upgrade Web and Outreach together with auth redirect, nested base-path, direct-refresh, and service-worker regression tests. |
| Status | **OPEN — MODERATE, FORMALLY DISPOSITIONED** |

## Verified audit result

After remediation:

| Package | High | Critical | Moderate | Attribution |
|---|---:|---:|---:|---|
| Web | 0 | 0 | 2 | exact |
| Lab | 0 | 0 | 0 | exact |
| Outreach | 0 | 0 | 2 | exact |

This table records npm package audit evidence only. Container operating-system packages, base-image findings, and final-layer evidence remain unavailable until a Docker-capable release host executes the artifact gate.

## Finding RF-004: Node Bookworm-slim final-image critical/high findings

| Field | Record |
|---|---|
| Affected candidate | Local candidate source `df4f41328375c9a2235c2e6d48dd482ff6f432af` on `staging-readiness`; the source and branch are preserved unchanged. |
| Scanner evidence | Docker Scout 1.24.0 SARIF for the local Identity and EHR final images reported 3 critical and 9 high findings in each image. No waiver or approved exception exists. |
| Exact provenance | SARIF locations place `brace-expansion`, `picomatch`, `sigstore`, `ip-address`, and `tar` under `/usr/local/lib/node_modules/npm/node_modules/` in the Node base image. Debian CVE locations point to `/usr/share/doc/perl-base/copyright`. The scanner did not locate these critical/high findings in HID application dependency trees. |
| Findings | Critical: CVE-2026-12087, CVE-2026-13221 (unfixed Debian Perl), and CVE-2026-59873 (`tar`, fixed in 7.5.19). High: CVE-2026-48962 and CVE-2026-48959 (unfixed Debian Perl); CVE-2026-14257, CVE-2026-69152, and CVE-2026-13149 (`brace-expansion`); CVE-2026-33671 (`picomatch`); CVE-2026-48815 (`sigstore`); CVE-2026-69192 (`ip-address`); and CVE-2026-59874 (`tar`). |
| Decision | Block the candidate and remediate the final-image boundary. Do not use a severity exception, suppress the scanner, or promote the candidate. |
| Change | Keep `node:22-bookworm-slim` only in build and production-dependency stages. All Node service final stages and EHR's separate migration target now use the pinned `gcr.io/distroless/nodejs22-debian13@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167` runtime, with only compiled output and production dependencies copied in. |
| Representative verification | Identity and EHR images built locally, loaded their native modules, reached ready/healthy state as UID/GID 65532, handled SIGTERM, generated SPDX SBOMs, and produced zero-result Docker Scout SARIF reports. |
| Full-matrix verification | All ten Node services plus EHR `migration` rebuilt on the accepted Distroless runtime with zero Scout vulnerabilities. Gateway was independently moved to the pinned maintained unprivileged Nginx digest and reports 0 critical/0 high findings. All twelve SPDX SBOMs, checksum verification, non-root checks, final-filesystem secret scans, and runtime topology checks passed locally. Notification API container startup and disabled Notification Worker SIGTERM defects exposed by runtime acceptance were corrected and retested. |
| Required closure | Commit the verified tree, rebuild and rescan all twelve governed targets and seven frontend artifacts from that exact clean SHA, and preserve the resulting local evidence. External ECR/Inspector/deployment evidence remains separately required. |
| Status | **REMEDIATED LOCALLY — PREDECESSOR CANDIDATE PERMANENTLY BLOCKED; EXTERNAL RELEASE EVIDENCE PENDING** |

## Finding RF-005: AWS CDK bundled dependency audit

Release preparation recheck (2026-10-04): the official npm registry still
reports 2.272.0 as latest. The locked audit reports one high vulnerable package,
with two high recursion advisories and one moderate advisory affecting the
bundled version. The high advisories are
[GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7)
and [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p).
No patched official CDK bundle is available from this check. The installed pin,
audit gate and open status are preserved; a dependency override is not applied.

Integration observation (2026-10-03): the locked `infra/aws` audit still
reports one high finding. A fresh registry check and inspection of the official
2.272.0 tarball confirm that it still bundles `brace-expansion@5.0.9`.
The staging integration has not added an override, suppression or release
exception. This finding remains open.

| Field | Record |
|---|---|
| Review date | 2026-10-01, PR #5 worktree only. |
| Current issue | `infra/aws` pins `aws-cdk-lib@2.267.0`. Its bundled `brace-expansion@5.0.9` is within npm's affected range; `npm audit --audit-level=high` reports one high-severity vulnerability. |
| Compatible-version check | The latest published `aws-cdk-lib@2.272.0` supports this repository's Node range but its package tarball still bundles `brace-expansion@5.0.9`. Upgrading only to that release would leave the high-severity finding open. |
| Decision | Keep the AWS dependency audit gate enabled. Do not add an override, ignore, or suppression for a bundled dependency. Recheck a future official CDK release and run the AWS tests and synthesis before changing the pin. |
| Status | **OPEN — HIGH, AWS RELEASE GATE BLOCKED** |

RF-005 is separate from the earlier final-image finding and from the moderate
React Router findings in RF-003. No production infrastructure was changed by
this dependency review.

## Finding RF-006: Historical sandbox fixture data in PR #5

Integration observation (2026-10-02): baseline
`c4b5445ed589217bb8b4529d69e268ca56842609` is already the PR #5 merge.
The draft/unmerged instruction below describes the earlier review and cannot
describe the current branch state. Owner/security disposition for the historical
exposure is still required before release. No history was rewritten and no
exposed value is repeated here. This observation does not close the finding.

| Field | Record |
|---|---|
| Review date | 2026-10-01, PR #5 worktree. |
| Current tree | Sandbox-derived demographic and contact fixture values found during review were replaced with invented test values. A tracked-tree scan found no remaining exact matches to the supplied sandbox identity details; the secret-readiness check also passed. |
| Historical limit | Earlier pushed PR commits still contain the former fixture values. A forward commit cannot remove them from Git history, and this workstream forbids rewriting history. No live value is repeated in this finding. |
| Release treatment | Keep PR #5 draft and unmerged. Security review must decide how to remediate the historical exposure before merge or production activation. |
| Status | **OPEN — HISTORY REMEDIATION PENDING** |
