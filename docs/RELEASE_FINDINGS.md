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
| Change | Keep `node:22-bookworm-slim` only in build and production-dependency stages. All Node service final stages and EHR's separate migration target now use the pinned `gcr.io/distroless/nodejs22-debian13` runtime (first pinned at `@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167`; see the runtime pin update below), with only compiled output and production dependencies copied in. |
| Representative verification | Identity and EHR images built locally, loaded their native modules, reached ready/healthy state as UID/GID 65532, handled SIGTERM, generated SPDX SBOMs, and produced zero-result Docker Scout SARIF reports. |
| Full-matrix verification | All ten Node services plus EHR `migration` rebuilt on the accepted Distroless runtime with zero Scout vulnerabilities. Gateway was independently moved to the pinned maintained unprivileged Nginx digest and reports 0 critical/0 high findings. All twelve SPDX SBOMs, checksum verification, non-root checks, final-filesystem secret scans, and runtime topology checks passed locally. Notification API container startup and disabled Notification Worker SIGTERM defects exposed by runtime acceptance were corrected and retested. |
| Runtime pin update | 2026-10-16: all ten Node service Dockerfiles (including EHR's `migration` target) and the pins in `scripts/verify-container-platform.mjs` and `scripts/verify-platform-graph.mjs` moved to `gcr.io/distroless/nodejs22-debian13@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c`, which is the current `nonroot` tag of that repository and the same variant as the first pin. The registry serves it as an OCI image index whose manifests include linux/amd64 (`sha256:7b0a2b9262b3d1d57e139e08fe11bccb0a7d426ca515eab0cd6abcaf2016ae5c`) and linux/arm64/v8 (`sha256:a3441d0ffa9b8d44c461cc7d708f83bfc112cda3464caf562638a4ea04e3daae`). Both image configs have User `65532`, WorkingDir `/home/nonroot` and the `/nodejs/bin/node` entrypoint, as the first pin's configs do. The bundled runtime moves from Node 22.23.2 to 22.23.3, read from the release URL embedded in `/nodejs/bin/node`. CI still installs Node 22.23.2 (`NODE_VERSION` in `.github/workflows/tuf-local-gates.yml`). An earlier draft of this update pinned `@sha256:55e7cd155c86d8956af63fec0a9d0790dd6d0ba98c7d38e63c0866557ee7aff8`, the `latest` tag of the same build. Its layers are identical, but its configs default to User `0` and WorkingDir `/`, so a stage that dropped its `USER` line would have run as root. Every stage sets `USER 65532:65532`. `verify-container-platform` now requires that as the last `USER` of every runtime stage and of EHR's `migration` stage, whose ECS task definition sets no user. The scans recorded above were taken on the first digest, so every Node image must be rebuilt and rescanned on this digest before release. |
| Required closure | Commit the verified tree, rebuild and rescan all twelve governed targets and seven frontend artifacts from that exact clean SHA, and preserve the resulting local evidence. External ECR/Inspector/deployment evidence remains separately required. |
| Status | **REMEDIATED LOCALLY — PREDECESSOR CANDIDATE PERMANENTLY BLOCKED; EXTERNAL RELEASE EVIDENCE PENDING** |

## Finding RF-005: AWS CDK bundled dependency audit

| Field | Record |
|---|---|
| Review date | 2026-10-01, PR #5 worktree only. |
| Current issue | `infra/aws` pins `aws-cdk-lib@2.267.0`. Its bundled `brace-expansion@5.0.9` is within npm's affected range; `npm audit --audit-level=high` reports one high-severity vulnerability. |
| Compatible-version check | The latest published `aws-cdk-lib@2.272.0` supports this repository's Node range but its package tarball still bundles `brace-expansion@5.0.9`. Upgrading only to that release would leave the high-severity finding open. |
| Decision | Keep the AWS dependency audit gate enabled. Do not add an override, ignore, or suppression for a bundled dependency. Recheck a future official CDK release and run the AWS tests and synthesis before changing the pin. |
| Resolution (2026-10-08) | `aws-cdk-lib@2.273.0` (published 2026-10-08) is the first official release whose package tarball bundles `brace-expansion@5.0.12`; 2.268.0 through 2.272.0 still bundle 5.0.9. The pin moved to 2.273.0. Its assembly requires CDK CLI 2.1144.0, so `aws-cdk` moved from 2.1135.1 to 2.1144.0. `npm audit --audit-level=moderate` reports 0 vulnerabilities; typecheck and all 98 AWS tests pass. Development, staging (fidelity) and production synthesis change only in two ways: the stack tags now propagate to `AWS::ApplicationAutoScaling::ScalableTarget` resources, and the CDK analytics metadata changed. No resources are added or removed, and no override or suppression was added. |
| Status | **RESOLVED IN SOURCE — not deployed** |

RF-005 is separate from the earlier final-image finding and from the moderate
React Router findings in RF-003. No production infrastructure was changed by
this dependency review.

## Finding RF-006: Historical sandbox fixture data in PR #5

| Field | Record |
|---|---|
| Review date | 2026-10-01, PR #5 worktree. |
| Current tree | Sandbox-derived demographic and contact fixture values found during review were replaced with invented test values. A tracked-tree scan found no remaining exact matches to the supplied sandbox identity details; the secret-readiness check also passed. |
| Historical limit | Earlier pushed PR commits still contain the former fixture values. A forward commit cannot remove them from Git history, and this workstream forbids rewriting history. No live value is repeated in this finding. |
| Release treatment | Keep PR #5 draft and unmerged. Security review must decide how to remediate the historical exposure before merge or production activation. |
| Status | **OPEN — HISTORY REMEDIATION PENDING** |

## Finding RF-007: backend lockfile advisories

| Field | Record |
|---|---|
| Review date | 2026-10-16, against `origin/main` `f9dbaf0`. |
| Original issue | `npm audit --package-lock-only` reported high or critical advisories in all ten backend service lockfiles: Multer and `@nestjs/platform-express` (through Multer), fast-uri, js-yaml, brace-expansion, Handlebars (critical, through `ts-jest`) and proxy-addr (critical, through Express). qs was moderate. |
| Decision | Remediate inside the existing dependency ranges. No `package.json` range, override, forced major update, ignore or suppression. |
| Change | Each lockfile was regenerated by npm: `npm audit fix --package-lock-only --ignore-scripts`, and for Identity API only `npm update proxy-addr handlebars --package-lock-only`, because `audit fix` there also moved the whole Jest toolchain. Resulting versions where present: `@nestjs/platform-express` 11.2.7, Multer 2.4.0 (drops `concat-stream` and `typedarray`), fast-uri 3.1.8, js-yaml 3.15.2 and 4.3.2, brace-expansion 1.1.21, 2.1.7 and 5.0.12, Handlebars 4.7.10, proxy-addr 2.0.8 and qs 6.16.0. The EHR, Lab, OCR, Outreach and Pharmacy lockfiles were regenerated again from `f9dbaf0` with `--before=2026-10-07`. Without that date, npm resolved qs to 6.16.1, which was published 2026-10-14T22:06Z, about 38 hours before the change. qs 6.16.0 (published 2026-08-29) already fixes both qs advisories in main's lockfiles, GHSA-x5fp-wj9c-mxmx (`<=6.15.3`) and GHSA-4mjr-xmp4-gh2g (`<6.16.0`), and Identity API and Notification API already use it. The date limit changed only the qs entry. Every other fixed version was published by 2026-10-05. |
| Verification | High/critical before and after: EHR, Lab, OCR, Outreach and Pharmacy APIs 5/2 to 0/0; Notification API 3/2 to 0/0; Event Dispatcher, Notification Worker and OCR Worker 2/1 to 0/0; Identity API 0/2 to 0/0. In a clean copy of each service, `npm ci`, `npm ls --all`, typecheck, lint, build and the unit suites pass. |
| Residual risk | Every service still reports one moderate advisory, sprintf-js GHSA-hp3w-g68c-fv3c (`<=1.1.3`, no patched release), reached through `argparse` and js-yaml 3 in the Jest/Istanbul development toolchain. npm attributes it to 20 development packages per service. No production dependency is affected. Image regeneration and scanning are still required before release; a package audit does not replace an image scan. |
| Status | **RESOLVED IN SOURCE — image evidence pending** |

## Finding RF-008: Gateway PCRE2 in the pinned Nginx base

| Field | Record |
|---|---|
| Review date | 2026-10-16, against `origin/main` `f9dbaf0`. |
| Original issue | The pinned `nginxinc/nginx-unprivileged@sha256:334d92979f15aaecd5dd50af5105e1230e2bb70765d45b1e2f964e7c5eda81c3` (Nginx 1.31.3, Alpine 3.24.1) ships `pcre2` 10.47-r1 in both its linux/amd64 and linux/arm64 images, read from `/lib/apk/db/installed` in the image layers. Nginx links `libpcre2-8.so.0`. Alpine's 3.24 security database lists CVE-2026-86145, CVE-2026-89156, CVE-2026-89157, CVE-2026-89158, CVE-2026-89160, CVE-2026-89161 and CVE-2026-89162 as fixed in 10.48-r0, and CVE-2026-103111 in 10.49-r0. |
| Decision | Patch the one library in the final stage. Keep the Nginx base digest, version, user, health probe, routing and shutdown contract. No broad upgrade, untrusted repository, severity exception or scanner suppression. |
| Change | `gateway/Dockerfile` switches to `USER 0` only for `apk add --no-cache 'pcre2=10.49-r0'` and still ends as `USER 101`. The Alpine v3.24 main `APKINDEX` (x86_64 and aarch64) lists `pcre2` 10.49-r0 as its only version, providing the same `libpcre2-8.so.0` soname. `scripts/verify-container-platform.mjs` requires that exact single `RUN`, rejects `apk upgrade`, untrusted or extra repositories, and requires the last `USER` to be 101. |
| Residual risk | Alpine removes superseded revisions, so the build fails once 10.49-r0 is replaced. That is the intended fail-closed result: move the pin, or move to a newer Nginx base digest that already ships a fixed `pcre2`, and drop the `RUN` line then. `npm run verify:gateway-runtime:image` runs the bare pinned base, not the built gateway image, so it does not exercise this patch. |
| Required closure | Build the gateway for linux/arm64 through the governed path, confirm `apk info -v pcre2` reports 10.49-r0, and attach a final-image scan with zero critical/high findings. No Docker daemon was available for this change. |
| Status | **PATCHED IN SOURCE — image build and scan pending** |
