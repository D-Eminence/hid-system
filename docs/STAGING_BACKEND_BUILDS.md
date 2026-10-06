# Automated staging backend builds

`Staging backend images` checks PRs and builds affected backend components.
Pushes to `staging-novu-ci-20261005` or `staging` also publish passing images to
existing staging ECR repositories using short-lived GitHub OIDC credentials.
Frontend-only changes do not run this pipeline. The current frontend release is
retained while the developer finishes its changes.

The pipeline installs service lockfiles, runs tests/type checks, builds ARM64,
generates an SPDX SBOM and rejects High/Critical Grype findings. Image transfer
between jobs is checked against hashes, source SHA and Docker configuration.
Immutable ECR tags contain source SHA, Actions run ID/attempt and Docker target.
Each `staging-digest-*` artifact includes `publication.json`, SBOM and scan result.
Terraform deployment uses the recorded `image_uri` digest as a separate step.
Other images and frontend archives keep their own original source provenance.

No runtime API keys, database passwords or production permissions are used by CI.
The AWS role trusts exact immutable repository/owner IDs and staging branches.
The owner should protect the staging branch against unreviewed changes. Existing
TUF production workflows are unchanged; CDK is not a gate for this pipeline.

To retry one component after the workflow is on the default branch, use Actions
→ Staging backend images → Run workflow, select the staging branch and component.
Until then, a push to the dedicated staging branch starts the workflow.

## Novu update

Developer fix `879ed55` provisions/updates the patient's Novu subscriber from
their current verified account email before triggering generic notification text.
The restricted worker uses `integration.notification_recipient_for_claim` rather
than reading identity/auth tables directly. Apply additive migration 0063 and
the reviewed runtime grants before deploying this worker. Existing migration
checksums remain unchanged. `test-notification-recipient.mjs` exercises real
restricted PostgreSQL logins using synthetic data in a disposable container.

## First live build and scan results (2026-10-05)

The workflow runs on the dedicated staging branch. All thirteen component test,
typecheck and ARM64 build jobs passed those steps in run `37294730067`; final
OS-inclusive Syft/Grype scans blocked publication. The repository's action
allowlist rejected Anchore actions, so official scanner binaries are installed
using pinned release SHA-256 values. Failed scan artifacts retain the exact SPDX
SBOM and full Grype report; package findings also appear in the job log.

The original Node 22 distroless base had outdated OpenSSL and glibc libraries.
The pinned base is now updated within the same Node 22/Debian 13 image family to
`sha256:55e7cd155c86d8956af63fec0a9d0790dd6d0ba98c7d38e63c0866557ee7aff8`.
Scanning that exact ARM64 base removed all Critical findings and the High findings
with available Debian fixes. Five unique High advisory IDs remain (eleven package
matches), with no packaged fix reported:

| Advisory | Package(s) | Current scan result |
|---|---|---|
| CVE-2026-85091 | zlib1g | not-fixed; upstream affected-version range needs assessment |
| CVE-2026-5435 | libc6 | wont-fix; Debian calls this a minor deprecated-function issue |
| CVE-2026-19499 | libc6 | wont-fix; Debian calls this a minor formatting-function issue |
| CVE-2026-95619 | GCC runtime packages including libstdc++6 | not-fixed |
| CVE-2026-102010 | GCC runtime packages including libstdc++6 | not-fixed |

Sources: [zlib](https://security-tracker.debian.org/tracker/CVE-2026-85091),
[glibc deprecated functions](https://security-tracker.debian.org/tracker/CVE-2026-5435),
[glibc formatting](https://security-tracker.debian.org/tracker/CVE-2026-19499),
[GCC allocation](https://security-tracker.debian.org/tracker/CVE-2026-95619),
[GCC queue](https://security-tracker.debian.org/tracker/CVE-2026-102010).
These are scanner findings, not a claim that each is exploitable through HID.
No blanket ignore, severity downgrade or security exception is applied.

The scoped Novu update now has an exact-image not-affected assessment in
`security/STAGING_NOVU_RUNTIME_ASSESSMENT.md`. Its expiring OpenVEX is generated
only after native-binary/package checks, and is rechecked before publication.
Both raw and assessed findings are retained. `component=novu-update` builds and
publishes only the worker and migration images; no frontend is rebuilt.
Publication remains blocked until supported patches or evidence-backed affectedness
decisions resolve the actual findings. Gateway findings remain in its separate
scan artifact; its Nginx/base image is unchanged by this scoped Novu update.
