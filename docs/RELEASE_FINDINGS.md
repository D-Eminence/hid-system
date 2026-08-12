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
